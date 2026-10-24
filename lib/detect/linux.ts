import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import type {
  BatteryInfo,
  DiskInfo,
  SmartInfo,
  ThermalInfo,
  ThermalSensor,
} from "../types";
import { emptyBattery, hashSerial, inferRam, num, round, type Detection } from "./shared";

const exec = promisify(execFile);
const OPTS = { timeout: 6000, maxBuffer: 8 * 1024 * 1024 } as const;

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, OPTS);
    return stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    return stdout && stdout.trim().length > 0 ? stdout : null;
  }
}

function read(path: string): string | null {
  try {
    const v = fs.readFileSync(path, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  const out = await run("sh", ["-c", `command -v ${cmd} 2>/dev/null`]);
  return Boolean(out && out.trim());
}

type DistroInfo = { name: string; id: string };

function readDistro(): DistroInfo {
  const raw = read("/etc/os-release");
  if (!raw) return { name: os.type(), id: "unknown" };
  const name = raw.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? os.type();
  const id = raw.match(/^ID="?([^"\n]+)"?/m)?.[1]?.toLowerCase() ?? "unknown";
  return { name, id };
}

function packageHint(distro: DistroInfo, pkg: { arch: string; debian: string; fedora: string }): string {
  if (distro.id === "arch" || distro.id === "manjaro" || distro.id === "endeavouros") return `sudo pacman -S ${pkg.arch}`;
  if (["ubuntu", "linuxmint", "debian", "pop", "zorin", "elementary"].includes(distro.id)) return `sudo apt install ${pkg.debian}`;
  if (distro.id === "fedora") return `sudo dnf install ${pkg.fedora}`;
  return `install ${pkg.debian}`;
}

async function readSmart(diskName: string): Promise<SmartInfo> {
  const empty: SmartInfo = {
    available: false,
    health: "unknown",
    temperatureC: null,
    powerOnHours: null,
    enduranceUsedPct: null,
    mediaErrors: null,
  };

  const out = await run("smartctl", ["-H", "-A", "-j", `/dev/${diskName}`]);
  if (!out) {
    return { ...empty, note: "SMART unavailable: smartmontools missing or no access to the device." };
  }

  let j: Record<string, unknown>;
  try {
    j = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return { ...empty, note: `SMART needs elevated access. Run: sudo smartctl -H -A /dev/${diskName}` };
  }

  const messages = (j.smartctl as { messages?: { string: string }[] } | undefined)?.messages ?? [];
  if (messages.some((m) => /permission|privilege/i.test(m.string))) {
    return { ...empty, note: `SMART needs elevated access. Run: sudo smartctl -H -A /dev/${diskName}` };
  }

  const smartStatus = j.smart_status as { passed?: boolean } | undefined;
  const nvmeLog = j.nvme_smart_health_information_log as
    | { percentage_used?: number; temperature?: number; media_errors?: number }
    | undefined;
  const temperature = j.temperature as { current?: number } | undefined;
  const powerOn = j.power_on_time as { hours?: number } | undefined;
  const ataAttrs = j.ata_smart_attributes as
    | { table?: { id: number; value: number }[] }
    | undefined;

  let endurance = nvmeLog?.percentage_used ?? null;
  if (endurance === null && ataAttrs?.table) {
    const lifeLeft = ataAttrs.table.find((a) => a.id === 231);
    const wear = ataAttrs.table.find((a) => a.id === 233);
    if (lifeLeft) endurance = Math.max(0, 100 - lifeLeft.value);
    else if (wear) endurance = wear.value;
  }
  if (endurance !== null) endurance = Math.min(100, Math.max(0, Math.round(endurance)));

  return {
    available: true,
    health: smartStatus?.passed === true ? "passed" : smartStatus?.passed === false ? "failed" : "unknown",
    temperatureC: temperature?.current ?? nvmeLog?.temperature ?? null,
    powerOnHours: powerOn?.hours ?? null,
    enduranceUsedPct: endurance,
    mediaErrors: nvmeLog?.media_errors ?? null,
  };
}

const NO_SMART: SmartInfo = {
  available: false,
  health: "unknown",
  temperatureC: null,
  powerOnHours: null,
  enduranceUsedPct: null,
  mediaErrors: null,
  note: "SMART unavailable on this system (smartmontools not installed, or no permission).",
};

/** Works on any Linux without lsblk: reads sysfs directly. */
function disksFromSysfs(): DiskInfo[] {
  try {
    return fs
      .readdirSync("/sys/block")
      .filter((n) => !/^(loop|ram|zram|dm-|sr|fd|md)/.test(n))
      .map((name) => {
        const dir = `/sys/block/${name}`;
        const sectors = num(read(`${dir}/size`)) ?? 0;
        const model = (read(`${dir}/device/model`) ?? read(`${dir}/device/name`) ?? name).trim();
        return {
          name,
          model,
          sizeGb: round((sectors * 512) / 1e9, 1),
          rotational: read(`${dir}/queue/rotational`) === "1",
          transport: name.startsWith("nvme") ? "nvme" : "unknown",
          smart: NO_SMART,
        };
      })
      .filter((d) => d.sizeGb > 0.5);
  } catch {
    return [];
  }
}

async function detectDisks(): Promise<DiskInfo[]> {
  const out = await run("lsblk", ["-J", "-d", "-o", "NAME,MODEL,SIZE,ROTA,TRAN,TYPE"]);
  if (!out) return disksFromSysfs();
  try {
    const parsed = JSON.parse(out) as {
      blockdevices?: {
        name: string;
        model?: string | null;
        size?: string;
        rota?: boolean;
        tran?: string | null;
        type?: string;
      }[];
    };
    const result: DiskInfo[] = [];
    for (const d of (parsed.blockdevices ?? []).filter((x) => x.type === "disk")) {
      const smart = await readSmart(d.name);
      result.push({
        name: d.name,
        model: (d.model ?? "Unknown disk").trim(),
        sizeGb: round(Number.parseFloat(d.size ?? "0"), 1),
        rotational: Boolean(d.rota),
        transport: d.tran ?? "unknown",
        smart,
      });
    }
    return result;
  } catch {
    return [];
  }
}

function readBattery(): BatteryInfo {
  const base = "/sys/class/power_supply";
  let dir: string | null = null;
  try {
    dir = fs.readdirSync(base).find((d) => d.startsWith("BAT")) ?? null;
  } catch {
    dir = null;
  }
  if (!dir) return emptyBattery("No battery exposed by this system (desktop, or sensors unavailable).");

  const p = `${base}/${dir}`;
  let designWh = (num(read(`${p}/energy_full_design`)) ?? 0) / 1e6 || null;
  let fullWh = (num(read(`${p}/energy_full`)) ?? 0) / 1e6 || null;

  if (designWh === null || fullWh === null) {
    const chargeDesign = num(read(`${p}/charge_full_design`));
    const chargeFull = num(read(`${p}/charge_full`));
    const voltage = num(read(`${p}/voltage_min_design`));
    if (chargeDesign && chargeFull && voltage) {
      designWh = (chargeDesign * voltage) / 1e12;
      fullWh = (chargeFull * voltage) / 1e12;
    }
  }

  return {
    present: true,
    designWh: designWh ? round(designWh, 1) : null,
    fullWh: fullWh ? round(fullWh, 1) : null,
    healthPct: designWh && fullWh ? round((fullWh / designWh) * 100, 1) : null,
    cycles: num(read(`${p}/cycle_count`)),
    status: read(`${p}/status`),
    technology: read(`${p}/technology`),
    note: designWh === null ? "Battery present but capacity reporting is not exposed on this device." : undefined,
  };
}

async function readThermal(): Promise<ThermalInfo> {
  const sensors: ThermalSensor[] = [];
  let fanRpm: number | null = null;

  const out = await run("sensors", ["-j"]);
  if (out) {
    try {
      const j = JSON.parse(out) as Record<string, Record<string, Record<string, number>>>;
      for (const [chip, values] of Object.entries(j)) {
        for (const [key, reading] of Object.entries(values)) {
          for (const [field, value] of Object.entries(reading)) {
            if (!field.endsWith("_input") || typeof value !== "number") continue;
            if (key.startsWith("fan") || field.startsWith("fan")) {
              fanRpm = Math.max(fanRpm ?? 0, Math.round(value));
            } else if (value > 0 && value < 130) {
              sensors.push({ name: `${chip} ${key}`, valueC: round(value, 1) });
            }
          }
        }
      }
    } catch {
      /* fall through to sysfs */
    }
  }

  if (sensors.length === 0) {
    try {
      for (const zone of fs.readdirSync("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone"))) {
        const raw = num(read(`/sys/class/thermal/${zone}/temp`));
        const type = read(`/sys/class/thermal/${zone}/type`) ?? zone;
        if (raw !== null && raw > 0 && raw < 130000) sensors.push({ name: type, valueC: round(raw / 1000, 1) });
      }
    } catch {
      /* no zones */
    }
  }

  // hwmon works without lm-sensors installed (common on minimal Arch installs)
  if (sensors.length === 0) {
    try {
      for (const hw of fs.readdirSync("/sys/class/hwmon").filter((h) => h.startsWith("hwmon"))) {
        const chip = read(`/sys/class/hwmon/${hw}/name`) ?? hw;
        for (const file of fs.readdirSync(`/sys/class/hwmon/${hw}`)) {
          if (!/^temp\d+_input$/.test(file)) continue;
          const raw = num(read(`/sys/class/hwmon/${hw}/${file}`));
          if (raw === null) continue;
          const celsius = raw > 1000 ? raw / 1000 : raw;
          if (celsius > 0 && celsius < 130) sensors.push({ name: `${chip} ${file.replace("_input", "")}`, valueC: round(celsius, 1) });
        }
      }
    } catch {
      /* no hwmon */
    }
  }

  const values = sensors.map((s) => s.valueC);
  return {
    sensors: sensors.sort((a, b) => b.valueC - a.valueC).slice(0, 8),
    maxC: values.length ? Math.max(...values) : null,
    fanRpm,
    note: "Readings are taken at idle; temperatures under load will be higher.",
  };
}

