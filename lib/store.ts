import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import seedPrices from "../data/prices.json";
import recyclerData from "../data/recyclers.json";
import marketSnapshot from "../data/market-snapshot.json";
import { detectDevice } from "./detect";
import { assess } from "./health";
import { advise, type Advice } from "./advisor";
import { buildPassport } from "./passport";
import { mergeMaterials } from "./green";
import { buildMarket, fetchMarketListings, requirementsFrom } from "./market";
import { ocrImage } from "./market/ocr";
import { parseListing } from "./market/parse";
import type {
  ActionRecord,
  Device,
  Diagnostic,
  Ledger,
  MarketResponse,
  MaterialAmount,
  Passport,
  PhotoRead,
  PhotoSpecs,
  PriceEntry,
  RawListing,
  Recycler,
  WipeRecord,
} from "./types";

const SEED_VERSION = 3;

type Data = {
  devices: Device[];
  diagnostics: Diagnostic[];
  actions: ActionRecord[];
  prices: PriceEntry[];
  wipes: WipeRecord[];
  seedVersion?: number;
};

const EMPTY: Data = { devices: [], diagnostics: [], actions: [], prices: [], wipes: [], seedVersion: SEED_VERSION };

export type DeviceView = {
  device: Device;
  diagnostic: Diagnostic | null;
  advice: Advice | null;
  actions: ActionRecord[];
  wipe: WipeRecord | null;
};

export type ScanResult = DeviceView & { summary: string };

type MarketFile = {
  updatedAt: string | null;
  sources: string[];
  listings: RawListing[];
};

const SNAPSHOT = marketSnapshot as {
  capturedAt: string;
  sources: string[];
  listings: RawListing[];
};

