import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store";
import { renderRecycleHtml } from "../electron/recycle-pdf";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fahes-stash-test-"));
  const store = new Store(dir);
  const scan = await store.scan({ demo: true });
  const candidates = store.candidates(scan.device.id);
  assert.ok(candidates.length > 0, "a demo scan should offer stash candidates");

  const recycle = candidates.find((c) => c.kind === "recycle" && c.category === "battery");
  const replace = candidates.find((c) => c.kind === "replace" && c.category === "ram");
  assert.ok(recycle && replace, "demo scan should offer battery recycle and RAM replace");

  const rec = store.addStash({
    ...recycle,
    source: "local",
    deviceId: scan.device.id,
    deviceClass: scan.device.class,
  });
  const rep = store.addStash({
    ...replace,
    source: "local",
    deviceId: scan.device.id,
    deviceClass: scan.device.class,
  });
  assert.equal(store.listStash().length, 2);
  assert.ok(rec.impact.kgDiverted > 0, "recycle items carry a mass estimate");
  assert.equal(rec.kind, "recycle");
  assert.equal(rep.kind, "replace");

  store.setStashPhoto(rec.id, fs.readFileSync("build/icon.png"), "image/png");
  const batch = store.recycleBatch(store.recyclers()[0].id, [rec.id], "test pickup");
  assert.equal(batch.items.length, 1);
  assert.ok(batch.items[0].photoDataUrl?.startsWith("data:image/png;base64,"));
  const html = renderRecycleHtml(batch, "en");
  assert.ok(html.includes("E-waste recycling manifest"));
  assert.ok(html.includes(store.recyclers()[0].name));

  store.markRecycled([rec.id]);
  const ledger = store.ledger();
  assert.equal(ledger.recycled, 1);
  assert.equal(ledger.stashedRecycle, 0);
  assert.ok(ledger.kgDiverted > 0);

  store.markStash(rep.id, "replaced", { listingId: "test", title: "Test RAM", priceJod: 20, url: "https://example.invalid" });
  assert.equal(store.ledger().replaced, 1);

  store.removeStash(rep.id);
  assert.equal(store.listStash().length, 1);
  console.log("stash test passed:", { candidates: candidates.length, ledger });
}

void main();
