import { normalizeArabic } from "./arabic";
import type { MarketCategory, ParsedListing, RawListing } from "../types";

type Rule = { category: MarketCategory; patterns: RegExp[] };

/**
 * Order matters: "شاحن لابتوب" must classify as a charger, not a laptop;
 * "بطارية لابتوب" as a battery. More specific categories come first.
 */
const RULES: Rule[] = [
  { category: "battery", patterns: [/بطار/, /\bbattery\b/, /\bبطاريات\b/] },
  { category: "charger", patterns: [/شاحن/, /شواحن/, /محول/, /\bcharger\b/, /\badapter\b/, /قواعد شحن/] },
  { category: "cooling", patterns: [/مروح/, /مراوح/, /\bmبرد\b/, /\bfan\b/, /\bfans\b/, /تبريد/, /\bcooling\b/, /معجون حراري/, /ثيرمال/, /thermal paste/, /coreliquid/] },
  { category: "gpu", patterns: [/كرت شاش/, /كرت شاشه/, /جرافيك/, /\bgraphic/, /\brtx\b/, /\bgtx\b/, /\brx\s?\d/, /radeon/, /geforce/] },
  { category: "cpu", patterns: [/معالج/, /بروسيسور/, /\bprocessor\b/, /\bryzen\b/, /\bcore\s?i[3579]\b/, /\bi[3579][- ]?\d{4,5}\b/] },
  { category: "motherboard", patterns: [/مذربورد/, /لوحه ام/, /لوحة ام/, /\bmotherboard\b/, /\bb[456]\d0\b/, /\bz\d{3}\b/, /\bh\d{3}\b/] },
  { category: "ram", patterns: [/\bرام\b/, /رامات/, /ذاكره/, /\bddr\s?[2-5]\b/, /\bram\b/, /\bmemory\b/] },
  { category: "ssd", patterns: [/\bssd\b/, /اس اس دي/, /\bnvme\b/, /ان في ام/, /\bm\.?2\b/, /ام 2/, /تخزين سريع/] },
  { category: "hdd", patterns: [/هارد/, /هاردسك/, /\bhdd\b/, /\bhard\s?(disk|drive)\b/, /قرص صلب/] },
  { category: "keyboard", patterns: [/كيبورد/, /\bkeyboard\b/, /ماوس/, /\bmouse\b/] },
  { category: "laptop", patterns: [/لابتوب/, /لاب توب/, /\blaptop\b/, /نوت بوك/, /\bnotebook\b/, /ماك بوك/, /macbook/] },
  { category: "desktop", patterns: [/كمبيوتر/, /بي سي/, /\bpc\b/, /مكتبي/, /ديسكتوب/, /\bdesktop\b/, /mini pc/, /all in one/] },
];

const BRANDS = [
  "kingston", "samsung", "seagate", "western digital", "wd", "crucial", "adata", "toshiba",
  "lenovo", "hp", "dell", "asus", "acer", "msi", "gigabyte", "intel", "amd", "ryzen",
  "nvidia", "logitech", "anker", "apple", "huawei", "teamgroup", "hiksemi", "sandisk",
];

const ARABIC_BRANDS: Record<string, string> = {
  "سامسونج": "Samsung",
  "كينجستون": "Kingston",
  "لينوفو": "Lenovo",
  "ديل": "Dell",
  "اسوس": "Asus",
  "توشيبا": "Toshiba",
};

/** Words that mean "this is a component", even when a laptop is mentioned. */
const PART_PREFIX =
  /^(رام|رامات|ذاكره|شاحن|شواحن|محول|ادابتر|بطاري|هارد|هاردسك|ssd|nvme|مروح|مبرد|معجون|شاشه|كيبورد|ماوس|لوحه|مذربورد|معالج|بروسيسور|كابل|كابلات|وصلات|اسلاك|كل شاحن|كفر|شنطه|حقيبه)/;

