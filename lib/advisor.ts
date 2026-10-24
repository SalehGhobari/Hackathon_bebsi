import priceData from "../data/prices.json";
import type {
  Confidence,
  DeviceClass,
  DiskInfo,
  Fault,
  HealthReport,
  PriceEntry,
  RamInfo,
  Remedy,
  RemedyAction,
  Safety,
} from "./types";
import { DEVICE_MASS_KG, EMBODIED_CO2E_KG, costPerYear, impactForAction } from "./green";

const BOOK = priceData as PriceEntry[];

export function priceBook(): PriceEntry[] {
  return BOOK;
}

function pick(category: string, match?: (p: PriceEntry) => boolean): PriceEntry | null {
  const candidates = BOOK.filter((p) => p.category === category && (!match || match(p)));
  if (candidates.length === 0) return null;
  return candidates[0];
}

type RemedyInput = {
  id: string;
  action: RemedyAction;
  hierarchy: number;
  title: string;
  description: string;
  cls: DeviceClass;
  part?: PriceEntry | null;
  labor?: PriceEntry | null;
  years: number;
  safety: Safety;
  confidence: Confidence;
  warnings: string[];
  steps: string[];
  materialFactor?: number;
  massKg?: number;
};

function build(input: RemedyInput): Remedy {
  const partLow = input.part?.low ?? 0;
  const partHigh = input.part?.high ?? 0;
  const laborLow = input.labor?.low ?? 0;
  const laborHigh = input.labor?.high ?? 0;
  const totalMid = (partLow + partHigh) / 2 + (laborLow + laborHigh) / 2;
  const years = input.years;
  const impact = impactForAction(input.action, input.cls, years, {
    massKg: input.massKg,
    materialFactor: input.materialFactor,
  });

  return {
    id: input.id,
    action: input.action,
    hierarchy: input.hierarchy,
    title: input.title,
    description: input.description,
    costLow: partLow,
    costHigh: partHigh,
    laborLow,
    laborHigh,
    yearsGained: years,
    costPerYear: years > 0 ? costPerYear(totalMid, years) : 0,
    co2eAvoidedKg: impact.co2eAvoidedKg,
    kgDiverted: impact.kgDiverted,
    materials: impact.materials,
    safety: input.safety,
    confidence: input.confidence,
    priceRefs: [
      ...[input.part, input.labor]
        .filter(Boolean)
        .map(
          (p) =>
            `${(p as PriceEntry).item} — ${(p as PriceEntry).low}–${(p as PriceEntry).high} ${(p as PriceEntry).currency} · ${(p as PriceEntry).kind} · ${(p as PriceEntry).vendor ?? (p as PriceEntry).source} · ${(p as PriceEntry).sourceDate}`,
        ),
      ...(!input.part && input.action !== "service" && input.action !== "recycle" && input.action !== "replace-device"
        ? ["No surveyed price for this part yet — add a real quote in the Price book."]
        : []),
    ],
    warnings: input.warnings,
    steps: input.steps,
  };
}

export type AdvisorInput = {
  class: DeviceClass;
  ram: RamInfo;
  disks: DiskInfo[];
};

function ssdFor(d: AdvisorInput): PriceEntry | null {
  const nvme = d.disks.some((disk) => /nvme/i.test(disk.transport));
  if (nvme) {
    return (
      pick("ssd", (p) => /nvme/i.test(p.item) && /(500|512)/.test(p.item) && p.kind === "retail") ??
      pick("ssd", (p) => /nvme/i.test(p.item))
    );
  }
  return (
    pick("ssd", (p) => /sata/i.test(p.item) && /480/.test(p.item) && p.kind === "retail") ??
    pick("ssd", (p) => /sata/i.test(p.item)) ??
    pick("ssd")
  );
}

function ramFor(d: AdvisorInput): PriceEntry | null {
  const type = d.ram.type ?? "";
  if (/DDR5/i.test(type)) return pick("ram", (p) => /ddr5/i.test(p.item));
  if (/DDR4/i.test(type)) {
    return d.class === "desktop"
      ? pick("ram", (p) => /ddr4 dimm/i.test(p.item)) ?? pick("ram", (p) => /ddr4/i.test(p.item))
      : pick("ram", (p) => /ddr4 so-?dimm 16/i.test(p.item)) ?? pick("ram", (p) => /ddr4/i.test(p.item));
  }
  if (/DDR3/i.test(type)) return pick("ram", (p) => /ddr3/i.test(p.item));
  return null;
}

export type Advice = {
  remedies: Remedy[];
  replacement: { costLow: number; costHigh: number; years: number; costPerYear: number } | null;
  recommendedId: string | null;
  summary: string;
};

