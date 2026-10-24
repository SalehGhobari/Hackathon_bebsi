import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type ListingImage = {
  dataUrl: string;
  contentType: string;
  bytes: number;
  cached: boolean;
};

const memory = new Map<string, ListingImage>();
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Listing photos are public, but they are only fetched when the user asks to
 * see one. Fetched once, then cached on disk so the same photo never hits the
 * network again.
 */
export async function fetchListingImage(url: string, cacheDir: string): Promise<ListingImage> {
  const fromMemory = memory.get(url);
  if (fromMemory) return { ...fromMemory, cached: true };

  const key = crypto.createHash("sha256").update(url).digest("hex").slice(0, 24);
  const metaPath = path.join(cacheDir, `${key}.json`);

  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        file: string;
        contentType: string;
        bytes: number;
      };
      if (fs.existsSync(meta.file)) {
        const buffer = fs.readFileSync(meta.file);
        const result: ListingImage = {
          dataUrl: `data:${meta.contentType};base64,${buffer.toString("base64")}`,
          contentType: meta.contentType,
          bytes: meta.bytes,
          cached: true,
        };
        memory.set(url, result);
        return result;
      }
    } catch {
      /* cache is disposable */
    }
  }

  const res = await fetch(url, {
    headers: { "user-agent": "Fahas/0.1 (local hardware advisor; viewing a public listing photo)" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Photo download failed (HTTP ${res.status}).`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new Error(`Not an image (${contentType || "unknown type"}).`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) throw new Error("Photo is larger than 8 MB.");

  const ext = contentType.includes("webp") ? ".webp" : contentType.includes("png") ? ".png" : ".jpg";
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${key}${ext}`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  fs.writeFileSync(metaPath, JSON.stringify({ file, contentType, bytes: buffer.byteLength }), { mode: 0o600 });

  const result: ListingImage = {
    dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
    contentType,
    bytes: buffer.byteLength,
    cached: false,
  };
  memory.set(url, result);
  return result;
}

export function clearImageMemoryCache() {
  memory.clear();
}
