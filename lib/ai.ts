import { normalizeArabic } from "./market/arabic";

export type AiFilters = {
  category: string | null;
  ramGen: string | null;
  formFactor: string | null;
  minCapacityGb: number | null;
  maxPriceJod: number | null;
  condition: "new" | "used" | null;
  keywords: string[];
};

export type AiSearchResult = {
  filters: AiFilters;
  summary: string;
  engine: "local-model" | "fallback";
  model?: string;
  note?: string;
};

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const PREFERRED = ["qwen3:4b", "qwen3:4b-instruct", "llama3.2:3b", "qwen2.5:3b", "gemma3:4b", "qwen3.6:latest"];

const CATEGORIES = [
  "ram", "ssd", "hdd", "battery", "charger", "cooling", "gpu",
  "cpu", "motherboard", "laptop", "desktop", "keyboard", "other",
];

let cachedModel: string | null | undefined;

async function pickModel(): Promise<string | null> {
  if (cachedModel !== undefined) return cachedModel;
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      cachedModel = null;
      return null;
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    // Only small, demo-safe models count as "available". A 23 GB model on an
    // 8 GB GPU would hang the UI, so it is ignored rather than attempted.
    cachedModel = PREFERRED.find((p) => names.includes(p)) ?? null;
    return cachedModel;
  } catch {
    cachedModel = null;
    return null;
  }
}

export async function aiStatus(): Promise<{ available: boolean; model: string | null; note: string }> {
  const model = await pickModel();
  return model
    ? { available: true, model, note: `Local model ready: ${model}` }
    : { available: false, model: null, note: "Ollama is not running; keyword search is used instead." };
}

function cleanFilters(raw: Record<string, unknown>): AiFilters {
  const category = typeof raw.category === "string" && CATEGORIES.includes(raw.category) ? raw.category : null;
  const ramGen = typeof raw.ramGen === "string" && /^DDR[2-5]$/i.test(raw.ramGen) ? raw.ramGen.toUpperCase() : null;
  const formFactor =
    typeof raw.formFactor === "string" && ["SO-DIMM", "DIMM"].includes(raw.formFactor.toUpperCase())
      ? raw.formFactor.toUpperCase()
      : null;
  const minCapacityGb =
    typeof raw.minCapacityGb === "number" && raw.minCapacityGb > 0 && raw.minCapacityGb <= 8192
      ? Math.round(raw.minCapacityGb)
      : null;
  const maxPriceJod =
    typeof raw.maxPriceJod === "number" && raw.maxPriceJod > 0 && raw.maxPriceJod <= 5000 ? Math.round(raw.maxPriceJod) : null;
  const condition = raw.condition === "new" || raw.condition === "used" ? raw.condition : null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 1).slice(0, 4)
    : [];

  return { category, ramGen, formFactor, minCapacityGb, maxPriceJod, condition, keywords };
}

const CATEGORY_WORDS: [RegExp, string][] = [
  [/رام|رامات|\bram\b|memory|ذاكره/, "ram"],
  [/\bssd\b|nvme|اس اس دي/, "ssd"],
  [/هارد|\bhdd\b|hard disk/, "hdd"],
  [/بطاري|battery/, "battery"],
  [/شاحن|charger|adapter/, "charger"],
  [/مروح|تبريد|cooling|fan|paste/, "cooling"],
  [/كرت شاش|graphic|gpu|rtx|gtx/, "gpu"],
  [/لابتوب|laptop|notebook/, "laptop"],
  [/كمبيوتر|\bpc\b|desktop|مكتبي/, "desktop"],
  [/معالج|\bcpu\b|processor/, "cpu"],
  [/مذربورد|motherboard|لوحه ام/, "motherboard"],
  [/كيبورد|keyboard|ماوس|mouse/, "keyboard"],
];

/** Never leaves the user empty-handed when the model is missing. */
export function fallbackSearch(query: string): AiSearchResult {
  const text = normalizeArabic(query);
  const category = CATEGORY_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  const ddr = /ddr\s?([2-5])/.exec(text)?.[1] ?? null;
  const formFactor = /so-?dimm|سوديم/.test(text) ? "SO-DIMM" : /\bdimm\b/.test(text) ? "DIMM" : null;
  const capacity = /(\d{2,4})\s*(gb|g|جيجا|غيغا)/.exec(text)?.[1] ?? null;
  const price = /(?:under|below|تحت|اقل من)\s*(\d{2,4})/.exec(text)?.[1] ?? null;
  const condition = /جديد|\bnew\b/.test(text) ? "new" : /مستعمل|\bused\b/.test(text) ? "used" : null;

  const keywords: string[] = [];
  if (ddr) keywords.push(`DDR${ddr}`);
  if (capacity) keywords.push(`${capacity} GB`);

  const filters: AiFilters = {
    category,
    ramGen: ddr ? `DDR${ddr}` : null,
    formFactor,
    minCapacityGb: capacity ? Number(capacity) : null,
    maxPriceJod: price ? Number(price) : null,
    condition,
    keywords,
  };

  const bits = [category, filters.ramGen, formFactor, capacity ? `${capacity} GB+` : null, price ? `≤ ${price} JOD` : null]
    .filter(Boolean)
    .join(" · ");

  return {
    filters,
    summary: bits || query,
    engine: "fallback",
    note: "Parsed with keywords (no model available).",
  };
}

export async function aiSearch(query: string, lang: "en" | "ar"): Promise<AiSearchResult> {
  const model = await pickModel();
  if (!model) return fallbackSearch(query);

  const prompt = `You convert a hardware shopping request into JSON filters for a classifieds index.
Allowed category values: ${CATEGORIES.join(", ")}.
Allowed ramGen: DDR2, DDR3, DDR4, DDR5. Allowed formFactor: SO-DIMM, DIMM.
Return ONLY JSON:
{"category":string|null,"ramGen":string|null,"formFactor":string|null,"minCapacityGb":number|null,"maxPriceJod":number|null,"condition":"new"|"used"|null,"keywords":string[],"summary":string}
Rules: use null when unsure; keywords are short spec words a listing might contain; summary is one short line in ${lang === "ar" ? "Arabic" : "English"}.
Request: """${query}"""`;

  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json", options: { temperature: 0 } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { response?: string };
    const parsed = JSON.parse(data.response ?? "{}") as Record<string, unknown>;
    return {
      filters: cleanFilters(parsed),
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : query,
      engine: "local-model",
      model,
    };
  } catch (err) {
    const fallback = fallbackSearch(query);
    return { ...fallback, note: err instanceof Error ? err.message : String(err) };
  }
}