export class Store {
  private file: string;
  private data: Data;
  private marketFile: string;
  private marketData: MarketFile;
  private ocrFile: string;
  private ocrData: Record<string, PhotoRead>;

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "fahas-data.json");
    this.marketFile = path.join(dir, "market.json");
    this.data = this.load();
    this.syncSeedData();
    this.marketData = this.loadMarket();
    this.ocrFile = path.join(dir, "market-ocr.json");
    this.ocrData = this.loadOcr();
    this.save();
  }

  private loadOcr(): Record<string, PhotoRead> {
    try {
      if (fs.existsSync(this.ocrFile)) {
        return JSON.parse(fs.readFileSync(this.ocrFile, "utf8")) as Record<string, PhotoRead>;
      }
    } catch {
      /* ignore a corrupt cache: OCR can be re-run */
    }
    return {};
  }

  private saveOcr() {
    const tmp = `${this.ocrFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.ocrData), { mode: 0o600 });
    fs.renameSync(tmp, this.ocrFile);
  }

  /**
   * Read the seller's photo locally. OCR augments the title, it never replaces it:
   * values are stored separately and conflicts are surfaced to the UI.
   */
  async readPhoto(listingId: string): Promise<PhotoRead> {
    const raw = this.marketData.listings.find((l) => l.id === listingId);
    if (!raw) throw new Error("Listing not found in the local snapshot.");
    if (!raw.imageUrl) throw new Error("This listing has no photo.");

    const ocr = await ocrImage(raw.imageUrl);
    if (!ocr.ok) throw new Error(ocr.note ?? "Could not read this photo.");

    const base = parseListing(raw);
    const merged = parseListing({ ...raw, title: `${raw.title} ${ocr.text}` });
    const fields = ["capacityGb", "ramGen", "formFactor", "bus", "watts", "brand"] as const;
    const filled: string[] = [];
    const conflicts: PhotoRead["conflicts"] = [];

    for (const field of fields) {
      const fromTitle = base[field];
      const fromPhoto = merged[field];
      if (fromTitle === null && fromPhoto !== null) filled.push(field);
      else if (fromTitle !== null && fromPhoto !== null && String(fromTitle).toUpperCase() !== String(fromPhoto).toUpperCase()) {
        conflicts.push({ field, title: String(fromTitle), photo: String(fromPhoto) });
      }
    }

    const specs: PhotoSpecs = {
      category: merged.category,
      capacityGb: merged.capacityGb,
      ramGen: merged.ramGen,
      formFactor: merged.formFactor,
      bus: merged.bus,
      watts: merged.watts,
      brand: merged.brand,
    };

    const photo: PhotoRead = {
      listingId,
      imageUrl: raw.imageUrl,
      text: ocr.text,
      confidence: ocr.confidence,
      engine: ocr.engine,
      specs,
      filled,
      conflicts,
      createdAt: new Date().toISOString(),
      note: ocr.note,
    };

    this.ocrData[listingId] = photo;
    this.saveOcr();
    return photo;
  }

  private loadMarket(): MarketFile {
    if (fs.existsSync(this.marketFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.marketFile, "utf8")) as Partial<MarketFile>;
        if (Array.isArray(parsed.listings) && parsed.listings.length > 0) {
          return {
            updatedAt: parsed.updatedAt ?? null,
            sources: parsed.sources ?? [],
            listings: parsed.listings,
          };
        }
      } catch {
        /* fall back to the shipped snapshot */
      }
    }
    return {
      updatedAt: SNAPSHOT.capturedAt,
      sources: SNAPSHOT.sources,
      listings: SNAPSHOT.listings,
    };
  }

  private saveMarket() {
    const tmp = `${this.marketFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.marketData), { mode: 0o600 });
    fs.renameSync(tmp, this.marketFile);
  }

  /** Market index for the OpenSooq snapshot, optionally scored against a device. */
  market(deviceId?: string): MarketResponse {
    const view = deviceId ? this.view(deviceId) : null;
    const requirements = view ? requirementsFrom(view.device, view.diagnostic) : null;
    return buildMarket(
      this.marketData.listings,
      this.marketData.updatedAt,
      this.marketData.sources,
      requirements,
      this.ocrData,
    );
  }

  /** Explicit, user-initiated refresh. Merges new listings; keeps old ones on failure. */
  async refreshMarket(deviceId?: string): Promise<{ added: number; fetched: number; market: MarketResponse }> {
    const { listings, sources } = await fetchMarketListings();
    const known = new Map(this.marketData.listings.map((l) => [l.id, l]));
    let added = 0;
    for (const listing of listings) {
      if (!known.has(listing.id)) added += 1;
      known.set(listing.id, listing);
    }
    if (listings.length > 0) {
      this.marketData = {
        updatedAt: new Date().toISOString().slice(0, 10),
        sources: sources.length ? sources : this.marketData.sources,
        listings: [...known.values()].slice(-1200),
      };
      this.saveMarket();
    }
    return { added, fetched: listings.length, market: this.market(deviceId) };
  }

  private load(): Data {
    if (!fs.existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Data>;
      return {
        devices: parsed.devices ?? [],
        diagnostics: parsed.diagnostics ?? [],
        actions: parsed.actions ?? [],
        prices: parsed.prices ?? [],
        wipes: parsed.wipes ?? [],
        seedVersion: parsed.seedVersion ?? 0,
      };
    } catch {
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return structuredClone(EMPTY);
    }
  }

  /**
   * Real, dated price data ships with the app. When the dataset version changes,
   * replace the price book so stale seeded rows never masquerade as current quotes.
   */
  private syncSeedData() {
    if (this.data.seedVersion === SEED_VERSION) return;
    this.data.prices = structuredClone(seedPrices as PriceEntry[]);
    this.data.seedVersion = SEED_VERSION;
  }

  recyclers(): Recycler[] {
    return recyclerData as Recycler[];
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* windows */
    }
  }

  dataDir(): string {
    return this.dir;
  }

  async scan(options: { demo?: boolean } = {}): Promise<ScanResult> {
    const detection = await detectDevice();
    if (options.demo) applyDemoWear(detection);
    const { health, faults } = assess(detection);
    const advice = advise(detection, health, faults);
    const now = new Date().toISOString();

    const id = detection.serialHash ? `dev-${detection.serialHash}` : `dev-${crypto.randomUUID()}`;
    const existing = this.data.devices.find((d) => d.id === id);
    const name =
      [detection.brand, detection.model].filter(Boolean).join(" ").trim() ||
      (detection.class === "laptop" ? "This laptop" : "This computer");

    const device: Device = {
      id,
      name,
      class: detection.class,
      brand: detection.brand,
      model: detection.model,
      serialHash: detection.serialHash,
      year: existing?.year ?? null,
      notes: existing?.notes ?? "",
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      platform: detection.distro ?? detection.platform,
      hints: detection.hints,
    };

    this.data.devices = [device, ...this.data.devices.filter((d) => d.id !== id)];

    const diagnostic: Diagnostic = {
      id: crypto.randomUUID(),
      deviceId: id,
      createdAt: now,
      cpu: detection.cpu,
      ram: detection.ram,
      disks: detection.disks,
      battery: detection.battery,
      thermal: detection.thermal,
      storage: detection.storage,
      os: detection.os,
      health,
      faults,
      demo: options.demo ?? false,
    };

    this.data.diagnostics = [diagnostic, ...this.data.diagnostics].slice(0, 200);
    this.save();

    return {
      device,
      diagnostic,
      advice,
      actions: this.actionsFor(id),
      wipe: this.wipeFor(id),
      summary: advice.summary,
    };
  }

  listDevices(): Device[] {
    return [...this.data.devices].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  getDevice(id: string): Device | null {
    return this.data.devices.find((d) => d.id === id) ?? null;
  }

  latestDiagnostic(deviceId: string): Diagnostic | null {
    return this.data.diagnostics.find((d) => d.deviceId === deviceId) ?? null;
  }

  actionsFor(deviceId: string): ActionRecord[] {
    return this.data.actions.filter((a) => a.deviceId === deviceId);
  }

  wipeFor(deviceId: string): WipeRecord | null {
    const device = this.getDevice(deviceId);
    if (!device) return null;
    return this.data.wipes.find((w) => w.serialHash === device.serialHash) ?? null;
  }

  view(deviceId: string): DeviceView | null {
    const device = this.getDevice(deviceId);
    if (!device) return null;
    const diagnostic = this.latestDiagnostic(deviceId);
    const advice = diagnostic ? adviseFromDiagnostic(diagnostic, device.class) : null;
    return { device, diagnostic, advice, actions: this.actionsFor(deviceId), wipe: this.wipeFor(deviceId) };
  }

  addAction(deviceId: string, remedyId: string): ActionRecord | null {
    const view = this.view(deviceId);
    if (!view || !view.diagnostic || !view.advice) return null;
    const remedy = view.advice.remedies.find((r) => r.id === remedyId);
    if (!remedy) return null;

    const cost = (remedy.costLow + remedy.costHigh) / 2 + (remedy.laborLow + remedy.laborHigh) / 2;
    const action: ActionRecord = {
      id: crypto.randomUUID(),
      deviceId,
      diagnosticId: view.diagnostic.id,
      remedyId,
      action: remedy.action,
      title: remedy.title,
      cost: Math.round(cost),
      co2eAvoidedKg: remedy.co2eAvoidedKg,
      kgDiverted: remedy.kgDiverted,
      materials: remedy.materials,
      createdAt: new Date().toISOString(),
    };
    this.data.actions.unshift(action);
    this.save();
    return action;
  }

  removeAction(id: string): boolean {
    const before = this.data.actions.length;
    this.data.actions = this.data.actions.filter((a) => a.id !== id);
    if (this.data.actions.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  recordWipe(deviceId: string, method: string, disk: string): WipeRecord | null {
    const device = this.getDevice(deviceId);
    if (!device) return null;
    const record: WipeRecord = {
      claimedAt: new Date().toISOString(),
      method,
      disk,
      serialHash: device.serialHash,
      nonceHash: crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex").slice(0, 32),
      note: "Operator attestation recorded locally. This is not a cryptographic proof of erasure — verify the drive yourself.",
    };
    this.data.wipes.unshift(record);
    this.save();
    return record;
  }

  ledger(): Ledger {
    const actions = this.data.actions;
    const co2eAvoidedKg = Math.round(actions.reduce((s, a) => s + a.co2eAvoidedKg, 0));
    const kgDiverted = Math.round(actions.reduce((s, a) => s + a.kgDiverted, 0) * 10) / 10;
    const materials: MaterialAmount[] = mergeMaterials(actions.flatMap((a) => a.materials));

    const newDevice = this.data.prices.find((p) => p.category === "new-laptop");
    const replacementLow = newDevice?.low ?? 0;
    const jodSaved = Math.round(
      actions.reduce((sum, a) => {
        if (a.co2eAvoidedKg <= 0) return sum;
        return sum + Math.max(0, replacementLow - a.cost);
      }, 0),
    );

    return { devices: this.data.devices.length, actions: actions.length, co2eAvoidedKg, kgDiverted, jodSaved, materials };
  }

  prices(): PriceEntry[] {
    return [...this.data.prices].sort((a, b) => a.category.localeCompare(b.category));
  }

  passport(deviceId: string): Passport | null {
    const view = this.view(deviceId);
    if (!view) return null;
    return buildPassport(view.device, view.diagnostic, view.actions, view.wipe);
  }
}

/**
 * Demo mode: overlays realistic wear on a healthy machine so the advisor can be
 * shown on any laptop. The diagnostic is flagged so the UI never presents it as real.
 */
function applyDemoWear(detection: Awaited<ReturnType<typeof detectDevice>>) {
  detection.class = "laptop";
  detection.battery = {
    present: true,
    designWh: 60,
    fullWh: 34.8,
    healthPct: 58,
    cycles: 812,
    status: "Discharging",
    technology: "lithium-ion",
    note: "SIMULATED for demo mode.",
  };
  if (detection.disks.length === 0) {
    detection.disks = [
      {
        name: "demo0",
        model: "Generic SATA SSD 480 GB",
        sizeGb: 480,
        rotational: false,
        transport: "sata",
        smart: {
          available: true,
          health: "passed",
          temperatureC: 61,
          powerOnHours: 21400,
          enduranceUsedPct: 87,
          mediaErrors: 0,
        },
      },
    ];
  } else {
    detection.disks = detection.disks.map((d, i) =>
      i === 0
        ? {
            ...d,
            smart: { ...d.smart, available: true, enduranceUsedPct: 87, temperatureC: 61, health: "passed" },
          }
        : d,
    );
  }
  detection.thermal = {
    sensors: [{ name: "CPU package (simulated)", valueC: 94 }],
    maxC: 94,
    fanRpm: 5200,
    note: "SIMULATED for demo mode.",
  };
  detection.ram = { ...detection.ram, totalGb: 6 };
  detection.storage = { ...detection.storage, usedPct: 96, freeGb: 6 };
  detection.hints = ["DEMO MODE: sensor values are simulated. Real readings were replaced for this scan."];
}

/** Advice is derived, never stored: it always reflects the current price book. */
function adviseFromDiagnostic(diagnostic: Diagnostic, cls: Device["class"]): Advice {
  return advise({ class: cls, ram: diagnostic.ram, disks: diagnostic.disks }, diagnostic.health, diagnostic.faults);
}