function classify(text: string): MarketCategory {
  // Readers, docks and hubs mention "SSD/NVMe" but are not drives.
  if (/reader|قارئ|dock|قاعده|hub\b/.test(text) && !/شاحن|laptop/.test(text)) return "other";

  // Screens are parts, not machines ("شاشة لابتوب"). Careful: "بكرتين شاشه"
  // means two GPUs inside a laptop, not a screen for sale.
  const screenPart =
    (/^(شاشه|screen|monitor|display)/.test(text) ||
      /(شاشه|screen|monitor|display)\s*(لابتوب|laptop|كمبيوتر|computer|بوصه)/.test(text)) &&
    !/كرت|graphic/.test(text);
  if (screenPart) return "other";

  // Job lots: "قطع كمبيوتر ram ssd nvme" is not a laptop.
  if (/^قطع|قطع كمبيوتر|قطع لابتوب/.test(text)) return "other";

  const ramForLaptop = /(رام|رامات)\s*(لابتوب|لاب توب)|(لابتوب|لاب توب)\s*(رام|رامات)|(ram|memory)\s*(for|ل)/.test(text);
  const isPart = PART_PREFIX.test(text) || ramForLaptop;

  const laptopish = /لابتوب|لاب توب|laptop|نوت بوك|notebook|macbook/.test(text);
  const desktopish = /كمبيوتر|كومبيوتر|بي سي|\bpc\b|مكتبي|ديسكتوب|mini pc|all in one|اوبتكليكس|optiplex/.test(text);

  // A whole machine mentions DDR5/RTX/SSD as specifications. If it leads with
  // "laptop"/"computer" it is a device, not the component named inside it.
  if (!isPart && laptopish) return "laptop";
  if (!isPart && desktopish) return "desktop";

  for (const rule of RULES) {
    // A part-looking title must not fall through to "laptop/desktop" just
    // because it mentions the word "computer" (e.g. "وصلات كمبيوتر").
    if (isPart && (rule.category === "laptop" || rule.category === "desktop")) continue;
    if (rule.patterns.some((p) => p.test(text))) return rule.category;
  }
  return "other";
}

/** Capacity in GB. TB is converted. Requires an explicit unit to avoid guessing. */
function extractCapacity(text: string, category: MarketCategory): number | null {
  if (!["ssd", "hdd", "ram", "laptop", "desktop"].includes(category)) return null;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(tb|t|تيرا|ترا|gb|g|جيجا|غيغا|جيجابايت)\b/);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const unit = m[2];
  const isTera = /tb|^t$|تيرا|ترا/.test(unit);
  const gb = isTera ? value * 1024 : value;
  if (gb < 4 || gb > 8192) return null;
  return Math.round(gb);
}

function extractRamGen(text: string): string | null {
  const m = text.match(/ddr\s?([2-5])/) ?? text.match(/دي\s*دي\s*ار\s*([2-5])/);
  return m ? `DDR${m[1]}` : null;
}

function extractFormFactor(text: string, category: MarketCategory): string | null {
  if (category === "ram") {
    if (/so-?dimm|سوديم/.test(text)) return "SO-DIMM";
    if (/dimm/.test(text)) return "DIMM";
    if (/لابتوب|لاب توب|نوت|notebook|laptop/.test(text)) return "SO-DIMM";
    if (/مكتبي|ديسكتوب|desktop|\bpc\b|كمبيوتر/.test(text)) return "DIMM";
    return null;
  }
  if (category === "ssd" || category === "hdd") {
    if (/2[.,]5/.test(text)) return '2.5"';
    if (/m\.?2|2280|ام 2/.test(text)) return "M.2";
    if (/\bhdd\b|هاردسك|3[.,]5/.test(text)) return '3.5"';
    return null;
  }
  return null;
}

function extractBus(text: string, category: MarketCategory): string | null {
  if (category !== "ssd" && category !== "hdd") return null;
  if (/nvme|ان في ام|pcie|gen ?[345]/.test(text)) return "NVMe";
  if (/sata|ساتا/.test(text)) return "SATA";
  return null;
}

function extractWatts(text: string): number | null {
  const m = text.match(/(\d{2,3})\s*(?:w|واط|وات|watt)\b/);
  if (!m) return null;
  const w = Number(m[1]);
  return w >= 15 && w <= 500 ? w : null;
}

