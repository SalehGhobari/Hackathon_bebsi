import type { PriceEntry } from "./types";

/**
 * Retail click-through.
 *
 * Jordanian retailers render their product grids client-side, so a server-side
 * fetch returns a shell with no prices (verified against GTS and Jumia). Rather
 * than scrape a price we cannot actually read, every retail match carries:
 *
 *   1. the vendor product page from the price book, when the row has one, and
 *   2. a live search link for that exact part, so the current price is one
 *      click away.
 *
 * The dated figure stays what it is — a captured price with a source — and the
 * link is what makes it checkable.
 */

export type RetailLink = {
  label: string;
  url: string;
  kind: "product" | "search";
};

/** Shops that accept a free-text query in the URL. */
const SEARCH_TEMPLATES: { vendor: string; label: string; build: (q: string) => string }[] = [
  {
    vendor: "gts",
    label: "GTS",
    build: (q) => `https://gts.jo/en/product/search?search=${encodeURIComponent(q)}`,
  },
  {
    vendor: "opensooq",
    label: "OpenSooq",
    build: (q) => `https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=${encodeURIComponent(q)}`,
  },
];

/**
 * A short, shop-friendly query for one price row. Drops the noisy words a
 * search box does not need, keeping the brand and the spec.
 */
const NOISE = /^(assorted|models|match|the|exact|part|number|labour|labor|estimate|policy|reference|rate|used|new|each|and|per|for|of)$/i;

export function queryFor(entry: PriceEntry): string {
  const words = `${entry.item} ${entry.spec}`
    .replace(/[–—/\\()[\],.;:]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !NOISE.test(w));
  return words.slice(0, 7).join(" ").trim() || entry.item;
}

/** Every way to reach this row's price on the live web. */
export function retailLinks(entry: PriceEntry): RetailLink[] {
  const links: RetailLink[] = [];
  if (entry.url) {
    links.push({ label: entry.vendor ?? "Vendor", url: entry.url, kind: "product" });
  }
  const query = queryFor(entry);
  const wanted = entry.vendor?.toLowerCase().includes("gts") ? ["gts"] : ["gts", "opensooq"];
  for (const template of SEARCH_TEMPLATES) {
    if (!wanted.includes(template.vendor)) continue;
    links.push({ label: `${template.label} search`, url: template.build(query), kind: "search" });
  }
  return links;
}

/** Attach links to each price row for the renderer. */
export function priceRowsWithLinks(rows: PriceEntry[]): (PriceEntry & { links: RetailLink[]; query: string })[] {
  return rows.map((row) => ({ ...row, links: retailLinks(row), query: queryFor(row) }));
}
