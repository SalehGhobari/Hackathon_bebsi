import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store";

const store = new Store(path.join(os.tmpdir(), "fahes-market-test"));
const market = store.market();

console.log("=== ALL BUCKETS ===");
for (const b of market.buckets) {
  console.log(`${b.label.padEnd(38)} median ${String(b.median).padStart(6)}  p25-p75 ${b.p25}-${b.p75}  n=${b.n}`);
}

function show(label: string, predicate: (l: (typeof market.listings)[number]) => boolean) {
  const rows = market.listings.filter(predicate);
  console.log(`\n=== ${label}: ${rows.length} ===`);
  for (const l of rows.slice(0, 14)) {
    console.log(
      `  ${String(l.priceJod).padStart(7)} | ${l.category}/${l.variant ?? "-"} | gen=${l.ramGen ?? "-"} cap=${l.capacityGb ?? "-"} form=${l.formFactor ?? "-"} w=${l.watts ?? "-"} | ${l.title.slice(0, 70)}`,
    );
  }
}

show("RAM without generation", (l) => l.category === "ram" && !l.ramGen);
show("RAM with generation", (l) => l.category === "ram" && Boolean(l.ramGen));
show("SSD", (l) => l.category === "ssd");
show("Laptop category", (l) => l.category === "laptop");
