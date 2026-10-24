import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { DiskInfo, SmartInfo, ThermalSensor } from "../types";
import { emptyBattery, hashSerial, inferRam, num, round, safeJson, type Detection } from "./shared";

const exec = promisify(execFile);

/**
 * One PowerShell round-trip, JSON out. CIM queries are read-only and need no
 * admin for the parts we use; SMART-equivalent counters degrade gracefully.
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cs      = Get-CimInstance Win32_ComputerSystem
$bios    = Get-CimInstance Win32_BIOS
$cpu     = Get-CimInstance Win32_Processor | Select-Object -First 1
$memory  = @(Get-CimInstance Win32_PhysicalMemory)
$battery = Get-CimInstance Win32_Battery | Select-Object -First 1

$bStatic = Get-WmiObject -Namespace root\wmi -Class BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1
$bFull   = Get-WmiObject -Namespace root\wmi -Class BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1
$bCycle  = Get-WmiObject -Namespace root\wmi -Class BatteryCycleCount -ErrorAction SilentlyContinue | Select-Object -First 1

$physical = @(Get-PhysicalDisk)
$wmiDisks = @(Get-CimInstance Win32_DiskDrive)
$reliability = @()
foreach ($d in $physical) {
  $r = Get-StorageReliabilityCounter -PhysicalDisk $d -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($r) {
    $reliability += [pscustomobject]@{
      FriendlyName    = $d.FriendlyName
      Wear            = $r.Wear
      Temperature     = $r.Temperature
      PowerOnHours    = $r.PowerOnHours
      ReadErrorsTotal = $r.ReadErrorsTotal
    }
  }
}

# Get-PhysicalDisk reports BusType "RAID" for NVMe drives behind Intel RST/VMD,
# so InterfaceType and PNPDeviceID are carried through to identify the real bus.
$disksOut = @()
foreach ($d in $physical) {
  $wmi = $wmiDisks | Where-Object { [string]$_.Index -eq [string]$d.DeviceId } | Select-Object -First 1
  $disksOut += [pscustomobject]@{
    DeviceId      = $d.DeviceId
    FriendlyName  = $d.FriendlyName
    HealthStatus  = $d.HealthStatus
    Size          = $d.Size
    MediaType     = $d.MediaType
    BusType       = $d.BusType
    InterfaceType = $wmi.InterfaceType
    PnpId         = $wmi.PNPDeviceID
  }
}

$osInfo  = Get-CimInstance Win32_OperatingSystem
$volume  = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Where-Object { $_.DeviceID -eq 'C:' } | Select-Object -First 1
$thermal = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue)
if (-not $thermal -or $thermal.Count -eq 0) {
  try {
    $samples = (Get-Counter '\Thermal Zone Information(*)\Temperature' -ErrorAction SilentlyContinue).CounterSamples
    $thermal = @()
    foreach ($s in $samples) {
      $thermal += [pscustomobject]@{
        InstanceName      = $s.InstanceName
        CurrentTemperature = [int]([double]$s.CookedValue * 10)
      }
    }
  } catch {
    $thermal = @()
  }
}

$payload = [pscustomobject]@{
  computer      = $cs
  bios          = $bios
  cpu           = $cpu
  memory        = $memory
  battery       = $battery
  batteryStatic = $bStatic
  batteryFull   = $bFull
  batteryCycle  = $bCycle
  disks         = $disksOut
  reliability   = $reliability
  os            = $osInfo
  volume        = $volume
  thermalZones  = $thermal
}

$payload | ConvertTo-Json -Depth 6 -Compress
`;

type PsObject = Record<string, unknown>;

type PsPayload = {
  computer?: PsObject;
  bios?: PsObject;
  cpu?: PsObject;
  memory?: PsObject[];
  battery?: PsObject;
  batteryStatic?: PsObject;
  batteryFull?: PsObject;
  batteryCycle?: PsObject;
  disks?: PsObject[];
  reliability?: PsObject[];
  os?: PsObject;
  volume?: PsObject;
  thermalZones?: PsObject[];
};

async function runPowerShell(): Promise<PsPayload | null> {
  const candidates = ["powershell.exe", "pwsh"];
  for (const exe of candidates) {
    try {
      const { stdout } = await exec(
        exe,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
        { timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      );
      const start = stdout.indexOf("{");
      if (start === -1) continue;
      const parsed = safeJson<PsPayload>(stdout.slice(start).trim());
      if (parsed) return parsed;
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      const start = stdout ? stdout.indexOf("{") : -1;
      if (start !== -1) {
        const parsed = safeJson<PsPayload>(stdout!.slice(start).trim());
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

const SMBIOS_MEMORY_TYPE: Record<number, string> = {
  20: "DDR",
  21: "DDR2",
  22: "DDR2 FB-DIMM",
  24: "DDR3",
  26: "DDR4",
  27: "LPDDR",
  28: "LPDDR2",
  29: "LPDDR3",
  30: "LPDDR4",
  34: "DDR5",
  35: "LPDDR5",
};

const SMBIOS_FORM_FACTOR: Record<number, string> = {
  8: "DIMM",
  12: "SO-DIMM",
  13: "SRIMM",
};

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const microsoft = value.match(/\/Date\((\d+)\)\//);
  if (microsoft) return new Date(Number(microsoft[1]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Win32_Battery.Chemistry → the short names sysfs uses on Linux, for parity. */
