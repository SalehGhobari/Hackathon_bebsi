import type { MaterialAmount } from "../types";

export type NameEstimate = {
  category: string;
  kg: number;
  materials: MaterialAmount[];
  confidence: "high" | "medium" | "low";
  basis: string;
};

type Profile = [string, number][];

/**
 * Name-based recycling estimates. The table is deliberately conservative and
 * only covers materials we can reasonably attribute; it is an estimate, not a
 * manufacturer teardown. When the name adds a capacity/wattage/size hint we use
 * it to tighten the mass; otherwise we fall back to the category range.
 */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/battery|بطاري|power\s?bank|بنك\s?طاق/, "battery"],
  [/charger|adapter|power\s?supply|psu|شاحن|محول/, "charger"],
  [/ssd|nvme|m\.2|solid\s?state|\b(?:980|970|990|870|sn\d{3})\b|crucial|اس\s?اس\s?دي/, "ssd"],
  [/hdd|hard\s?(disk|drive)|seagate|barracuda|ironwolf|wd\s?(blue|red|purple)|هارد/, "hdd"],
  [/\bram\b|ddr\s?[2-5]|so-?dimm|\bdimm\b|memory|fury|vengeance|ripjaws|trident|رام|ذاكره/, "ram"],
  [/\bgpu\b|graphics\s?card|rtx\s?\d|gtx\s?\d|radeon|كرت\s?شاش/, "gpu"],
  [/\bcpu\b|processor|ryzen|core\s?i[3579]|معالج/, "cpu"],
  [/motherboard|mainboard|b550|b650|x670|z790|مذربورد|لوحه\s?ام/, "motherboard"],
  [/cooling|heatsink|aio|radiator|fan|cooler|مروح|تبريد/, "cooling"],
  [/keyboard|mouse|كيبورد|ماوس/, "keyboard"],
  [/cable|adapter\s?cable|كابل|سلك/, "cable"],
  [/monitor|display|screen|شاشه|مونيتور/, "monitor"],
  [/printer|laserjet|deskjet|officejet|inkjet|epson|canon|brother|طابعه/, "printer"],
  [/router|switch|access\s?point|tp-?link|netgear|راوتر/, "router"],
  [/iphone|galaxy|pixel|smartphone|mobile|redmi|xiaomi|oppo|huawei|هاتف|جوال/, "phone"],
  [/ipad|tablet|تابلت/, "tablet"],
  [/macbook|thinkpad|ideapad|pavilion|latitude|inspiron|vivobook|aspire|notebook|laptop|لابتوب/, "laptop"],
  [/desktop|workstation|tower|\bpc\b|مكتبي|كمبيوتر/, "desktop"],
  [/\btv\b|television|تلفزيون/, "tv"],
];

const MASS: Record<string, number> = {
  laptop: 2.0,
  desktop: 8.0,
  phone: 0.2,
  tablet: 0.5,
  monitor: 3.5,
  printer: 7.0,
  router: 0.8,
  battery: 0.25,
  ssd: 0.07,
  hdd: 0.5,
  ram: 0.03,
  charger: 0.3,
  cooling: 0.2,
  gpu: 1.2,
  cpu: 0.05,
  motherboard: 0.7,
  keyboard: 0.7,
  cable: 0.1,
  tv: 10,
  other: 0.5,
};

