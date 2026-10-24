import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store";
import { tesseractStatus } from "../lib/market/ocr";

async function main() {
  const status = await tesseractStatus();
  console.log("OCR status:", status);
  if (!status.available) {
    console.log("Tesseract missing — skipping image read.");
    return;
  }

  const store = new Store(path.join(os.tmpdir(), "fahas-ocr-test"));
  const market = store.market();
  const preference = ["ram", "ssd", "charger", "battery"];
  const candidates = market.listings
    .filter((l) => l.imageUrl && preference.includes(l.category))
    .sort((a, b) => preference.indexOf(a.category) - preference.indexOf(b.category));
  console.log(`candidates with photos: ${candidates.length}`);
  if (candidates.length === 0) return;

  const forced = process.env.FAHAS_OCR_ID;
  const target = forced ? market.listings.find((l) => l.id === forced) ?? candidates[0] : candidates[0];
  console.log("\nreading:", target.id, "|", target.category, "|", target.title.slice(0, 70));
  console.log("image:", target.imageUrl);

  const started = Date.now();
  const photo = await store.readPhoto(target.id);
  console.log(`took ${Date.now() - started} ms`);
  console.log({
    confidence: photo.confidence,
    engine: photo.engine,
    specs: photo.specs,
    filled: photo.filled,
    conflicts: photo.conflicts,
  });
  console.log("text:", photo.text.slice(0, 300));

  const refreshed = store.market();
  const merged = refreshed.listings.find((l) => l.id === target.id);
  console.log("merged listing:", {
    title: merged?.title.slice(0, 90),
    ramGen: merged?.ramGen,
    capacityGb: merged?.capacityGb,
    formFactor: merged?.formFactor,
    watts: merged?.watts,
    photoChips: merged?.photo?.specs,
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