const SMBIOS_BATTERY_CHEMISTRY: Record<number, string> = {
  3: "Lead-acid",
  4: "NiCd",
  5: "NiMH",
  6: "Li-ion",
  7: "Zinc-air",
  8: "Li-poly",
};

function batteryFromWindows(p: PsPayload): Detection["battery"] {
  const bat = p.battery;
  if (!bat) return emptyBattery("No battery detected (desktop, or the battery is not exposed by Windows).");

  const designMwh =
    num(p.batteryStatic?.DesignedCapacity as number | undefined) ??
    num(bat.DesignCapacity as number | undefined);
  const fullMwh =
    num(p.batteryFull?.FullChargedCapacity as number | undefined) ??
    num(bat.FullChargeCapacity as number | undefined);

  const designWh = designMwh ? round(designMwh / 1000, 1) : null;
  const fullWh = fullMwh ? round(fullMwh / 1000, 1) : null;

  const statusCode = num(bat.BatteryStatus as number | undefined);
  const chemistryCode = num(bat.Chemistry as number | undefined);
  const statusMap: Record<number, string> = {
    1: "Discharging",
    2: "Charging (AC)",
    3: "Fully charged",
    4: "Low",
    5: "Critical",
    6: "Charging",
    7: "Charging (high)",
    8: "Charging (low)",
    9: "Charging (critical)",
  };

  return {
    present: true,
    designWh,
    fullWh,
    healthPct: designWh && fullWh ? round((fullWh / designWh) * 100, 1) : null,
    cycles: num(p.batteryCycle?.CycleCount as number | undefined),
    status: statusCode ? (statusMap[statusCode] ?? String(statusCode)) : null,
    technology: chemistryCode !== null ? (SMBIOS_BATTERY_CHEMISTRY[chemistryCode] ?? null) : null,
    note:
      designWh === null
        ? "Windows did not expose design capacity. Health % cannot be computed; ask for the battery report (powercfg /batteryreport)."
        : undefined,
  };
}

/**
 * Windows reports an NVMe drive behind Intel RST/VMD as BusType "RAID" and
 * InterfaceType "SCSI". The PNP id still carries the truth (VEN_NVME), so it is
 * the first thing we look at; otherwise fall back to the bus type.
 */