const PROFILES: Record<string, Profile> = {
  laptop: [
    ["Copper", 0.20],
    ["Aluminium", 0.12],
    ["Plastics", 0.30],
    ["Cobalt", 0.03],
    ["Lithium", 0.015],
    ["Rare earths", 0.005],
    ["Gold", 0.0001],
    ["Silver", 0.0002],
  ],
  desktop: [
    ["Copper", 0.15],
    ["Aluminium", 0.20],
    ["Plastics", 0.30],
    ["Rare earths", 0.002],
    ["Gold", 0.0001],
  ],
  phone: [
    ["Copper", 0.08],
    ["Aluminium", 0.15],
    ["Plastics", 0.35],
    ["Cobalt", 0.03],
    ["Lithium", 0.015],
    ["Rare earths", 0.005],
    ["Gold", 0.0002],
    ["Silver", 0.0005],
  ],
  tablet: [
    ["Copper", 0.07],
    ["Aluminium", 0.18],
    ["Plastics", 0.30],
    ["Cobalt", 0.02],
    ["Lithium", 0.012],
    ["Rare earths", 0.004],
    ["Gold", 0.0001],
  ],
  monitor: [
    ["Copper", 0.05],
    ["Aluminium", 0.10],
    ["Glass", 0.20],
    ["Plastics", 0.35],
    ["Rare earths", 0.002],
  ],
  printer: [
    ["Copper", 0.03],
    ["Aluminium", 0.08],
    ["Plastics", 0.50],
    ["Rare earths", 0.001],
  ],
  router: [
    ["Copper", 0.08],
    ["Aluminium", 0.10],
    ["Plastics", 0.50],
  ],
  battery: [
    ["Lithium", 0.10],
    ["Cobalt", 0.08],
    ["Copper", 0.05],
    ["Aluminium", 0.10],
    ["Plastics", 0.30],
  ],
  ssd: [
    ["Copper", 0.15],
    ["Aluminium", 0.20],
    ["Plastics", 0.20],
    ["Rare earths", 0.01],
    ["Gold", 0.0005],
  ],
  hdd: [
    ["Aluminium", 0.25],
    ["Copper", 0.08],
    ["Plastics", 0.10],
    ["Rare earths", 0.03],
    ["Gold", 0.0001],
  ],
  ram: [
    ["Copper", 0.20],
    ["Plastics", 0.20],
    ["Rare earths", 0.01],
    ["Gold", 0.001],
  ],
  charger: [
    ["Copper", 0.20],
    ["Aluminium", 0.10],
    ["Plastics", 0.50],
  ],
  cooling: [
    ["Copper", 0.30],
    ["Aluminium", 0.40],
    ["Plastics", 0.20],
  ],
  gpu: [
    ["Copper", 0.10],
    ["Aluminium", 0.15],
    ["Plastics", 0.20],
    ["Rare earths", 0.005],
    ["Gold", 0.0003],
  ],
  cpu: [
    ["Copper", 0.20],
    ["Rare earths", 0.02],
    ["Gold", 0.002],
  ],
  motherboard: [
    ["Copper", 0.15],
    ["Plastics", 0.30],
    ["Rare earths", 0.01],
    ["Gold", 0.0005],
  ],
  keyboard: [
    ["Copper", 0.05],
    ["Plastics", 0.70],
  ],
  cable: [
    ["Copper", 0.40],
    ["Plastics", 0.50],
  ],
  tv: [
    ["Copper", 0.03],
    ["Aluminium", 0.05],
    ["Glass", 0.30],
    ["Plastics", 0.35],
    ["Rare earths", 0.001],
  ],
  other: [
    ["Copper", 0.05],
    ["Plastics", 0.50],
  ],
};

function norm(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

function inferCategory(name: string, hint?: string): string {
  if (hint && hint !== "other") return hint;
  const text = norm(name);
  for (const [pattern, category] of CATEGORY_WORDS) {
    if (pattern.test(text)) return category;
  }
  return hint || "other";
}

function capacityTb(text: string): number | null {
  const tb = /(\d+(?:\.\d+)?)\s*(?:tb|تيرا)/i.exec(text)?.[1];
  if (tb) return Number(tb);
  const gb = /(\d+(?:\.\d+)?)\s*(?:gb|جيجا|غيغا)/i.exec(text)?.[1];
  return gb ? Number(gb) / 1000 : null;
}

function inches(text: string): number | null {
  const m = /(\d{2}(?:\.\d+)?)\s*(?:inch|in|"|بوصه)/i.exec(text) ?? /(\d{2})(?:\s*["”])/.exec(text);
  return m ? Number(m[1]) : null;
}

function watts(text: string): number | null {
  const m = /(\d{2,4})\s*w(?:att)?/i.exec(text);
  return m ? Number(m[1]) : null;
}

function wattHours(text: string): number | null {
  const m = /(\d{2,4})\s*wh/i.exec(text);
  return m ? Number(m[1]) : null;
}

function milliAmpHours(text: string): number | null {
  const m = /(\d{3,6})\s*mah/i.exec(text);
  return m ? Number(m[1]) : null;
}

