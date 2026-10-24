import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

export type OcrResult = {
  ok: boolean;
  text: string;
  confidence: number;
  validRatio: number;
  engine: string;
  note?: string;
};

type OcrStatus = {
  available: boolean;
  engine: string | null;
  tessdata: string | null;
  note: string;
};

let statusCache: OcrStatus | null = null;

function resourcesPath(): string | null {
  const value = (process as unknown as { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" ? value : null;
}

/** Bundled models first, then the system tessdata. */
function bundledTessdata(): string | null {
  const candidates = [
    process.env.FAHAS_TESSDATA,
    resourcesPath() ? path.join(resourcesPath()!, "tessdata") : null,
    path.join(process.cwd(), "data", "tessdata"),
  ].filter((p): p is string => Boolean(p));

  return candidates.find((dir) => fs.existsSync(path.join(dir, "eng.traineddata"))) ?? null;
}

export async function tesseractStatus(): Promise<OcrStatus> {
  if (statusCache) return statusCache;

  const tessdata = bundledTessdata();
  let engine: string | null = null;
  try {
    const { stdout } = await exec("tesseract", ["--version"], { timeout: 5000 });
    engine = stdout.split("\n")[0]?.trim() ?? "tesseract";
  } catch {
    statusCache = {
      available: false,
      engine: null,
      tessdata,
      note: "Tesseract is not installed. Arch: sudo pacman -S tesseract. Ubuntu/Mint: sudo apt install tesseract-ocr. Windows: install the UB Mannheim Tesseract build.",
    };
    return statusCache;
  }

  statusCache = {
    available: true,
    engine,
    tessdata,
    note: tessdata
      ? "Local OCR ready (bundled English + Arabic models)."
      : "Local OCR ready, using the system language models.",
  };
  return statusCache;
}

function isReadableToken(word: string): boolean {
  const clean = word.replace(/[^\p{L}\p{N}]/gu, "");
  return clean.length >= 2 && /[\p{L}\p{N}]/u.test(clean);
}

function parseTsv(tsv: string): { text: string; confidence: number; validRatio: number } {
  const lines = tsv.split("\n").slice(1);
  const words: string[] = [];
  const confidences: number[] = [];
  let total = 0;
  let valid = 0;

  for (const line of lines) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const word = cols[11]?.trim();
    if (!word) continue;

    total += 1;
    words.push(word);
    if (isReadableToken(word)) {
      valid += 1;
      if (Number.isFinite(conf) && conf >= 0) confidences.push(conf);
    }
  }

  const confidence = confidences.length
    ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
    : 0;
  const validRatio = total ? Math.round((valid / total) * 100) / 100 : 0;

  return { text: words.join(" ").replace(/\s+/g, " ").trim(), confidence, validRatio };
}

async function fetchImage(url: string): Promise<{ file: string; cleanup: () => void }> {
  const res = await fetch(url, {
    headers: { "user-agent": "Fahas/0.1 (local hardware advisor; OCR of a public listing photo)" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status}).`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`Not an image (${type || "unknown type"}).`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > 8 * 1024 * 1024) throw new Error("Image is larger than 8 MB.");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fahas-ocr-"));
  const ext = path.extname(new URL(url).pathname).slice(0, 8) || ".img";
  const file = path.join(dir, `photo${ext}`);
  fs.writeFileSync(file, buffer);

  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function runTsv(
  file: string,
  langs: string,
  tessdata: string | null,
  psm: string,
): Promise<{ text: string; confidence: number; validRatio: number }> {
  const args = [file, "stdout", "-l", langs, ...(tessdata ? ["--tessdata-dir", tessdata] : []), "--psm", psm, "tsv"];
  const { stdout } = await exec("tesseract", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return parseTsv(stdout);
}

export async function ocrImage(url: string): Promise<OcrResult> {
  const status = await tesseractStatus();
  if (!status.available) {
    return { ok: false, text: "", confidence: 0, validRatio: 0, engine: "none", note: status.note };
  }

  const langs = status.tessdata ? "eng+ara" : "eng";

  let image: { file: string; cleanup: () => void } | null = null;
  try {
    image = await fetchImage(url);

    // Product labels are mostly Latin. Try English first; Arabic second. Mixing both
    // models injects garbage into English labels, so run them separately and keep the best.
    const attempts: { text: string; confidence: number; validRatio: number }[] = [];
    for (const lang of ["eng", "ara"]) {
      try {
        const attempt = await runTsv(image.file, lang === "ara" && !status.tessdata ? "eng" : lang, status.tessdata, "11");
        if (attempt.text.length >= 3) attempts.push(attempt);
      } catch {
        /* try the next language */
      }
    }

    const score = (a: { text: string; confidence: number; validRatio: number }) =>
      a.confidence * 2 + a.validRatio * 25 + Math.min(a.text.length, 200);
    attempts.sort((a, b) => score(b) - score(a));
    let parsed = attempts[0];

    if (!parsed || parsed.text.length < 3) {
      // Block-text mode, but still through TSV so the confidence stays real.
      parsed = await runTsv(image.file, langs, status.tessdata, "6");
    }

    if (parsed.text.length < 3) {
      return {
        ok: false,
        text: "",
        confidence: 0,
        validRatio: 0,
        engine: status.engine ?? "tesseract",
        note: "No readable text found in this photo.",
      };
    }

    return {
      ok: true,
      text: parsed.text,
      confidence: parsed.confidence,
      validRatio: parsed.validRatio,
      engine: status.engine ?? "tesseract",
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      confidence: 0,
      validRatio: 0,
      engine: status.engine ?? "tesseract",
      note: err instanceof Error ? err.message : String(err),
    };
  } finally {
    image?.cleanup();
  }
}