function transportFromWindows(d: PsObject): string {
  const pnp = String(d.PnpId ?? "");
  const name = String(d.FriendlyName ?? "");
  const iface = String(d.InterfaceType ?? "");
  const bus = String(d.BusType ?? "");

  if (/ven_nvme|nvme/i.test(pnp) || /\bnvme\b/i.test(name)) return "nvme";
  if (/usbstor|ven_usb/i.test(pnp)) return "usb";
  if (/^sata$/i.test(bus)) return "sata";
  if (/^scsi$/i.test(bus) && /^ide$/i.test(iface)) return "sata";
  return bus.toLowerCase() || "unknown";
}

function disksFromWindows(p: PsPayload): DiskInfo[] {
  const disks = p.disks ?? [];
  return disks.map((d, index) => {
    const name = String(d.FriendlyName ?? `Disk ${index + 1}`);
    const rel = (p.reliability ?? []).find((r) => String(r.FriendlyName ?? "") === name);
    const healthRaw = String(d.HealthStatus ?? "").toLowerCase();
    const sizeBytes = num(d.Size as number | undefined) ?? 0;
    const media = String(d.MediaType ?? "");

    const wear = num(rel?.Wear as number | undefined);
    const smart: SmartInfo = {
      available: Boolean(rel) || healthRaw.length > 0,
      health: healthRaw === "healthy" ? "passed" : healthRaw === "unhealthy" ? "failed" : "unknown",
      temperatureC: num(rel?.Temperature as number | undefined),
      powerOnHours: num(rel?.PowerOnHours as number | undefined),
      enduranceUsedPct: wear !== null ? Math.min(100, Math.max(0, Math.round(wear))) : null,
      mediaErrors: num(rel?.ReadErrorsTotal as number | undefined),
      note: rel ? undefined : "Reliability counters unavailable; run as administrator for full detail.",
    };

    return {
      name,
      model: name,
      sizeGb: round(sizeBytes / 1e9, 1),
      rotational: /hdd/i.test(media),
      transport: transportFromWindows(d),
      smart,
    };
  });
}

function thermalFromWindows(p: PsPayload) {
  const sensors: ThermalSensor[] = [];
  for (const zone of p.thermalZones ?? []) {
    const tenthsKelvin = num(zone.CurrentTemperature as number | undefined);
    if (tenthsKelvin === null) continue;
    const celsius = round(tenthsKelvin / 10 - 273.15, 1);
    if (celsius > 0 && celsius < 130) {
      sensors.push({ name: String(zone.InstanceName ?? "thermal zone"), valueC: celsius });
    }
  }
  const values = sensors.map((s) => s.valueC);
  return {
    sensors: sensors.sort((a, b) => b.valueC - a.valueC).slice(0, 8),
    maxC: values.length ? Math.max(...values) : null,
    fanRpm: null,
    note:
      sensors.length === 0
        ? "Windows did not expose temperature sensors to this user. Run as administrator for ACPI thermal zones."
        : "ACPI thermal zones only; readings are coarse and taken at idle.",
  };
}

