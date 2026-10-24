import type { DeviceClass, MaterialAmount, RemedyAction } from "./types";

/**
 * Indicate ranges from published lifecycle studies. Always shown as ranges,
 * never as a single confident number. The UI labels them as estimates.
 */
export const EMBODIED_CO2E_KG: Record<DeviceClass, { low: number; mid: number; high: number }> = {
  laptop: { low: 200, mid: 250, high: 350 },
  desktop: { low: 300, mid: 400, high: 500 },
  other: { low: 100, mid: 200, high: 300 },
};

export const DEVICE_MASS_KG: Record<DeviceClass, number> = {
  laptop: 2.0,
  desktop: 8.0,
  other: 1.0,
};

/** Typical material content of one laptop. Indicative, published teardown ranges. */
export const DEVICE_MATERIALS: Record<DeviceClass, MaterialAmount[]> = {
  laptop: [
    { name: "Copper", grams: 500 },
    { name: "Aluminium", grams: 200 },
    { name: "Cobalt", grams: 60 },
    { name: "Lithium", grams: 30 },
    { name: "Rare earths", grams: 10 },
    { name: "Gold", grams: 0.2 },
  ],
  desktop: [
    { name: "Copper", grams: 1200 },
    { name: "Aluminium", grams: 1500 },
    { name: "Gold", grams: 0.3 },
    { name: "Rare earths", grams: 15 },
  ],
  other: [{ name: "Copper", grams: 100 }],
};

export const EXPECTED_LIFE_YEARS = 5;

export function scaleMaterials(materials: MaterialAmount[], factor: number): MaterialAmount[] {
  return materials.map((m) => ({
    name: m.name,
    grams: Math.max(0, Math.round(m.grams * factor * 10) / 10),
  }));
}

export function mergeMaterials(list: MaterialAmount[]): MaterialAmount[] {
  const map = new Map<string, number>();
  for (const m of list) map.set(m.name, (map.get(m.name) ?? 0) + m.grams);
  return [...map.entries()]
    .map(([name, grams]) => ({ name, grams: Math.round(grams * 10) / 10 }))
    .filter((m) => m.grams > 0)
    .sort((a, b) => b.grams - a.grams);
}

/**
 * Extending the life of a device avoids a share of the manufacturing footprint.
 * This is deliberately conservative: only the years gained, capped at the
 * device's expected life, and only for actions that keep the device in use.
 */
export function avoidedManufacturingCo2e(cls: DeviceClass, yearsGained: number, factor = 0.9): number {
  const e = EMBODIED_CO2E_KG[cls];
  const years = Math.max(0, Math.min(yearsGained, EXPECTED_LIFE_YEARS));
  return Math.round(e.mid * (years / EXPECTED_LIFE_YEARS) * factor);
}

export function impactForAction(
  action: RemedyAction,
  cls: DeviceClass,
  yearsGained: number,
  opts: { massKg?: number; materialFactor?: number } = {},
): { co2eAvoidedKg: number; kgDiverted: number; materials: MaterialAmount[] } {
  if (action === "recycle" || action === "harvest") {
    const mass = opts.massKg ?? DEVICE_MASS_KG[cls];
    const factor = opts.materialFactor ?? 1;
    return {
      co2eAvoidedKg: 0,
      kgDiverted: Math.round(mass * 10) / 10,
      materials: scaleMaterials(DEVICE_MATERIALS[cls], factor),
    };
  }
  if (action === "replace-device") {
    return { co2eAvoidedKg: 0, kgDiverted: 0, materials: [] };
  }
  // service / upgrade / replace-part keep the device in use.
  // No material recovery is claimed here: nothing was recycled, the device stayed alive.
  return {
    co2eAvoidedKg: avoidedManufacturingCo2e(cls, yearsGained),
    kgDiverted: 0,
    materials: [],
  };
}

export function costPerYear(totalCost: number, yearsGained: number): number {
  if (yearsGained <= 0) return totalCost;
  return Math.round((totalCost / yearsGained) * 10) / 10;
}
