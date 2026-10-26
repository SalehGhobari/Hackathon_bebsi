import { normalizeArabic } from "./arabic";

/**
 * Deterministic query parsing.
 *
 * This turns a phrase like "ddr4 16gb laptop ram under 100" into structured
 * filters. It is plain pattern matching — no model, local or remote — so it
 * behaves the same offline as it does online and can never invent a value.
 * The optional DeepSeek integration is a separate, explicitly-enabled path.
 */

export type QueryFilters = {
  category: string | null;
  ramGen: string | null;
  formFactor: string | null;
  minCapacityGb: number | null;
  maxPriceJod: number | null;
  condition: "new" | "used" | null;
  keywords: string[];
};

export type QueryParse = {
  filters: QueryFilters;
  summary: string;
};

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

export function parseQuery(query: string): QueryParse {
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

  const filters: QueryFilters = {
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

  return { filters, summary: bits || query.trim() };
}
