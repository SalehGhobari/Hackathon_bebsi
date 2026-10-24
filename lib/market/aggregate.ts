import type { MarketBucket, MarketCategory, ParsedListing } from "../types";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return Math.round((sorted[base] + rest * (next - sorted[base])) * 10) / 10;
}

function bucketKey(l: ParsedListing): string | null {
  switch (l.category) {
    case "ram":
      if (!l.capacityGb) return null;
      return `ram|${l.ramGen ?? "?"}|${l.capacityGb}|${l.formFactor ?? "?"}`;
    case "ssd":
      if (l.variant === "external" || !l.capacityGb) return null;
      return `ssd|${l.bus ?? "?"}|${l.capacityGb}`;
    case "hdd":
      if (l.variant === "external" || !l.capacityGb) return null;
      return `hdd|${l.capacityGb}`;
    case "charger":
      if (l.variant !== "laptop") return null;
      return `charger|${l.watts ?? "?"}`;
    case "battery":
      return l.variant === "laptop" ? "battery|laptop" : null;
    case "cooling":
      if (l.variant === "thermal-paste") return "cooling|paste";
      if (l.variant === "fan") return "cooling|fan";
      return null;
    case "laptop":
      return `laptop|${l.condition}`;
    case "desktop":
      return `desktop|${l.condition}`;
    case "gpu":
      return "gpu";
    default:
      return null;
  }
}

function bucketLabel(key: string): string {
  const [category, a, b, c] = key.split("|");
  const gb = (v: string) => (v && v !== "?" ? `${v} GB` : "");
  switch (category as MarketCategory) {
    case "ram": {
      const gen = a !== "?" ? a : "RAM";
      const cap = gb(b);
      const form = c !== "?" ? c : "";
      return [gen, form, cap].filter(Boolean).join(" ");
    }
    case "ssd":
      return [a !== "?" ? a : "", "SSD", gb(b)].filter(Boolean).join(" ");
    case "hdd":
      return ["HDD", gb(a)].filter(Boolean).join(" ");
    case "charger":
      return a !== "?" ? `Charger ${a} W` : "Laptop charger (mixed wattage)";
    case "battery":
      return "Laptop battery";
    case "cooling":
      return key === "cooling|paste" ? "Thermal paste" : "Cooling fan";
    case "laptop":
      return a === "used" ? "Used laptop" : a === "new" ? "New laptop" : "Laptop";
    case "desktop":
      return a === "used" ? "Used desktop / mini PC" : "Desktop / mini PC";
    case "gpu":
      return "Graphics card";
    default:
      return key;
  }
}

/** Only non-outlier listings with a real spec reach the aggregates. */
export function bucketize(listings: ParsedListing[]): MarketBucket[] {
  const groups = new Map<string, ParsedListing[]>();

  for (const l of listings) {
    if (l.outlier) continue;
    const key = bucketKey(l);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }

  const buckets: MarketBucket[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const prices = group.map((g) => g.priceJod);
    buckets.push({
      key,
      label: bucketLabel(key),
      category: group[0].category,
      median: percentile(prices, 0.5),
      p25: percentile(prices, 0.25),
      p75: percentile(prices, 0.75),
      min: Math.min(...prices),
      max: Math.max(...prices),
      n: group.length,
      samples: [...group]
        .sort((a, b) => a.priceJod - b.priceJod)
        .slice(0, 3)
        .map((g) => ({ title: g.title, priceJod: g.priceJod, url: g.url })),
    });
  }

  return buckets.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}
