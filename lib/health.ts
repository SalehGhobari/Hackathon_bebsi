import type { Detection } from "./detect/shared";
import type { Fault, HealthItem, HealthReport, Severity, Status } from "./types";

function statusFromScore(score: number | null): Status {
  if (score === null) return "unknown";
  if (score >= 80) return "good";
  if (score >= 60) return "fair";
  return "poor";
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function severityForBattery(healthPct: number): Severity {
  if (healthPct < 50) return "critical";
  if (healthPct < 65) return "high";
  if (healthPct < 75) return "medium";
  return "low";
}

export function assess(d: Detection): { health: HealthReport; faults: Fault[] } {
  const items: HealthItem[] = [];
  const faults: Fault[] = [];
  const notes: string[] = [];

  // ---------------- Battery ----------------
  if (!d.battery.present || d.battery.healthPct === null) {
    items.push({
      key: "battery",
      label: "Battery",
      score: null,
      status: "unknown",
      summary: d.battery.note ?? "Battery health is not reported on this device.",
      evidence: [],
      confidence: "low",
    });
  } else {
    const pct = d.battery.healthPct;
    const cycles = d.battery.cycles;
    const cyclePenalty = cycles && cycles > 600 ? 8 : 0;
    const score = clampScore(pct - cyclePenalty);
    const evidence = [
      `Design capacity ${d.battery.designWh ?? "?"} Wh → current ${d.battery.fullWh ?? "?"} Wh`,
      cycles !== null ? `${cycles} charge cycles` : "Cycle count not reported",
      d.battery.technology ? `Chemistry: ${d.battery.technology}` : "",
    ].filter(Boolean);

    items.push({
      key: "battery",
      label: "Battery",
      score,
      status: statusFromScore(score),
      summary:
        pct >= 85
          ? `Holding ${pct}% of its original capacity.`
          : pct >= 70
            ? `Down to ${pct}% of design capacity — runtime is noticeably shorter.`
            : `Only ${pct}% of design capacity left. Expect very short runtime.`,
      evidence,
      confidence: "high",
    });

    if (pct < 80) {
      faults.push({
        key: "battery_wear",
        component: "Battery",
        severity: severityForBattery(pct),
        title: "Battery capacity has degraded",
        detail: `The battery stores ${pct}% of the charge it was designed for. This is normal wear, and it is also the single most common reason a working laptop gets replaced.`,
        evidence,
      });
    }
    if (cycles !== null && cycles > 600) {
      faults.push({
        key: "battery_cycles",
        component: "Battery",
        severity: "medium",
        title: "High charge-cycle count",
        detail: `${cycles} cycles is past the point where most cells lose capacity quickly.`,
        evidence: [`${cycles} cycles`],
      });
    }
  }

  // ---------------- Storage ----------------
  const smartNotes: string[] = [];
  if (d.disks.length === 0) {
    items.push({
      key: "storage",
      label: "Storage",
      score: null,
      status: "unknown",
      summary: "No physical disks reported by this system.",
      evidence: [],
      confidence: "low",
    });
  } else {
    const candidates: number[] = [];
    const evidence: string[] = [];

    for (const disk of d.disks) {
      const bits: string[] = [`${disk.model} · ${disk.sizeGb} GB · ${disk.transport.toUpperCase()}`];
      if (disk.smart.available) {
        bits.push(disk.smart.health === "passed" ? "SMART passed" : disk.smart.health === "failed" ? "SMART FAILED" : "SMART unknown");
        if (disk.smart.enduranceUsedPct !== null) bits.push(`${disk.smart.enduranceUsedPct}% endurance used`);
        if (disk.smart.temperatureC !== null) bits.push(`${disk.smart.temperatureC}°C`);
        if (disk.smart.powerOnHours !== null) bits.push(`${disk.smart.powerOnHours} h powered on`);
      } else if (disk.smart.note) {
        smartNotes.push(disk.smart.note);
      }
      evidence.push(bits.join(" · "));

      if (!disk.smart.available) {
        if (disk.rotational) candidates.push(55);
        continue;
      }
      if (disk.smart.health === "failed") {
        candidates.push(10);
      } else if (disk.smart.enduranceUsedPct !== null) {
        candidates.push(clampScore(100 - disk.smart.enduranceUsedPct));
      } else {
        candidates.push(85);
      }
      if (disk.rotational) candidates.push(55);
    }

    const freeScore =
      d.storage.usedPct >= 95 ? 25 : d.storage.usedPct >= 90 ? 45 : d.storage.usedPct >= 80 ? 70 : 92;
    evidence.push(`System volume ${d.storage.usedPct}% full (${d.storage.freeGb} GB free)`);
    candidates.push(freeScore);

    const score = clampScore(Math.min(...candidates));
    items.push({
      key: "storage",
      label: "Storage",
      score,
      status: statusFromScore(score),
      summary:
        score < 40
          ? "Storage health is the limiting factor on this machine."
          : score < 70
            ? "Storage is usable but showing age or pressure."
            : "Storage looks healthy.",
      evidence,
      confidence: d.disks.some((x) => x.smart.available) ? "high" : "low",
    });

    for (const disk of d.disks) {
      if (disk.smart.health === "failed") {
        faults.push({
          key: `disk_fail_${disk.name}`,
          component: "Storage",
          severity: "critical",
          title: "Drive reports a failing SMART status",
          detail: "Back up immediately. A failing drive can lose data without warning, and no amount of cleaning fixes it.",
          evidence: [`${disk.model}: SMART failed`],
        });
      }
      if (disk.smart.enduranceUsedPct !== null && disk.smart.enduranceUsedPct >= 80) {
        faults.push({
          key: `disk_wear_${disk.name}`,
          component: "Storage",
          severity: disk.smart.enduranceUsedPct >= 90 ? "high" : "medium",
          title: "Drive is near the end of its write endurance",
          detail: `${disk.smart.enduranceUsedPct}% of the drive's rated writes are used. Replacement is cheaper than losing the data.`,
          evidence: [`${disk.model}: ${disk.smart.enduranceUsedPct}% endurance used`],
        });
      }
      if (disk.rotational) {
        faults.push({
          key: `disk_hdd_${disk.name}`,
          component: "Storage",
          severity: "low",
          title: "Mechanical drive in use",
          detail: "A SATA SSD is the cheapest, highest-impact upgrade for an older machine: faster, quieter, and far more resistant to drops.",
          evidence: [`${disk.model} is a rotational drive`],
        });
      }
    }

    if (d.storage.usedPct >= 90) {
      faults.push({
        key: "disk_free",
        component: "Storage",
        severity: d.storage.usedPct >= 97 ? "high" : "medium",
        title: "System drive is almost full",
        detail: `Only ${d.storage.freeGb} GB free. A full drive slows everything down and can break updates.`,
        evidence: [`${d.storage.usedPct}% used`],
      });
    }
  }

  // ---------------- Thermal ----------------
  if (d.thermal.maxC === null) {
    items.push({
      key: "thermal",
      label: "Thermals",
      score: null,
      status: "unknown",
      summary: d.thermal.note ?? "No temperature sensors exposed.",
      evidence: [],
      confidence: "low",
    });
  } else {
    const t = d.thermal.maxC;
    const score = t <= 65 ? 92 : t <= 75 ? 85 : t <= 82 ? 75 : t <= 88 ? 62 : t <= 93 ? 45 : 30;
    items.push({
      key: "thermal",
      label: "Thermals",
      score: clampScore(score),
      status: statusFromScore(score),
      summary:
        t <= 75
          ? `Coolest readings are fine (max ${t}°C at idle).`
          : `Running warm at idle (${t}°C). Dust or dried thermal paste is the usual cause.`,
      evidence: [
        ...d.thermal.sensors.slice(0, 4).map((s) => `${s.name}: ${s.valueC}°C`),
        d.thermal.fanRpm !== null ? `Fan: ${d.thermal.fanRpm} rpm` : "Fan speed not reported",
      ],
      confidence: "low",
    });

    if (t >= 85) {
      faults.push({
        key: "thermal_high",
        component: "Thermals",
        severity: t >= 93 ? "high" : "medium",
        title: "High idle temperature",
        detail: `An idle reading of ${t}°C suggests blocked airflow, dust, or dried thermal paste. Servicing is cheap and usually restores performance.`,
        evidence: [`Max idle sensor: ${t}°C`, d.thermal.note ?? ""].filter(Boolean),
      });
    }
    if (d.thermal.fanRpm === 0 && t > 60) {
      faults.push({
        key: "fan_stopped",
        component: "Thermals",
        severity: "medium",
        title: "Fan reported at 0 rpm while warm",
        detail: "Some laptops only report fan speed when active, but a stopped fan is worth checking before it becomes a thermal shutdown.",
        evidence: [`Fan 0 rpm at ${t}°C`],
      });
    }
  }

  // ---------------- Memory ----------------
  const memGood = d.ram.totalGb >= 16;
  const memLow = d.ram.totalGb < 8;
  items.push({
    key: "memory",
    label: "Memory",
    score: memLow ? 45 : d.ram.totalGb < 12 ? 70 : memGood ? 92 : 80,
    status: statusFromScore(memLow ? 45 : d.ram.totalGb < 12 ? 70 : 92),
    summary: memLow
      ? `${d.ram.totalGb} GB is below what modern browsers and apps expect.`
      : `${d.ram.totalGb} GB installed.`,
    evidence: [
      `${d.ram.totalGb} GB total`,
      d.ram.type ? `${d.ram.type}${d.ram.assumed ? " (inferred from the CPU platform — verify before buying)" : ""}` : "Memory type not reported",
      d.ram.formFactor ? `Form factor: ${d.ram.formFactor}` : "",
    ].filter(Boolean),
    confidence: d.ram.assumed ? "low" : "high",
  });

  if (memLow) {
    faults.push({
      key: "ram_low",
      component: "Memory",
      severity: "medium",
      title: "Low memory for current software",
      detail: `${d.ram.totalGb} GB forces the machine to swap to disk, which feels like a slow CPU but is usually a 25–55 JOD fix.`,
      evidence: [`${d.ram.totalGb} GB installed`],
    });
  }

  // ---------------- System ----------------
  items.push({
    key: "system",
    label: "Platform",
    score: null,
    status: "unknown",
    summary: `${d.os.platform} · ${d.os.arch} · up ${d.os.uptimeHours} h`,
    evidence: [d.cpu.model, `${d.cpu.physicalCores} cores / ${d.cpu.threads} threads`],
    confidence: "high",
  });

  if (smartNotes.length) notes.push(...new Set(smartNotes));
  if (d.thermal.note) notes.push(d.thermal.note);
  notes.push("Health is scored from what this machine can report. Missing sensors are shown as unknown, never as zero.");

  const weights: Record<string, number> = { battery: 30, storage: 35, thermal: 20, memory: 15 };
  let weighted = 0;
  let totalWeight = 0;
  for (const item of items) {
    const w = weights[item.key];
    if (!w || item.score === null) continue;
    weighted += item.score * w;
    totalWeight += w;
  }

  return {
    health: {
      overall: totalWeight > 0 ? Math.round(weighted / totalWeight) : null,
      items,
      notes,
    },
    faults: faults.sort((a, b) => {
      const order: Severity[] = ["critical", "high", "medium", "low"];
      return order.indexOf(a.severity) - order.indexOf(b.severity);
    }),
  };
}
