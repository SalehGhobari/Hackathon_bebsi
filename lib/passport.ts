import crypto from "node:crypto";
import type { ActionRecord, Device, Diagnostic, MaterialAmount, Passport, WipeRecord } from "./types";
import { mergeMaterials } from "./green";

function canonical(payload: Omit<Passport, "hash">): string {
  return JSON.stringify(payload);
}

export function buildPassport(
  device: Device,
  diagnostic: Diagnostic | null,
  actions: ActionRecord[],
  wipe: WipeRecord | null,
): Passport {
  const co2e = Math.round(actions.reduce((sum, a) => sum + a.co2eAvoidedKg, 0));
  const kg = Math.round(actions.reduce((sum, a) => sum + a.kgDiverted, 0) * 10) / 10;
  const materials: MaterialAmount[] = mergeMaterials(actions.flatMap((a) => a.materials));

  const payload: Omit<Passport, "hash"> = {
    version: 1,
    id: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    device: {
      name: device.name,
      brand: device.brand,
      model: device.model,
      class: device.class,
    },
    health: {
      overall: diagnostic?.health.overall ?? null,
      batteryPct: diagnostic?.battery.healthPct ?? null,
      storage:
        diagnostic?.disks
          .map((d) => `${d.model} (${d.smart.health}, ${d.smart.enduranceUsedPct ?? "?"}% wear)`)
          .join("; ") ?? "not reported",
    },
    impact: { co2eAvoidedKg: co2e, kgDiverted: kg, materials },
    wipe,
  };

  const hash = crypto.createHash("sha256").update(canonical(payload)).digest("hex");
  return { ...payload, hash };
}

export function verifyPassport(passport: Passport): boolean {
  const { hash, ...rest } = passport;
  return crypto.createHash("sha256").update(canonical(rest)).digest("hex") === hash;
}

/** Compact string for a QR code (kept small enough to scan reliably). */
export function compactForQr(p: Passport): string {
  return JSON.stringify({
    v: 1,
    id: p.id.slice(0, 8),
    hash: p.hash.slice(0, 24),
    model: p.device.model ?? p.device.name,
    health: p.health.overall,
    co2: p.impact.co2eAvoidedKg,
    kg: p.impact.kgDiverted,
    at: p.issuedAt.slice(0, 10),
  });
}
