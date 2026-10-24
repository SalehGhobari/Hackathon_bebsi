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
import { DEVICE_MATERIALS, DEVICE_MASS_KG, avoidedManufacturingCo2e, mergeMaterials, scaleMaterials } from "./green";
import { buildMarket, fetchMarketListings, requirementsFrom } from "./market";
import { estimateRecycleByName } from "./recycle/estimate";
import { fetchListingImage, type ListingImage } from "./market/images";
import type {
  ActionRecord,
  AddStashInput,
  Device,
  DeviceRequirements,
  Diagnostic,
  Ledger,
  MarketCategory,
  MarketResponse,
  MaterialAmount,
  Passport,
  PriceEntry,
  RawListing,
  RecycleBatch,
  RecycleEstimate,
  Recycler,
  StashCandidate,
  StashImpact,
  StashItem,
  StashKind,
  StashStatus,
  WipeRecord,
} from "./types";

const SEED_VERSION = 4;

type Data = {
  devices: Device[];
  diagnostics: Diagnostic[];
  actions: ActionRecord[];
  prices: PriceEntry[];
  wipes: WipeRecord[];
  stash: StashItem[];
  seedVersion?: number;
};

const EMPTY: Data = {
  devices: [],
  diagnostics: [],
  actions: [],
  prices: [],
  wipes: [],
  stash: [],
  seedVersion: 0,
};

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
  private photosDir: string;

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "fahes-data.json");
    this.marketFile = path.join(dir, "market.json");
    this.photosDir = path.join(dir, "photos");
    fs.mkdirSync(this.photosDir, { recursive: true });
    this.data = this.load();
    this.syncSeedData();
    this.marketData = this.loadMarket();
    this.save();
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

  /** Market index for the OpenSooq snapshot, optionally scored against a device or a stashed replacement item. */
  market(target?: string | { deviceId?: string; stashId?: string }): MarketResponse {
    const requirements = this.requirementsFor(target);
    return buildMarket(this.marketData.listings, this.marketData.updatedAt, this.marketData.sources, requirements);
  }

  private requirementsFor(target?: string | { deviceId?: string; stashId?: string }): DeviceRequirements | null {
    if (!target) return null;
    if (typeof target === "string") {
      const view = this.view(target);
      return view ? requirementsFrom(view.device, view.diagnostic) : null;
    }
    if (target.stashId) {
      const item = this.stashItem(target.stashId);
      const req = item?.requirements ?? null;
      if (!item || !req) return null;
      if (item.category === "ram") return { ...req, storageBus: null, storageForm: null, model: null };
      if (item.category === "ssd" || item.category === "hdd") {
        return { ...req, ramGen: null, ramForm: null, model: null };
      }
      if (["battery", "charger", "cooling", "gpu", "keyboard", "other"].includes(item.category)) {
        return { ...req, ramGen: null, ramForm: null, storageBus: null, storageForm: null, model: null };
      }
      if (["laptop", "desktop"].includes(item.category)) return null;
      return req;
    }
    if (target.deviceId) {
      const view = this.view(target.deviceId);
      return view ? requirementsFrom(view.device, view.diagnostic) : null;
    }
    return null;
  }

  /** Fetch one listing photo on demand (cache-first). */
  async image(listingId: string): Promise<ListingImage> {
    const listing = this.marketData.listings.find((l) => l.id === listingId);
    if (!listing) throw new Error("Listing not found in the local snapshot.");
    if (!listing.imageUrl) throw new Error("This listing has no photo.");
    return fetchListingImage(listing.imageUrl, path.join(this.dir, "images"));
  }

  /** Explicit, user-initiated refresh. Merges new listings; keeps old ones on failure. */
  async refreshMarket(
    target?: string | { deviceId?: string; stashId?: string },
  ): Promise<{ added: number; fetched: number; market: MarketResponse }> {
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
    return { added, fetched: listings.length, market: this.market(target) };
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
        stash: parsed.stash ?? [],
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
    // Also reseed if a previous build wrote the current version with an empty price book.
    if (this.data.seedVersion === SEED_VERSION && this.data.prices.length > 0) return;
    this.data.prices = structuredClone(seedPrices as PriceEntry[]);
    this.data.seedVersion = SEED_VERSION;
  }

  recyclers(): Recycler[] {
    return recyclerData as Recycler[];
  }

  /* ---------------- recycle / replace stash ---------------- */

  listStash(kind?: StashKind): StashItem[] {
    const items = kind ? this.data.stash.filter((i) => i.kind === kind) : [...this.data.stash];
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stashItem(id: string): StashItem | null {
    return this.data.stash.find((i) => i.id === id) ?? null;
  }

  /** Components and whole devices from the latest scan, offered as recycle/replace actions. */
  candidates(deviceId: string): StashCandidate[] {
    const view = this.view(deviceId);
    if (!view?.diagnostic) return [];
    const { device, diagnostic } = view;
    const cls = device.class;
    const overall = diagnostic.health.overall ?? "unknown";
    const req = requirementsFrom(device, diagnostic);
    const out: StashCandidate[] = [];

    const push = (
      kind: StashKind,
      key: string,
      title: string,
      category: string,
      detail: string,
      marketCategory: MarketCategory | null,
      requirements: DeviceRequirements | null = null,
    ) => {
      out.push({
        key: `${key}:${kind}`,
        kind,
        title,
        category,
        detail,
        marketCategory,
        requirements,
        impact: impactForStash(kind, category, cls, 1),
      });
    };

    const deviceMarket: MarketCategory | null = cls === "laptop" ? "laptop" : cls === "desktop" ? "desktop" : null;
    push("recycle", "device", device.name, cls, `${cls} · whole device · health ${overall}/100`, deviceMarket, null);
    push("replace", "device", device.name, cls, `${cls} · whole device · health ${overall}/100`, deviceMarket, null);

    if (diagnostic.battery.present) {
      const b = diagnostic.battery;
      const detail = `${b.healthPct ?? "?"}% health · ${b.cycles ?? "?"} cycles · ${b.status ?? "status unknown"}`;
      push("recycle", "battery", "Battery", "battery", detail, "battery", null);
      push("replace", "battery", "Battery", "battery", detail, "battery", null);
    }

    for (const disk of diagnostic.disks) {
      const category = disk.rotational ? "hdd" : "ssd";
      const detail = `${disk.model} · ${disk.sizeGb} GB · SMART ${disk.smart.health}`;
      const diskReq: DeviceRequirements = {
        ...req,
        storageBus: /nvme/i.test(disk.transport) ? "NVMe" : /sata/i.test(disk.transport) ? "SATA" : req.storageBus,
        storageForm: /nvme/i.test(disk.transport) ? "M.2" : /sata/i.test(disk.transport) ? '2.5"' : req.storageForm,
      };
      push("recycle", `disk-${disk.name}`, disk.model || "Drive", category, detail, category, diskReq);
      push("replace", `disk-${disk.name}`, disk.model || "Drive", category, detail, category, diskReq);
    }

    const ramDetail = `${diagnostic.ram.totalGb} GB · ${diagnostic.ram.type ?? "type unknown"} · ${diagnostic.ram.formFactor ?? "form unknown"}`;
    push("replace", "ram", "Memory", "ram", ramDetail, "ram", req);

    if (diagnostic.thermal.maxC !== null || diagnostic.thermal.fanRpm !== null) {
      const detail = `${diagnostic.thermal.maxC ?? "?"}°C max · ${diagnostic.thermal.fanRpm ?? "?"} rpm`;
      push("replace", "cooling", "Cooling", "cooling", detail, "cooling", null);
    }

    return out;
  }

  addStash(input: AddStashInput): StashItem {
    const title = input.title.trim();
    if (!title) throw new Error("A stash item needs a title.");
    const quantity = Math.max(1, Math.min(99, Math.round(input.quantity ?? 1)));
    const now = new Date().toISOString();
    const parsedAdded = input.addedAt ? new Date(`${input.addedAt}T12:00:00`) : null;
    const createdAt = parsedAdded && !Number.isNaN(parsedAdded.getTime()) ? parsedAdded.toISOString() : now;
    const item: StashItem = {
      id: `stash-${crypto.randomUUID()}`,
      kind: input.kind,
      status: "stashed",
      source: input.source,
      title,
      category: (input.category || "other").trim(),
      detail: (input.detail ?? "").trim(),
      deviceId: input.deviceId ?? null,
      serialHash: input.serialHash ?? null,
      deviceClass: input.deviceClass ?? null,
      quantity,
      notes: (input.notes ?? "").trim(),
      photoFile: null,
      photoMime: null,
      requirements: input.requirements ?? null,
      marketCategory: input.marketCategory ?? null,
      impact: input.impact
        ? scaleImpact(input.impact, quantity)
        : impactForStash(input.kind, input.category || "other", input.deviceClass ?? null, quantity),
      replacedWith: null,
      createdAt,
      updatedAt: now,
    };
    this.data.stash.unshift(item);
    this.save();
    return item;
  }

  /** Estimate weight and recoverable materials from a typed name. */
  estimateRecycle(name: string, category?: string, quantity = 1): RecycleEstimate {
    const est = estimateRecycleByName(name, category);
    const q = Math.max(1, Math.min(99, Math.round(quantity)));
    return {
      category: est.category,
      confidence: est.confidence,
      basis: est.basis,
      impact: {
        co2eAvoidedKg: 0,
        kgDiverted: roundImpact(est.kg * q),
        materials: scaleMaterials(est.materials, q),
      },
      unitImpact: {
        co2eAvoidedKg: 0,
        kgDiverted: roundImpact(est.kg),
        materials: est.materials,
      },
    };
  }

  updateStash(
    id: string,
    patch: Partial<
      Pick<
        StashItem,
        "title" | "category" | "detail" | "notes" | "quantity" | "marketCategory" | "requirements" | "createdAt" | "impact"
      >
    >,
  ): StashItem | null {
    const item = this.stashItem(id);
    if (!item) return null;
    const oldCategory = item.category;
    const oldQuantity = item.quantity;
    if (patch.title !== undefined && patch.title.trim()) item.title = patch.title.trim();
    if (patch.category !== undefined) item.category = patch.category.trim() || item.category;
    if (patch.detail !== undefined) item.detail = patch.detail.trim();
    if (patch.notes !== undefined) item.notes = patch.notes;
    if (patch.marketCategory !== undefined) item.marketCategory = patch.marketCategory;
    if (patch.requirements !== undefined) item.requirements = patch.requirements;
    if (patch.quantity !== undefined) {
      item.quantity = Math.max(1, Math.min(99, Math.round(patch.quantity)));
    }
    if (patch.impact) {
      item.impact = patch.impact;
    } else if (item.category !== oldCategory || item.quantity !== oldQuantity) {
      // Category and quantity both feed the mass/material estimate; recompute rather than scale stale numbers.
      item.impact = impactForStash(item.kind, item.category, item.deviceClass, item.quantity);
    }
    if (patch.createdAt) {
      const parsed = new Date(`${patch.createdAt}T12:00:00`);
      if (!Number.isNaN(parsed.getTime())) item.createdAt = parsed.toISOString();
    }
    item.updatedAt = new Date().toISOString();
    this.save();
    return item;
  }

  removeStash(id: string): boolean {
    const item = this.stashItem(id);
    if (!item) return false;
    this.data.stash = this.data.stash.filter((i) => i.id !== id);
    if (item.photoFile) {
      try {
        fs.unlinkSync(path.join(this.dir, item.photoFile));
      } catch {
        /* photo already gone */
      }
    }
    this.save();
    return true;
  }

  setStashPhoto(id: string, data: Buffer, mime: string): StashItem | null {
    const item = this.stashItem(id);
    if (!item) return null;
    const ext = mime === "image/png" ? "png" : "jpg";
    const rel = path.join("photos", `${item.id}.${ext}`);
    fs.writeFileSync(path.join(this.dir, rel), data, { mode: 0o600 });
    if (item.photoFile && item.photoFile !== rel) {
      try {
        fs.unlinkSync(path.join(this.dir, item.photoFile));
      } catch {
        /* old photo already gone */
      }
    }
    item.photoFile = rel;
    item.photoMime = mime;
    item.updatedAt = new Date().toISOString();
    this.save();
    return item;
  }

  stashPhotoDataUrl(id: string): string | null {
    const item = this.stashItem(id);
    if (!item?.photoFile || !item.photoMime) return null;
    try {
      const buf = fs.readFileSync(path.join(this.dir, item.photoFile));
      return `data:${item.photoMime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }

  markStash(
    id: string,
    status: Exclude<StashStatus, "stashed">,
    replacedWith?: StashItem["replacedWith"],
  ): StashItem | null {
    const item = this.stashItem(id);
    if (!item) return null;
    item.status = status;
    if (replacedWith) item.replacedWith = replacedWith;
    item.updatedAt = new Date().toISOString();
    this.save();
    return item;
  }

  /** Everything currently waiting in the recycle stash, with photos inlined for the PDF. */
  recycleBatch(recyclerId: string, itemIds?: string[], note = ""): RecycleBatch {
    const recycler = this.recyclers().find((r) => r.id === recyclerId);
    if (!recycler) throw new Error("Choose a recycling partner first.");
    const wanted = itemIds?.length ? new Set(itemIds) : null;
    const items = this.data.stash.filter(
      (i) => i.kind === "recycle" && i.status === "stashed" && (!wanted || wanted.has(i.id)),
    );
    if (!items.length) throw new Error("Nothing to recycle yet — add an item to the recycle stash first.");
    const materials = mergeMaterials(items.flatMap((i) => i.impact.materials));
    return {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      recycler,
      items: items.map((i) => ({ ...i, photoDataUrl: this.stashPhotoDataUrl(i.id) })),
      note,
      totals: {
        items: items.reduce((n, i) => n + i.quantity, 0),
        kgDiverted: Math.round(items.reduce((n, i) => n + i.impact.kgDiverted, 0) * 100) / 100,
        co2eAvoidedKg: Math.round(items.reduce((n, i) => n + i.impact.co2eAvoidedKg, 0)),
        materials,
      },
    };
  }

  markRecycled(ids: string[]): number {
    const set = new Set(ids);
    let count = 0;
    for (const item of this.data.stash) {
      if (item.kind === "recycle" && item.status === "stashed" && set.has(item.id)) {
        item.status = "recycled";
        item.updatedAt = new Date().toISOString();
        count += 1;
      }
    }
    if (count) this.save();
    return count;
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
    const done = this.data.stash.filter((i) => i.status !== "stashed");
    const co2eAvoidedKg = Math.round(
      done.reduce((s, i) => s + i.impact.co2eAvoidedKg, 0) + actions.reduce((s, a) => s + a.co2eAvoidedKg, 0),
    );
    const kgDiverted =
      Math.round((done.reduce((s, i) => s + i.impact.kgDiverted, 0) + actions.reduce((s, a) => s + a.kgDiverted, 0)) * 100) / 100;
    const materials: MaterialAmount[] = mergeMaterials([
      ...done.flatMap((i) => i.impact.materials),
      ...actions.flatMap((a) => a.materials),
    ]);

    const newDevice = this.data.prices.find((p) => p.category === "new-laptop");
    const replacementLow = newDevice?.low ?? 0;
    const jodSaved = Math.round(
      actions.reduce((sum, a) => {
        if (a.co2eAvoidedKg <= 0) return sum;
        return sum + Math.max(0, replacementLow - a.cost);
      }, 0),
    );

    return {
      devices: this.data.devices.length,
      actions: done.length + actions.length,
      co2eAvoidedKg,
      kgDiverted,
      jodSaved,
      materials,
      stashedRecycle: this.data.stash.filter((i) => i.kind === "recycle" && i.status === "stashed").length,
      stashedReplace: this.data.stash.filter((i) => i.kind === "replace" && i.status === "stashed").length,
      recycled: this.data.stash.filter((i) => i.status === "recycled").length,
      replaced: this.data.stash.filter((i) => i.status === "replaced").length,
    };
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
            smart: { ...d.smart, available: true, enduranceUsedPct: 97, temperatureC: 61, health: "failed", mediaErrors: 12 },
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
  detection.ram = { ...detection.ram, totalGb: 6, type: "DDR4", formFactor: "SO-DIMM", assumed: false };
  detection.storage = { ...detection.storage, usedPct: 96, freeGb: 6 };
  detection.hints = ["DEMO MODE: sensor values are simulated. Real readings were replaced for this scan."];
}

/** Advice is derived, never stored: it always reflects the current price book. */
function adviseFromDiagnostic(diagnostic: Diagnostic, cls: Device["class"]): Advice {
  return advise({ class: cls, ram: diagnostic.ram, disks: diagnostic.disks }, diagnostic.health, diagnostic.faults);
}

/* ---------------- stash impact helpers ---------------- */

/** Indicative mass for common e-waste categories, in kilograms. */
const COMPONENT_MASS_KG: Record<string, number> = {
  laptop: 2,
  desktop: 8,
  battery: 0.3,
  ssd: 0.1,
  hdd: 0.3,
  ram: 0.05,
  charger: 0.3,
  cooling: 0.2,
  gpu: 1.2,
  cpu: 0.1,
  motherboard: 0.6,
  keyboard: 0.5,
  usb: 0.05,
  "lan-device": 1,
  printer: 8,
  router: 1,
  phone: 0.2,
  monitor: 4,
  other: 0.5,
};

const COMPONENT_MATERIALS: Record<string, MaterialAmount[]> = {
  battery: [
    { name: "Lithium", grams: 30 },
    { name: "Cobalt", grams: 20 },
    { name: "Copper", grams: 10 },
    { name: "Aluminium", grams: 20 },
  ],
  ssd: [
    { name: "Copper", grams: 15 },
    { name: "Aluminium", grams: 20 },
    { name: "Rare earths", grams: 1 },
    { name: "Gold", grams: 0.02 },
  ],
  hdd: [
    { name: "Aluminium", grams: 100 },
    { name: "Copper", grams: 30 },
    { name: "Rare earths", grams: 20 },
    { name: "Gold", grams: 0.01 },
  ],
  ram: [
    { name: "Copper", grams: 15 },
    { name: "Gold", grams: 0.05 },
  ],
  charger: [
    { name: "Copper", grams: 40 },
    { name: "Aluminium", grams: 20 },
  ],
  cooling: [
    { name: "Copper", grams: 50 },
    { name: "Aluminium", grams: 80 },
  ],
  gpu: [
    { name: "Copper", grams: 100 },
    { name: "Aluminium", grams: 150 },
    { name: "Rare earths", grams: 2 },
    { name: "Gold", grams: 0.1 },
  ],
  cpu: [
    { name: "Copper", grams: 30 },
    { name: "Rare earths", grams: 1 },
    { name: "Gold", grams: 0.1 },
  ],
  motherboard: [
    { name: "Copper", grams: 100 },
    { name: "Rare earths", grams: 2 },
    { name: "Gold", grams: 0.1 },
  ],
  keyboard: [{ name: "Copper", grams: 20 }],
  usb: [{ name: "Copper", grams: 5 }],
  "lan-device": [
    { name: "Copper", grams: 50 },
    { name: "Aluminium", grams: 100 },
  ],
  router: [
    { name: "Copper", grams: 50 },
    { name: "Aluminium", grams: 100 },
  ],
  printer: [
    { name: "Copper", grams: 100 },
    { name: "Aluminium", grams: 200 },
  ],
  monitor: [
    { name: "Copper", grams: 100 },
    { name: "Aluminium", grams: 300 },
    { name: "Rare earths", grams: 2 },
  ],
  other: [{ name: "Copper", grams: 50 }],
};

function roundImpact(n: number): number {
  // Small parts (SSD, RAM) need finer resolution than whole devices.
  return n < 1 ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10;
}

function scaleImpact(impact: StashImpact, factor: number): StashImpact {
  return {
    co2eAvoidedKg: roundImpact(impact.co2eAvoidedKg * factor),
    kgDiverted: roundImpact(impact.kgDiverted * factor),
    materials: scaleMaterials(impact.materials, factor),
  };
}

function impactForStash(
  kind: StashKind,
  category: string,
  cls: Device["class"] | null,
  quantity: number,
): StashImpact {
  const q = Math.max(1, quantity);
  if (kind === "replace") {
    const co2e = cls ? avoidedManufacturingCo2e(cls, 2, 0.5) : 0;
    return { co2eAvoidedKg: roundImpact(co2e * q), kgDiverted: 0, materials: [] };
  }

  const classKey = cls ?? "other";
  const unitMass = COMPONENT_MASS_KG[category] ?? DEVICE_MASS_KG[classKey];
  const perUnit =
    COMPONENT_MATERIALS[category] ??
    scaleMaterials(DEVICE_MATERIALS[classKey], unitMass / (DEVICE_MASS_KG[classKey] || 1));
  return {
    co2eAvoidedKg: 0,
    kgDiverted: roundImpact(unitMass * q),
    materials: scaleMaterials(perUnit, q),
  };
}
