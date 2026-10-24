import os from "node:os";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import type { DiscoveredDevice, ScanDiscovery } from "../types";

const exec = promisify(execFile);
const PING_OPTS = { timeout: 1400, maxBuffer: 64 * 1024 } as const;

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isPrivate(ip: string): boolean {
  return PRIVATE.test(ip);
}

function digest(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function subnetPrefix(ip: string): string {
  return ip.split(".").slice(0, 3).join(".");
}

async function ping(ip: string): Promise<boolean> {
  const args = process.platform === "win32" ? ["-n", "1", "-w", "900", ip] : ["-c", "1", "-W", "1", ip];
  try {
    await exec("ping", args, PING_OPTS);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function reverseName(ip: string): Promise<string | null> {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 800)),
    ]);
    return names?.[0] ?? null;
  } catch {
    return null;
  }
}

async function arpTable(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const out =
    process.platform === "win32"
      ? await exec("arp", ["-a"], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 })
          .then((r) => r.stdout)
          .catch(() => null)
      : await exec("ip", ["neigh", "show"], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 })
          .then((r) => r.stdout)
          .catch(() => null);
  if (!out) return map;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (process.platform === "win32") {
      const m = /^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})/i.exec(line);
      if (m) map.set(m[1], m[2].replaceAll("-", ":").toLowerCase());
    } else {
      const m = /^(\d+\.\d+\.\d+\.\d+)\s+.*lladdr\s+([0-9a-f:]{17})/i.exec(line);
      if (m) map.set(m[1], m[2].toLowerCase());
    }
  }
  return map;
}

/**
 * Local-network discovery only: one ping sweep over the private /24 around
 * each active IPv4 interface, plus the existing ARP/neighbour table.
 * No ports are probed and nothing is sent outside the local network.
 */
export async function scanLan(): Promise<ScanDiscovery> {
  const notes: string[] = [];
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i && i.family === "IPv4" && !i.internal && isPrivate(i.address)));

  const prefixes = [...new Set(interfaces.map((i) => subnetPrefix(i.address)))].slice(0, 2);
  if (!prefixes.length) {
    return {
      devices: [],
      notes: ["No private IPv4 network was found. Connect to Wi-Fi or Ethernet and try again."],
      scannedAt: new Date().toISOString(),
    };
  }

  const localIps = new Set(interfaces.map((i) => i.address));
  const arp = await arpTable();
  const alive = new Set<string>();

  for (const prefix of prefixes) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => !localIps.has(ip));
    const results = await mapLimit(hosts, 48, async (ip) => ((await ping(ip)) ? ip : null));
    for (const ip of results) if (ip) alive.add(ip);
    notes.push(`Scanned ${prefix}.0/24 locally; no ports were probed.`);
  }

  // Devices that recently talked to us may not answer ICMP; keep their ARP entry.
  for (const ip of arp.keys()) {
    if (prefixes.some((p) => ip.startsWith(`${p}.`)) && !localIps.has(ip)) alive.add(ip);
  }

  if (!alive.size) {
    notes.push("No other devices answered. Some networks block ping; the ARP table was also empty.");
  }

  const ips = [...alive].sort();
  const names = await mapLimit(ips, 24, reverseName);

  const devices: DiscoveredDevice[] = ips.map((ip, i) => {
    const hostname = names[i];
    const mac = arp.get(ip);
    return {
      id: `lan-${digest(ip)}`,
      source: "lan",
      title: hostname || `Device ${ip}`,
      category: "lan-device",
      detail: [ip, mac, hostname ? "hostname resolved" : "no hostname"].filter(Boolean).join(" · "),
      serialHash: mac ? digest(mac) : null,
      meta: { ip, mac: mac ?? "", hostname: hostname ?? "" },
    };
  });

  return { devices, notes, scannedAt: new Date().toISOString() };
}
