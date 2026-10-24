const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/**
 * Folds Arabic text into a searchable/canonical form:
 * diacritics and tatweel removed, alef/ya/ta-marbuta unified, digits converted.
 * Used for BOTH indexing and querying, so "بطارية" and "بطاريه" match.
 */
export function normalizeArabic(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/\u200f|\u200e/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isMostlyArabic(text: string): boolean {
  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const letters = (text.match(/[A-Za-z\u0600-\u06FF]/g) ?? []).length;
  return letters > 0 && arabic / letters > 0.35;
}

/** Digits may appear as ٥ or 5, with or without thousands separators. */
export function toAsciiNumber(raw: string): number | null {
  const cleaned = normalizeArabic(raw).replace(/[,\s]/g, "");
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}
