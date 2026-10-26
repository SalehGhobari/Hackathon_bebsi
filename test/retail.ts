import assert from "node:assert/strict";
import { marketQueryUrl } from "../lib/market/fetch";
import { priceRowsWithLinks, queryFor, retailLinks } from "../lib/retail";
import type { PriceEntry } from "../lib/types";

/** No network: these cover the URL building and link generation only. */

// --- OpenSooq query URL -----------------------------------------------------
assert.equal(
  marketQueryUrl("nvme 500gb"),
  "https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=nvme%20500gb",
);
assert.equal(
  marketQueryUrl("  رام DDR4  "),
  `https://jo.opensooq.com/en/find?PostSearch%5Bterm%5D=${encodeURIComponent("رام DDR4")}`,
  "the term is trimmed and encoded",
);
assert.ok(marketQueryUrl("a&b=c").includes("%26"), "ampersands are encoded, not injected");

// --- retail query shaping ---------------------------------------------------
const gts: PriceEntry = {
  id: "p-ssd-nvme-500-retail",
  category: "ssd",
  item: "Kingston NV3 500 GB NVMe SSD",
  spec: "M.2 2280, PCIe 4.0",
  low: 89,
  high: 89,
  currency: "JOD",
  kind: "retail",
  vendor: "GTS (gts.jo)",
  city: "Amman",
  source: "GTS product page",
  sourceDate: "2026-10-24",
  url: "https://gts.jo/en/product/kingston-nv3-500gb",
};

const q = queryFor(gts);
assert.ok(q.includes("Kingston"), "the brand survives");
assert.ok(!q.includes(","), "punctuation is stripped");
assert.ok(q.split(" ").length <= 7, "the query stays short enough for a search box");

// separators and filler words must not leak into a shop's search box
const messy: PriceEntry = { ...gts, item: "Laptop battery (aftermarket / used)", spec: "Assorted models — match the exact part number" };
const mq = queryFor(messy);
assert.ok(!/[()/\\\[\]]/.test(mq), `no separators left: ${mq}`);
assert.ok(!/\b(assorted|models|exact|part|number)\b/i.test(mq), `no filler words: ${mq}`);
assert.ok(/battery/i.test(mq), "the useful word survives");

// --- links ------------------------------------------------------------------
const links = retailLinks(gts);
assert.equal(links[0].kind, "product", "the vendor product page comes first");
assert.equal(links[0].url, gts.url);
const search = links.filter((l) => l.kind === "search");
assert.ok(search.length >= 1, "at least one live search link is offered");
assert.ok(
  search.every((l) => l.url.startsWith("https://") && !l.url.includes(" ")),
  "search URLs are absolute and encoded",
);
assert.ok(
  search.some((l) => l.url.startsWith("https://gts.jo/")),
  "a GTS row links to a GTS search",
);

// a row with no product URL still gets a searchable route
const noUrl: PriceEntry = { ...gts, id: "x", url: undefined, vendor: "OpenSooq sellers" };
const bare = retailLinks(noUrl);
assert.equal(bare.filter((l) => l.kind === "product").length, 0);
assert.ok(bare.some((l) => l.kind === "search"), "still reachable without a product URL");

// the labour/policy rows that ship as `estimate` should still produce something
const labour: PriceEntry = {
  ...gts,
  id: "p-labor",
  item: "Shop diagnosis and cleaning",
  spec: "Labour estimate",
  kind: "estimate",
  vendor: undefined,
  url: undefined,
};
assert.ok(retailLinks(labour).length > 0);

// --- the renderer payload ---------------------------------------------------
const rows = priceRowsWithLinks([gts, noUrl]);
assert.equal(rows.length, 2);
assert.ok(rows.every((r) => Array.isArray(r.links) && typeof r.query === "string"));
assert.equal(rows[0].links[0].url, gts.url);

console.log("retail tests passed");
