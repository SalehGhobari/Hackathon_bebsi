import type { RawListing } from "../types";

/**
 * Live refresh is opt-in and user-initiated. It fetches public category pages
 * only — no account, no cookies, no personal data. Six requests, 400 ms apart.
 */
export const MARKET_SOURCES = [
  { page: "Parts", url: "https://jo.opensooq.com/en/computers-and-laptops/computer-parts-and-components" },
  { page: "Batteries", url: "https://jo.opensooq.com/en/computers-and-laptops/batteries" },
  { page: "Chargers", url: "https://jo.opensooq.com/en/computers-and-laptops/chargers" },
  { page: "Computers", url: "https://jo.opensooq.com/en/computers-and-laptops/computers" },
  { page: "Cooling", url: "https://jo.opensooq.com/en/computers-and-laptops/fans-and-cooling" },
  { page: "Accessories", url: "https://jo.opensooq.com/en/computers-and-laptops/accessories" },
  { page: "Search: SSD", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=ssd" },
  { page: "Search: NVMe", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=nvme" },
  { page: "Search: RAM laptop", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=ram%20laptop" },
  { page: "Search: DDR4", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=ddr4" },
  { page: "Search: DDR5", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=ddr5" },
  { page: "Search: battery laptop", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=battery%20laptop" },
  { page: "Search: charger laptop", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=charger%20laptop" },
  { page: "Search: thermal paste", url: "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=thermal%20paste" },
];

const USER_AGENT = "Fahes/0.1 (local hardware price check; contact: local app user)";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|[a-z]+);/gi, (full, code: string) => {
    if (code.startsWith("#")) {
      const n = Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : full;
    }
    return ENTITIES[code.toLowerCase()] ?? full;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parsePrice(raw: string): number | null {
  const cleaned = decodeEntities(raw).replace(/,/g, "");
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePage(html: string, page: string, sourceUrl: string, capturedAt: string): RawListing[] {
  const prices: { index: number; price: number }[] = [];
  const priceRe = /redColor bold font-18">([^<]+)<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = priceRe.exec(html))) {
    const price = parsePrice(match[1]);
    if (price !== null) prices.push({ index: match.index, price });
  }

  const out: RawListing[] = [];
  for (let i = 0; i < prices.length; i += 1) {
    const { index, price } = prices[i];
    const end = prices[i + 1]?.index ?? index + 5000;
    const segment = html.slice(index, Math.min(end, index + 5000));

    const before = html.slice(Math.max(0, index - 8000), index);
    const links = [...before.matchAll(/href="\/en\/search\/(\d+)"/g)];
    const link = links[links.length - 1];
    if (!link) continue;

    const titleMatch = segment.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    if (!title) continue;

    const area = segment.match(/locationText[^>]*>([^<]+)<$/m)?.[1] ?? segment.match(/locationText[^>]*>([^<]+)</)?.[1];
    const category = segment.match(/cat2Label">([^<]+)</)?.[1];
    const condition = segment.match(/alt="(New|Used)"/i)?.[1]?.toLowerCase();

    out.push({
      id: link[1],
      url: `https://jo.opensooq.com/en/search/${link[1]}`,
      title,
      priceJod: price,
      condition: condition ?? "unknown",
      area: area ? decodeEntities(area).trim() : "",
      oqCategory: category ? decodeEntities(category).trim() : "",
      page,
      capturedAt,
    });
  }

  return out;
}

/** Build the public search URL for a free-text query. */
export function marketQueryUrl(term: string): string {
  return `https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=${encodeURIComponent(term.trim())}`;
}

/**
 * Live search for one term.
 *
 * This is the on-demand path: the bundled snapshot is frozen at whatever was
 * captured, so a specific part is often missing from it. A single request per
 * query keeps it polite, and callers fall back to the snapshot when this
 * returns nothing (offline, blocked, or a term with no hits).
 */
export async function fetchMarketQuery(
  term: string,
): Promise<{ listings: RawListing[]; sources: string[]; url: string }> {
  const url = marketQueryUrl(term);
  const capturedAt = new Date().toISOString().slice(0, 10);
  const listings: RawListing[] = [];

  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (res.ok) {
      const html = await res.text();
      const seen = new Set<string>();
      for (const listing of parsePage(html, `Search: ${term}`, url, capturedAt)) {
        if (seen.has(listing.id)) continue;
        seen.add(listing.id);
        listings.push(listing);
      }
    }
  } catch {
    // Offline or blocked: the caller keeps the snapshot.
  }

  return { listings, sources: [url], url };
}

export async function fetchMarketListings(): Promise<{ listings: RawListing[]; sources: string[] }> {
  const capturedAt = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const listings: RawListing[] = [];

  for (const source of MARKET_SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const html = await res.text();
      for (const listing of parsePage(html, source.page, source.url, capturedAt)) {
        if (seen.has(listing.id)) continue;
        seen.add(listing.id);
        listings.push(listing);
      }
    } catch {
      // Offline or blocked: keep the existing snapshot rather than failing the refresh.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return { listings, sources: MARKET_SOURCES.map((s) => s.url) };
}
