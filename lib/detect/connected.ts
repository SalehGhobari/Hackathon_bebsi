import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import type { DiscoveredDevice, ScanDiscovery } from "../types";

const exec = promisify(execFile);
const OPTS = { timeout: 7000, maxBuffer: 8 * 1024 * 1024 } as const;

async function run(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, OPTS);
    return stdout;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    return stdout && stdout.trim() ? stdout : null;
  }
}

function digest(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function sizeLabel(bytes: number | string | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  const gb = n / 1e9;
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.round(gb)} GB`;
}

/** Removable/USB storage and peripherals currently attached to this machine. */
export async function scanConnected(): Promise<ScanDiscovery> {
  if (process.platform === "win32") return scanWindows();
  if (process.platform === "linux") return scanLinux();
  return {
    devices: [],
    notes: ["Connected-device scan is supported on Linux and Windows."],
    scannedAt: new Date().toISOString(),
  };
}

async function scanLinux(): Promise<ScanDiscovery> {
  const devices: DiscoveredDevice[] = [];
  const notes: string[] = [];

  const out = await run("lsblk", [
    "-J",
    "-o",
    "NAME,MODEL,SIZE,TYPE,TRAN,RM,SERIAL,ROTA,MOUNTPOINT",
  ]);
  if (out) {
    try {
      const parsed = JSON.parse(out) as {
        blockdevices?: {
          name: string;
          model?: string | null;
          size?: string | number;
          type?: string;
          tran?: string | null;
          rm?: boolean | number | string;
          serial?: string | null;
          rota?: boolean | number | string;
          mountpoint?: string | null;
        }[];
      };
      for (const d of parsed.blockdevices ?? []) {
        if (d.type !== "disk") continue;
        const removable = d.rm === true || d.rm === 1 || d.rm === "1";
        const usb = (d.tran ?? "").toLowerCase() === "usb";
        if (!removable && !usb) continue;
        const title = (d.model ?? "").trim() || `Removable disk ${d.name}`;
        const size = sizeLabel(d.size);
        devices.push({
          id: `usb-disk-${digest(`${d.name}:${d.serial ?? ""}`)}`,
          source: "usb",
          title,
          category: d.rota === true || d.rota === 1 ? "hdd" : "ssd",
          detail: `${usb ? "USB" : "Removable"} disk${size ? ` · ${size}` : ""} · /dev/${d.name}`,
          serialHash: d.serial ? digest(String(d.serial)) : null,
          meta: { device: `/dev/${d.name}`, transport: d.tran ?? "usb", mount: d.mountpoint ?? "" },
        });
      }
    } catch {
      notes.push("Could not read lsblk output; no removable disks were listed.");
    }
  } else {
    notes.push("lsblk is unavailable, so removable disks could not be listed.");
  }

  const usb = await run("lsusb", []);
  if (usb) {
    for (const raw of usb.split("\n")) {
      const line = raw.trim();
      if (!line || /root hub|linux foundation/i.test(line)) continue;
      const m = /^Bus\s+\d+\s+Device\s+\d+:\s+ID\s+([0-9a-f]{4}:[0-9a-f]{4})\s*(.*)$/i.exec(line);
      if (!m) continue;
      const name = m[2].trim() || m[1];
      if (/hub$/i.test(name) && /usb/i.test(name)) continue;
      devices.push({
        id: `usb-dev-${digest(line)}`,
        source: "usb",
        title: name,
        category: "usb",
        detail: `USB peripheral · ${m[1]}`,
        serialHash: null,
        meta: { usbId: m[1] },
      });
    }
  } else {
    notes.push("lsusb is unavailable; USB peripherals were not listed.");
  }

  if (usb) notes.push("USB scan lists non-hub peripherals; some laptops expose internal radios and cameras here.");
  if (!devices.length && !notes.length) notes.push("No removable drives or USB peripherals found.");
  return { devices, notes, scannedAt: new Date().toISOString() };
}

async function scanWindows(): Promise<ScanDiscovery> {
  const devices: DiscoveredDevice[] = [];
  const notes: string[] = [];
  const script =
    "Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'USB' } | " +
    "Select-Object Model,Size,SerialNumber,MediaType | ConvertTo-Json -Compress";
  const out = await run("powershell", ["-NoProfile", "-Command", script]);
  if (!out || !out.trim()) {
    notes.push("No USB disks found, or Windows did not return disk information.");
    return { devices, notes, scannedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(out) as
      | { Model?: string; Size?: number | string; SerialNumber?: string; MediaType?: string }
      | { Model?: string; Size?: number | string; SerialNumber?: string; MediaType?: string }[];
    for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
      const title = (d.Model ?? "USB disk").trim();
      const size = sizeLabel(d.Size);
      devices.push({
        id: `usb-disk-${digest(`${title}:${d.SerialNumber ?? ""}`)}`,
        source: "usb",
        title,
        category: /ssd/i.test(d.MediaType ?? "") ? "ssd" : "hdd",
        detail: `USB disk${size ? ` · ${size}` : ""}`,
        serialHash: d.SerialNumber ? digest(d.SerialNumber) : null,
        meta: { mediaType: d.MediaType ?? "" },
      });
    }
  } catch {
    notes.push("Could not parse Windows disk information.");
  }
  if (!devices.length) notes.push("No USB disks found.");
  return { devices, notes, scannedAt: new Date().toISOString() };
}