export function advise(d: AdvisorInput, health: HealthReport, faults: Fault[]): Advice {
  const cls = d.class;
  const remedies: Remedy[] = [];
  const faultKeys = new Set(faults.map((f) => f.key));
  const laborInstall = pick("labor", (p) => /installation/i.test(p.item));
  const laborBasic = pick("labor", (p) => /diagnosis/i.test(p.item));

  // Battery
  if (faultKeys.has("battery_wear") || faultKeys.has("battery_cycles")) {
    const part = pick("battery", (p) => /generic/i.test(p.item)) ?? pick("battery");
    remedies.push(
      build({
        id: "battery-replace",
        action: "replace-part",
        hierarchy: 2,
        title: "Replace the battery",
        description:
          "A model-matched battery restores runtime for roughly two more years — usually a fraction of a new laptop, and it keeps every other working part in service.",
        cls,
        part,
        labor: laborInstall,
        years: 2,
        safety: "shop",
        confidence: part ? "medium" : "low",
        warnings: [
          "Generic cells often deliver less than the rated capacity. Ask for a model-matched part and a written warranty.",
          "A swollen battery is a fire risk. Stop using the device and take it to an e-waste point — never to household waste.",
        ],
        steps: [
          "Note the exact laptop model and the battery part number before ordering.",
          "Ask the shop to confirm the battery is model-matched, not 'universal'.",
          "After replacement, charge to 100% and discharge once so the gauge recalibrates.",
        ],
      }),
    );
  }

  // Storage wear / failure
  if ([...faultKeys].some((k) => k.startsWith("disk_wear_") || k.startsWith("disk_fail_"))) {
    const part = ssdFor(d);
    remedies.push(
      build({
        id: "storage-replace",
        action: "replace-part",
        hierarchy: 2,
        title: "Replace the failing drive",
        description:
          "Move the machine to a new SSD before the old one loses data. This is the highest-value repair on almost any older laptop.",
        cls,
        part,
        labor: laborInstall,
        years: 3,
        safety: "shop",
        confidence: "high",
        warnings: [
          "Back up your data first — a dying drive can fail during the clone.",
          "Check the physical size (M.2 2242 vs 2280) before buying.",
        ],
        steps: [
          "Back up everything you cannot lose.",
          "Clone the old drive, or do a clean install and restore your files.",
          "Verify the new drive's health after the first week.",
        ],
      }),
    );
  }

  // HDD -> SSD
  if ([...faultKeys].some((k) => k.startsWith("disk_hdd_"))) {
    const part = pick("ssd", (p) => /sata/i.test(p.item)) ?? pick("ssd");
    remedies.push(
      build({
        id: "storage-upgrade",
        action: "upgrade",
        hierarchy: 2,
        title: "Upgrade to an SSD",
        description:
          "The single best upgrade for an older machine: near-instant boot, quieter, cooler, and far more resistant to drops than a mechanical drive.",
        cls,
        part,
        labor: laborInstall,
        years: 3,
        safety: "diy",
        confidence: "high",
        warnings: ["Back up first. A 2.5\" SATA SSD will not fit where only M.2 exists."],
        steps: [
          "Confirm whether the machine takes 2.5\" SATA or M.2.",
          "Clone the old disk or reinstall the system.",
          "Keep the old drive as an external backup once it is wiped.",
        ],
      }),
    );
  }

  // Disk full only
  if (faultKeys.has("disk_free") && ![...faultKeys].some((k) => k.startsWith("disk_wear_"))) {
    remedies.push(
      build({
        id: "storage-cleanup",
        action: "service",
        hierarchy: 1,
        title: "Free up space before buying anything",
        description:
          "Moving large files, clearing caches and removing unused applications costs nothing and often buys another year of comfortable use.",
        cls,
        part: null,
        labor: laborBasic,
        years: 1,
        safety: "diy",
        confidence: "high",
        warnings: ["Do not delete system folders or the recovery partition."],
        steps: [
          "Find the largest folders and move personal media to external storage.",
          "Clear package caches and old installers.",
          "Empty the trash, then reboot and re-check free space.",
        ],
      }),
    );
  }

  // Thermal
  if (faultKeys.has("thermal_high") || faultKeys.has("fan_stopped")) {
    const paste = pick("thermal-paste");
    const fan = faultKeys.has("fan_stopped") ? pick("fan") : null;
    remedies.push(
      build({
        id: "thermal-service",
        action: "service",
        hierarchy: 1,
        title: fan ? "Clean the cooling system and check the fan" : "Clean the cooling system and renew thermal paste",
        description:
          "Dust blockage and dried paste are the usual reasons a working laptop throttles, gets loud, and feels slow. Servicing is cheap and restores performance without new hardware.",
        cls,
        part: fan ?? paste,
        labor: laborBasic,
        years: 2,
        safety: "shop",
        confidence: "medium",
        warnings: [
          "Opening the chassis can void a warranty.",
          "Disconnect the battery before touching the fan or heatsink.",
        ],
        steps: [
          "Power off and disconnect the battery.",
          "Clear dust from the fan and vents with compressed air.",
          "Renew thermal paste if you are comfortable removing the heatsink; otherwise ask the shop.",
          "Re-check idle temperatures afterwards.",
        ],
      }),
    );
  }

  // RAM
  if (faultKeys.has("ram_low")) {
    const part = ramFor(d);
    remedies.push(
      build({
        id: "ram-upgrade",
        action: "upgrade",
        hierarchy: 2,
        title: "Add memory",
        description:
          "More RAM stops the machine from swapping to disk. It is usually the cheapest way to make an old laptop feel modern again.",
        cls,
        part,
        labor: laborInstall,
        years: 3,
        safety: "diy",
        confidence: d.ram.assumed ? "low" : "medium",
        warnings: [
          d.ram.assumed
            ? "Memory type was inferred from the CPU platform. Confirm the exact type and slot count before buying."
            : "Confirm the slot count and maximum supported capacity.",
          "Some laptops have soldered memory and cannot be upgraded.",
        ],
        steps: [
          "Check the exact RAM generation, form factor and maximum capacity.",
          "Power off, unplug, and disconnect the battery.",
          "Match pairs where possible for better performance.",
        ],
      }),
    );
  }

  // Recycling is always shown, as the last resort.
  const disposal = pick("disposal");
  const mass = DEVICE_MASS_KG[cls];
  const disposalFee = disposal ? Math.round(disposal.low * mass * 10) / 10 : null;
  remedies.push(
    build({
      id: "recycle",
      action: "recycle",
      hierarchy: 4,
      title: "Recycle it properly",
      description: `Last resort, and only after the repairs above have been ruled out. Amman recyclers such as E-Tafkeek and Al Nasser Group accept computers, boards and batteries; E-Tafkeek also buys usable parts and arranges collection; ask the recycler you call whether they collect. The MOENV reference rate is 100 JOD/ton${disposalFee !== null ? ` — about ${disposalFee} JOD for a ${mass} kg device` : ""}; confirm what applies to a household pickup.`,
      cls,
      part: null,
      years: 0,
      safety: "shop",
      confidence: "high",
      massKg: DEVICE_MASS_KG[cls],
      warnings: [
        "Back up and wipe the drive before handing the device over.",
        "Never put lithium batteries in household waste.",
        "Informal burning of cables recovers copper at a serious health cost — use a proper collection point.",
        "Call E-Tafkeek first: ask what they accept and whether the MOENV fee applies to your quantity.",
      ],
      steps: [
        "Back up your data, then wipe the drive and keep the certificate.",
        "Remove and separately dispose of the battery.",
        "Call a recycler with a rough count and photos — E-Tafkeek arranges collection; confirm the others first.",
        "Ask for data destruction in writing if the drive is handed over un-wiped.",
      ],
    }),
  );

  // Replacement baseline, for comparison only.
  const newLaptop = pick(cls === "desktop" ? "new-laptop" : "new-laptop");
  const replacement = newLaptop
    ? {
        costLow: newLaptop.low,
        costHigh: newLaptop.high,
        years: 4,
        costPerYear: costPerYear((newLaptop.low + newLaptop.high) / 2, 4),
      }
    : null;

  if (replacement) {
    remedies.push(
      build({
        id: "replace-device",
        action: "replace-device",
        hierarchy: 5,
        title: "Replace the whole device",
        description: `A new machine costs about ${newLaptop?.low}–${newLaptop?.high} JOD and carries roughly ${EMBODIED_CO2E_KG[cls].mid} kg CO2e before it is even switched on. Compare its cost per year with the repairs above.`,
        cls,
        part: newLaptop,
        labor: null,
        years: 4,
        safety: "shop",
        confidence: "high",
        warnings: ["Manufacturing a new laptop usually outweighs any efficiency gain."],
        steps: [
          "Compare cost per year, not sticker price.",
          "If you replace it, recycle the old one and wipe the drive.",
        ],
      }),
    );
  }

  const sorted = remedies.sort((a, b) => a.hierarchy - b.hierarchy || a.costPerYear - b.costPerYear);
  const replacementYear = replacement?.costPerYear ?? Infinity;
  const repairable = sorted.filter((r) => r.hierarchy <= 2 && r.costPerYear <= replacementYear);
  const recommendedId = repairable.length > 0 ? repairable[0].id : null;

  let summary: string;
  if (faults.length === 0) {
    summary = "Nothing needs replacing. Keep it clean, back it up, and it should stay useful for a while.";
  } else if (recommendedId === "recycle") {
    summary = "The repair cost no longer makes sense. Recycle it and recover the materials.";
  } else {
    const best = sorted.find((r) => r.id === recommendedId);
    summary = best
      ? `${best.title} is the best value: about ${best.costPerYear} JOD per year of added life.`
      : "Repairs are possible, but compare them with the replacement baseline before deciding.";
  }

  return { remedies: sorted, replacement, recommendedId, summary };
}