function readStorage(mount: string) {
  try {
    const s = fs.statfsSync(mount);
    const totalGb = (s.blocks * s.bsize) / 1e9;
    const freeGb = (s.bavail * s.bsize) / 1e9;
    return {
      mount,
      totalGb: round(totalGb, 1),
      freeGb: round(freeGb, 1),
      usedPct: round(((totalGb - freeGb) / totalGb) * 100, 1),
    };
  } catch {
    return { mount, totalGb: 0, freeGb: 0, usedPct: 0 };
  }
}

export async function detectLinux(): Promise<Detection> {
  const cpuInfo = os.cpus();
  const cpuModel = cpuInfo[0]?.model?.replace(/\s+/g, " ").trim() ?? "Unknown CPU";

  let physicalCores = cpuInfo.length;
  try {
    const m = fs.readFileSync("/proc/cpuinfo", "utf8").match(/cpu cores\s*:\s*(\d+)/);
    if (m) physicalCores = Number(m[1]);
  } catch {
    /* keep thread count */
  }

  const brand = read("/sys/class/dmi/id/sys_vendor");
  const model = read("/sys/class/dmi/id/product_name");
  const serial =
    read("/sys/class/dmi/id/product_serial") ?? read("/sys/class/dmi/id/product_uuid") ?? os.hostname();

  const battery = readBattery();
  const cls = battery.present ? "laptop" : "desktop";
  const distro = readDistro();
  const [disks, thermal, hasSmartctl, hasSensors, hasLsblk] = await Promise.all([
    detectDisks(),
    readThermal(),
    commandExists("smartctl"),
    commandExists("sensors"),
    commandExists("lsblk"),
  ]);

  const hints: string[] = [];
  if (!hasSmartctl) {
    hints.push(`smartctl not found. ${packageHint(distro, { arch: "smartmontools", debian: "smartmontools", fedora: "smartmontools" })} to read drive health.`);
  }
  if (!hasSensors && thermal.sensors.length === 0) {
    hints.push(`No temperature sensors exposed. ${packageHint(distro, { arch: "lm_sensors", debian: "lm-sensors", fedora: "lm_sensors" })}.`);
  }
  if (disks.some((d) => !d.smart.available && d.smart.note?.includes("elevated"))) {
    hints.push("Drive health needs elevated access. Opening the app with sudo is not recommended; run the printed smartctl command instead.");
  }
  if (cls === "laptop" && battery.healthPct === null) {
    hints.push("Battery capacity is not exposed. Try: upower -i $(upower -e | grep BAT)");
  }
  if (hints.length === 0) hints.push("All local sensors are available. Nothing is sent anywhere.");

  return {
    brand,
    model,
    class: cls,
    serialHash: hashSerial(serial),
    cpu: {
      model: cpuModel,
      physicalCores,
      threads: cpuInfo.length,
      arch: os.arch(),
      maxMhz: cpuInfo[0]?.speed ?? null,
    },
    ram: inferRam(cpuModel, cls, os.totalmem() / 1024 ** 3),
    disks,
    battery,
    thermal,
    storage: readStorage("/"),
    os: {
      platform: `${os.type()} ${os.release()}`,
      release: os.release(),
      arch: os.arch(),
      uptimeHours: round(os.uptime() / 3600, 1),
      hostname: os.hostname(),
    },
    platform: "linux",
    distro: distro.name,
    capabilities: {
      smartctl: hasSmartctl,
      smartAccess: disks.some((d) => d.smart.available),
      sensors: hasSensors || thermal.sensors.length > 0,
      lsblk: hasLsblk,
      root: typeof process.getuid === "function" ? process.getuid() === 0 : false,
    },
    hints,
  };
}
