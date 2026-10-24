import os from "node:os";
import path from "node:path";
import { detectDevice } from "../lib/detect";
import { assess } from "../lib/health";
import { advise } from "../lib/advisor";
import { Store } from "../lib/store";

async function main() {
  const detection = await detectDevice();
  const { health, faults } = assess(detection);
  const advice = advise(detection, health, faults);

  console.log("=== DETECTION ===");
  console.log({
    platform: detection.platform,
    distro: detection.distro,
    name: `${detection.brand ?? ""} ${detection.model ?? ""}`.trim(),
    class: detection.class,
    cpu: detection.cpu.model,
    cores: `${detection.cpu.physicalCores}c/${detection.cpu.threads}t`,
    ram: detection.ram,
    battery: detection.battery,
    disks: detection.disks.map((d) => ({
      name: d.name,
      model: d.model,
      sizeGb: d.sizeGb,
      transport: d.transport,
      smart: d.smart,
    })),
    thermal: { maxC: detection.thermal.maxC, fanRpm: detection.thermal.fanRpm, sensors: detection.thermal.sensors.length },
    capabilities: detection.capabilities,
    hints: detection.hints,
  });

  console.log("\n=== HEALTH ===");
  console.log({ overall: health.overall, items: health.items.map((i) => `${i.label}: ${i.score ?? "?"}`) });

  console.log("\n=== FAULTS ===");
  console.log(faults.map((f) => `${f.severity.toUpperCase()} · ${f.title}`));

  console.log("\n=== ADVICE ===");
  console.log(advice.summary);
  for (const r of advice.remedies) {
    console.log(
      `[${r.hierarchy}] ${r.title} | part ${r.costLow}-${r.costHigh} JOD | ${r.costPerYear} JOD/yr | CO2 ${r.co2eAvoidedKg}kg | divert ${r.kgDiverted}kg${advice.recommendedId === r.id ? "  <-- recommended" : ""}`,
    );
  }

  console.log("\n=== STORE ===");
  const dir = path.join(os.tmpdir(), "fahas-test-store");
  const store = new Store(dir);
  const scan = await store.scan({ demo: true });

  console.log("\n=== MARKET (OpenSooq snapshot) ===");
  const market = store.market(scan.device.id);
  console.log({
    count: market.count,
    outliers: market.outliers,
    updatedAt: market.updatedAt,
    requirements: market.requirements,
    buckets: market.buckets.slice(0, 8).map((b) => `${b.label}: median ${b.median} JOD (n=${b.n})`),
    categories: Object.fromEntries(
      [...new Set(market.listings.map((l) => l.category))].map((c) => [
        c,
        market.listings.filter((l) => l.category === c).length,
      ]),
    ),
    compat: Object.fromEntries(
      ["compatible", "check", "incompatible"].map((s) => [s, market.listings.filter((l) => l.compatibility.status === s).length]),
    ),
  });
  console.log("sample parse:");
  for (const l of market.listings.filter((x) => x.category === "ram" || x.category === "charger").slice(0, 6)) {
    console.log(`  [${l.category}] ${l.priceJod} JOD | ${l.ramGen ?? ""} ${l.capacityGb ?? ""} ${l.formFactor ?? ""} ${l.watts ?? ""} | ${l.title.slice(0, 60)} | ${l.compatibility.status}`);
  }

  console.log("\n=== DEMO SCAN (simulated wear) ===");
  console.log({
    demo: scan.diagnostic?.demo,
    overall: scan.diagnostic?.health.overall,
    faults: scan.diagnostic?.faults.map((f) => `${f.severity.toUpperCase()} ${f.title}`),
    remedies: scan.advice?.remedies.map((r) => `${r.id} (${r.costPerYear} JOD/yr)`),
    recommended: scan.advice?.recommendedId,
    summary: scan.advice?.summary,
  });

  const action = store.addAction(scan.device.id, scan.advice?.recommendedId ?? "recycle");
  const ledger = store.ledger();
  const passport = store.passport(scan.device.id);
  console.log({
    device: scan.device.name,
    dataDir: dir,
    action: action?.title,
    ledger,
    passportHash: passport?.hash.slice(0, 16),
    qrPayloadBytes: passport ? Buffer.byteLength(JSON.stringify(passport)) : 0,
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