export async function detectWindows(): Promise<Detection> {
  const p = await runPowerShell();
  const cpuInfo = os.cpus();
  const cpuModel = cpuInfo[0]?.model?.replace(/\s+/g, " ").trim() ?? "Unknown CPU";

  if (!p) {
    return genericDetection(
      cpuModel,
      "Windows hardware query failed. The app still works from manual input; try running as administrator.",
    );
  }

  const memorySticks = p.memory ?? [];
  const totalGb =
    memorySticks.reduce((sum, m) => sum + (num(m.Capacity as number | undefined) ?? 0), 0) / 1024 ** 3 ||
    os.totalmem() / 1024 ** 3;

  const firstStick = memorySticks[0];
  const smbiosType = num(firstStick?.SMBIOSMemoryType as number | undefined);
  const formFactor = num(firstStick?.FormFactor as number | undefined);
  const detectedType = smbiosType ? (SMBIOS_MEMORY_TYPE[smbiosType] ?? null) : null;

  const battery = batteryFromWindows(p);
  const cls = battery.present ? "laptop" : "desktop";
  const volume = p.volume;

  const totalBytes = num(volume?.Size as number | undefined) ?? 0;
  const freeBytes = num(volume?.FreeSpace as number | undefined) ?? 0;

  const boot = isoDate(p.os?.LastBootUpTime);
  const uptimeHours = boot ? round((Date.now() - boot.getTime()) / 3_600_000, 1) : 0;

  const ram = inferRam(cpuModel, cls, totalGb);
  ram.type = detectedType ?? ram.type;
  ram.formFactor = (formFactor ? SMBIOS_FORM_FACTOR[formFactor] : null) ?? ram.formFactor;
  ram.assumed = detectedType === null;

  return {
    brand: (p.computer?.Manufacturer as string | undefined) ?? null,
    model: (p.computer?.Model as string | undefined) ?? null,
    class: cls,
    serialHash: hashSerial(String(p.bios?.SerialNumber ?? os.hostname())),
    cpu: {
      model: cpuModel,
      physicalCores: num(p.cpu?.NumberOfCores as number | undefined) ?? cpuInfo.length,
      threads: num(p.cpu?.NumberOfLogicalProcessors as number | undefined) ?? cpuInfo.length,
      arch: os.arch(),
      maxMhz: num(p.cpu?.MaxClockSpeed as number | undefined),
    },
    ram,
    disks: disksFromWindows(p),
    battery,
    thermal: thermalFromWindows(p),
    storage: {
      mount: "C:",
      totalGb: round(totalBytes / 1e9, 1),
      freeGb: round(freeBytes / 1e9, 1),
      usedPct: totalBytes > 0 ? round(((totalBytes - freeBytes) / totalBytes) * 100, 1) : 0,
    },
    os: {
      platform: `${p.os?.Caption ?? "Windows"} ${p.os?.Version ?? ""}`.trim(),
      release: String(p.os?.BuildNumber ?? os.release()),
      arch: os.arch(),
      uptimeHours,
      hostname: os.hostname(),
    },
    platform: "windows",
    distro: (p.os?.Caption as string | undefined) ?? "Windows",
    capabilities: {
      powershell: true,
      reliabilityCounters: (p.reliability ?? []).some((r) => r.Wear !== null && r.Wear !== undefined),
      batteryDesignCapacity: p.batteryStatic !== undefined || p.battery !== undefined,
    },
    hints:
      (p.reliability ?? []).length === 0
        ? ["Drive reliability counters need administrator rights on Windows. Run as administrator for full detail."]
        : ["Local sensors are available. Nothing is sent anywhere."],
  };
}

export function genericDetection(cpuModel?: string, note?: string): Detection {
  const cpuInfo = os.cpus();
  const model = cpuModel ?? cpuInfo[0]?.model?.replace(/\s+/g, " ").trim() ?? "Unknown CPU";
  return {
    brand: null,
    model: null,
    class: "other",
    serialHash: hashSerial(os.hostname()),
    cpu: {
      model,
      physicalCores: cpuInfo.length,
      threads: cpuInfo.length,
      arch: os.arch(),
      maxMhz: cpuInfo[0]?.speed ?? null,
    },
    ram: inferRam(model, "other", os.totalmem() / 1024 ** 3),
    disks: [],
    battery: emptyBattery(note ?? "Battery sensors are not available on this platform."),
    thermal: { sensors: [], maxC: null, fanRpm: null, note: note ?? "Temperature sensors unavailable." },
    storage: { mount: "/", totalGb: 0, freeGb: 0, usedPct: 0 },
    os: {
      platform: `${os.type()} ${os.release()}`,
      release: os.release(),
      arch: os.arch(),
      uptimeHours: round(os.uptime() / 3600, 1),
      hostname: os.hostname(),
    },
    platform: "other",
    distro: os.type(),
    capabilities: {},
    hints: [note ?? "Limited sensor access on this platform."],
  };
}