function massFor(category: string, text: string): number {
  const cap = capacityTb(text);
  const size = inches(text);
  const w = watts(text);
  const wh = wattHours(text);
  const mah = milliAmpHours(text);

  switch (category) {
    case "laptop":
      if (/macbook\s?air|ultrabook|13\s*(?:inch|in|")/i.test(text)) return 1.4;
      if (/gaming|17\s*(?:inch|in|")|18\s*(?:inch|in|")/i.test(text)) return 2.8;
      return MASS.laptop;
    case "desktop":
      if (/mini|nuc|sff|small\s?form/i.test(text)) return 1.5;
      if (/tower|full\s?size/i.test(text)) return 10;
      return MASS.desktop;
    case "phone":
      return /pro\s?max|ultra|fold/i.test(text) ? 0.23 : MASS.phone;
    case "tablet":
      return /ipad\s?pro|12\.9/i.test(text) ? 0.68 : MASS.tablet;
    case "monitor":
      if (/crt/i.test(text)) return 15;
      return size ? 1.2 + size * 0.12 : MASS.monitor;
    case "printer":
      if (/portable/i.test(text)) return 2;
      if (/laser|laserjet/i.test(text)) return 10;
      if (/inkjet|deskjet/i.test(text)) return 5;
      return MASS.printer;
    case "router":
      return /switch|24-?port|48-?port/i.test(text) ? 2.5 : MASS.router;
    case "battery":
      if (wh) return 0.06 + wh * 0.004;
      if (mah) return 0.03 + (mah * 3.7 * 0.004) / 1000;
      return MASS.battery;
    case "ssd": {
      const base = cap ? 0.04 + cap * 0.03 : MASS.ssd;
      return /heatsink|cooler/i.test(text) ? base + 0.05 : base;
    }
    case "hdd":
      if (/3\.5|desktop/i.test(text)) return 0.65;
      if (/2\.5|laptop/i.test(text)) return 0.35;
      return /external|portable/i.test(text) ? 0.3 : MASS.hdd;
    case "ram": {
      const gb = /(\d+)\s*gb/i.exec(text)?.[1];
      return gb ? 0.015 + Number(gb) * 0.0015 : MASS.ram;
    }
    case "charger":
      return w ? 0.05 + w * 0.0025 : MASS.charger;
    case "cooling":
      return /aio|radiator|360|280/i.test(text) ? 1.5 : MASS.cooling;
    case "gpu":
      if (/4090|4080|3090|7900/i.test(text)) return 2.0;
      if (/3080|4070|7800|6800/i.test(text)) return 1.5;
      return MASS.gpu;
    case "cpu":
      return MASS.cpu;
    case "motherboard":
      return /itx|mini-?itx/i.test(text) ? 0.4 : MASS.motherboard;
    case "keyboard":
      return /mechanical/i.test(text) ? 1.0 : MASS.keyboard;
    case "cable":
      return /10\s?m|long/i.test(text) ? 0.2 : MASS.cable;
    case "tv":
      return size ? 4 + size * 0.2 : MASS.tv;
    default:
      return MASS[category] ?? MASS.other;
  }
}

function materialsFor(category: string, kg: number): MaterialAmount[] {
  const profile = PROFILES[category] ?? PROFILES.other;
  return profile
    .map(([name, pct]) => ({ name, grams: Math.round(kg * 1000 * pct * 10) / 10 }))
    .filter((m) => m.grams >= 0.1)
    .sort((a, b) => b.grams - a.grams);
}

function label(category: string): string {
  return category === "other" ? "generic e-waste" : category.replace("-", " ");
}

/**
 * Estimate the weight and recoverable materials from a free-text name.
 * Category is inferred from the name unless a clearer category was selected.
 */
export function estimateRecycleByName(name: string, hint?: string): NameEstimate {
  const trimmed = name.trim();
  const category = inferCategory(trimmed, hint);
  const kg = Math.max(0.01, Math.round(massFor(category, trimmed) * 100) / 100);
  const materials = materialsFor(category, kg);
  const cap = capacityTb(trimmed);
  const size = inches(trimmed);
  const w = watts(trimmed);
  const wh = wattHours(trimmed);
  const mah = milliAmpHours(trimmed);
  const hasSpec = Boolean(cap || size || w || wh || mah || /macbook|thinkpad|iphone|galaxy|rtx|ddr\s?[2-5]|laserjet/i.test(trimmed));
  const confidence = category === "other" ? "low" : hasSpec ? "high" : "medium";
  const spec = cap
    ? `${cap >= 1 ? `${cap} TB` : `${Math.round(cap * 1000)} GB`}`
    : size
      ? `${size}"`
      : wh
        ? `${wh} Wh`
        : mah
          ? `${mah} mAh`
          : w
            ? `${w} W`
            : "";
  const basis = `${label(category)}${spec ? ` · ${spec}` : ""} · ${confidence === "high" ? "name/spec estimate" : "category estimate"}`;
  return { category, kg, materials, confidence, basis };
}
