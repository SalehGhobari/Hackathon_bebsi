import crypto from "node:crypto";
import type {
  BatteryInfo,
  CpuInfo,
  DeviceClass,
  DiskInfo,
  OsInfo,
  RamInfo,
  StorageInfo,
  ThermalInfo,
} from "../types";

export type Detection = {
  brand: string | null;
  model: string | null;
  class: DeviceClass;
  serialHash: string | null;
  cpu: CpuInfo;
  ram: RamInfo;
  disks: DiskInfo[];
  battery: BatteryInfo;
  thermal: ThermalInfo;
  storage: StorageInfo;
  os: OsInfo;
  platform: "linux" | "windows" | "other";
  distro: string | null;
  capabilities: Record<string, boolean>;
  hints: string[];
};

export function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function hashSerial(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * RAM type from the CPU platform. Deliberately marked "assumed" because the
 * board can differ. Windows reads the real SMBIOS type when available.
 */
export function inferRam(cpuModel: string, cls: DeviceClass, totalGb: number): RamInfo {
  let type: string | null = null;
  if (/Ryzen \d+ [78]\d{3}/i.test(cpuModel)) type = "DDR5";
  else if (/Ryzen \d+ 6\d{3}/i.test(cpuModel)) type = "DDR5";
  else if (/Ryzen \d+ [45]\d{3}/i.test(cpuModel)) type = "DDR4";
  else if (/Core.*1[3-9]th/i.test(cpuModel)) type = "DDR5 (or DDR4 on some boards)";
  else if (/Core.*1[0-2]th/i.test(cpuModel)) type = "DDR4 (or DDR5 on 12th gen)";
  else if (/Core.*[6-9]th/i.test(cpuModel)) type = "DDR4";
  else if (/Core.*[4-5]th/i.test(cpuModel)) type = "DDR3";

  return {
    totalGb: round(totalGb, 1),
    type,
    formFactor: cls === "laptop" ? "SO-DIMM" : cls === "desktop" ? "DIMM" : null,
    assumed: type !== null,
  };
}

export function emptyBattery(note: string): BatteryInfo {
  return {
    present: false,
    designWh: null,
    fullWh: null,
    healthPct: null,
    cycles: null,
    status: null,
    technology: null,
    note,
  };
}

export function safeJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