function extractBrand(text: string): string | null {
  for (const b of BRANDS) {
    if (new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
      return b === "wd" ? "Western Digital" : b.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  for (const [ar, en] of Object.entries(ARABIC_BRANDS)) {
    if (text.includes(ar)) return en;
  }
  return null;
}

/**
 * Listings are vague, so category alone is not enough: a "battery" can be a
 * CR2032 coin cell, and a "charger" can be a 220→110V converter. Variants keep
 * the price buckets honest.
 */
function extractVariant(text: string, category: MarketCategory): string | null {
  const laptopish = /لابتوب|لاب توب|لابتوبات|notebook|laptop|نوت بوك/.test(text);
  if (category === "battery") {
    // CR2032/AA cells dominate this category; only laptop wording means a laptop pack.
    return laptopish ? "laptop" : "small";
  }
  if (category === "charger") {
    if (/محول|converter|transformer|220.?110/.test(text)) return "converter";
    if (/شاحن بطاريات|battery charger/.test(text)) return "small";
    if (laptopish || /(^|\s)\d{2,3}\s*(w|واط|وات)\b/.test(text) || /type c|تايب سي/.test(text)) return "laptop";
    return "small";
  }
  if (category === "cooling") {
    if (/معجون|thermal paste|thermal grease|ثيرمال/.test(text)) return "thermal-paste";
    if (/مروح|\bfans?\b|cooler/.test(text)) return "fan";
    return "other";
  }
  if (category === "ssd" || category === "hdd") {
    if (/خارجي|external|portable|usb/.test(text)) return "external";
    return "internal";
  }
  return null;
}

export function parseListing(raw: RawListing): ParsedListing {
  const text = normalizeArabic(raw.title);
  const category = classify(text);
  const capacityGb = extractCapacity(text, category);
  const variant = extractVariant(text, category);
  const ramGen = category === "ram" ? extractRamGen(text) : null;
  const formFactor = extractFormFactor(text, category);
  const bus = extractBus(text, category);
  const watts = category === "charger" ? extractWatts(text) : null;
  const brand = extractBrand(text);
  const condition = raw.condition === "new" || raw.condition === "used" ? raw.condition : "unknown";

  const tags: string[] = [];
  if (category !== "other") tags.push(categoryLabel(category));
  if (capacityGb) tags.push(capacityGb >= 1024 ? `${capacityGb / 1024} TB` : `${capacityGb} GB`);
  if (ramGen) tags.push(ramGen);
  if (formFactor) tags.push(formFactor);
  if (bus) tags.push(bus);
  if (watts) tags.push(`${watts} W`);
  if (condition !== "unknown") tags.push(condition === "new" ? "New" : "Used");

  const hasSpec = Boolean(capacityGb || ramGen || watts || bus || formFactor);
  const confidence: ParsedListing["confidence"] =
    category === "other" ? "low" : hasSpec || brand ? "high" : "medium";

  return {
    ...raw,
    category,
    capacityGb,
    ramGen,
    formFactor,
    bus,
    watts,
    variant,
    brand,
    condition,
    confidence,
    tags,
    outlier: false,
  };
}

export function categoryLabel(category: MarketCategory): string {
  const labels: Record<MarketCategory, string> = {
    ram: "RAM",
    ssd: "SSD",
    hdd: "HDD",
    battery: "Battery",
    charger: "Charger",
    laptop: "Laptop",
    desktop: "Desktop",
    gpu: "Graphics card",
    cpu: "CPU",
    motherboard: "Motherboard",
    cooling: "Cooling",
    keyboard: "Keyboard / mouse",
    other: "Other",
  };
  return labels[category];
}

/**
 * Prices on classifieds include bundles, accessories and typos. Flag statistical
 * outliers per spec bucket instead of silently dropping them: the UI shows them
 * separately so a 1 JOD "SSD" does not drag the median down.
 */
export function flagOutliers(listings: ParsedListing[]): ParsedListing[] {
  const groups = new Map<string, ParsedListing[]>();
  for (const l of listings) {
    if (l.category === "other") continue;
    const key = `${l.category}|${l.ramGen ?? ""}|${l.capacityGb ?? ""}|${l.watts ?? ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }

  const median = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const percentile = (values: number[], p: number) => {
    const s = [...values].sort((a, b) => a - b);
    const pos = (s.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    const next = s[base + 1] ?? s[base];
    return s[base] + rest * (next - s[base]);
  };

  for (const group of groups.values()) {
    // Whole machines legitimately span 100–1600 JOD, so a 3x-median rule
    // wrongly flags high-end laptops. Use IQR fences instead, which adapt to
    // the spread of the group.
    if (group.length < 4) continue;
    const prices = group.map((g) => g.priceJod);
    const q1 = percentile(prices, 0.25);
    const q3 = percentile(prices, 0.75);
    const iqr = q3 - q1;
    const highFence = q3 + 3 * iqr;
    const lowFence = Math.max(0.5, q1 - 3 * iqr);

    for (const item of group) {
      if (item.priceJod > highFence || item.priceJod < lowFence) item.outlier = true;
      if (item.priceJod <= 0.5 && !["battery", "charger"].includes(item.category)) item.outlier = true;
    }
  }
  return listings;
}
