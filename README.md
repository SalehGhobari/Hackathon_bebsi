# Fahas · فحص

**A local-first hardware advisor for laptops and desktops.** It reads what your machine can report, then advises
**repair, upgrade, recycle or replace** — priced in Jordanian dinars, measured in years of added life, kilograms
diverted and CO₂e avoided.

No account. No server. No network calls. Everything is stored on the machine it runs on.

```
npm install
npm run dev
```

---

## Why

Most diagnostic tools tell you a disk is failing. They do not tell you whether it is worth fixing, what the part
costs in Amman, or what happens to the old one. Fahas is built around the decision, not the reading:

- **Repair before replace** — ranked by the waste hierarchy (prevent → reuse → repair → recycle → replace), then by
  cost per year of added life.
- **Jordanian prices with provenance** — every part range carries a city, a source and a capture date.
- **Honest about uncertainty** — missing sensors show as `unknown`, never as zero. Health is scored from what was
  actually measured.
- **Recycling is the last resort** — and when it is the right answer, the app says what to do with the battery and the
  data.

> Diagnostics for the laptop you have. Decisions for the laptop you keep.

---

## Current status

| Area | State |
|---|---|
| Linux detection (Arch, Mint, generic) | Working — sysfs battery, `lsblk`/sysfs disks, `sensors`/hwmon/thermal zones, DMI |
| Windows detection | Implemented via PowerShell/CIM + storage reliability counters. Untested on real hardware — needs a Windows laptop to verify |
| Health scoring + findings | Working |
| Remedy engine (cost/year, CO₂e, materials) | Working |
| Jordanian price book | Seeded with **indicative ranges** — must be replaced with surveyed prices |
| Impact ledger | Working (local JSON) |
| Second-life passport + QR | Working (signed hash, offline verification) |
| Wipe attestation | Working — records the method as an **operator attestation**, not proof of erasure |
| Demo mode | Working — simulates wear so a healthy laptop can demo the full advisor |
| AppImage / Windows installer | Config written; needs a build on each OS |

---

## Requirements

- **Node.js 20+** (22 recommended) and npm.
- **Linux:** `smartmontools` for drive health, `lm-sensors` for temperatures. Both are optional — the app degrades
  and tells you the install command for your distro.
  - Arch / Manjaro: `sudo pacman -S smartmontools lm_sensors`
  - Ubuntu / Mint / Debian: `sudo apt install smartmontools lm-sensors`
- **Windows:** nothing extra. Run as administrator for drive reliability counters and thermal zones.

`smartctl` and DMI reads may require elevated access. Fahas does **not** ask for sudo and never runs elevated; it
degrades and prints the exact command you can run yourself.

If Electron's binary did not download during `npm install` (npm 12 blocks install scripts by default), run:

```bash
node node_modules/electron/install.js
```

---

## Run

```bash
npm install
npm run dev          # builds the Electron main process, then opens the app
```

Checks:

```bash
npm run typecheck    # TypeScript, no emit
npm run test:scan    # real hardware scan + demo scan + store/passport round-trip (no GUI)
```

## Package

```bash
npm run pack:linux   # release/Fahas-0.1.0-x86_64.AppImage
npm run pack:win     # release/Fahas-Setup-0.1.0-x64.exe  (run this ON Windows)
```

Cross-building the Windows installer from Linux is not supported here — build it on the Windows laptop.
AppImage needs FUSE 2; on Arch install `libfuse2`, or run with `--appimage-extract-and-run`.

---

## How it works

```
Electron main process (Node)
  ├─ lib/detect/linux.ts     /sys, lsblk, smartctl, sensors, hwmon, DMI
  ├─ lib/detect/windows.ts   one PowerShell/CIM round-trip → JSON
  ├─ lib/health.ts           component scores, findings, confidence
  ├─ lib/advisor.ts          remedy ladder + cost/year + impact
  ├─ lib/green.ts            embodied carbon, materials, impact math
  ├─ lib/store.ts            local JSON store (mode 0600)
  └─ lib/passport.ts         hashed, verifiable second-life record
        ↕ IPC (contextIsolation, no node in renderer)
Renderer (plain HTML/CSS/JS)
  └─ ui/                     no frameworks, no network, strict CSP
```

Key design rules:

1. **The decision is deterministic.** Cost per year, waste hierarchy, impact — no model decides anything.
2. **Missing data is `unknown`.** Never fabricate a sensor, a score or a price.
3. **Ranges, not false precision.** CO₂e and materials are published estimates with a range.
4. **Recycling is ranked last.** Reuse and repair are almost always better financially and environmentally.
5. **Local only.** No telemetry, no accounts, no update pings, no remote assets.

## Data and privacy

- Stored at `app.getPath("userData")/fahas-data.json` — `~/.config/Fahas` on Linux, `%APPDATA%\Fahas` on Windows.
- File mode `0600` where the OS supports it. Delete the file to delete everything.
- Serials are hashed; only the hash is kept.
- The renderer has no network access (`connect-src 'none'` in the CSP) and no Node access.
- The wipe record is an **attestation by the operator**, not a cryptographic proof of erasure. The UI says so.

## The price book

`data/prices.json` — one row per part, labour or device class:

```json
{
  "id": "p-ssd-nvme-512",
  "category": "ssd",
  "item": "NVMe SSD 512 GB",
  "spec": "M.2 2280, PCIe 3.0/4.0",
  "low": 35,
  "high": 50,
  "currency": "JOD",
  "city": "Amman",
  "source": "Indicative local shop survey (seed)",
  "sourceDate": "2026-10"
}
```

The seed values are **indicative, not surveyed**. Replacing them with real quotes (with date and shop) is the
highest-value contribution anyone can make. The advisor recomputes instantly because advice is never stored.

## Demo mode

Healthy laptops produce a boring (and correct) "nothing needs replacing". Tick **Simulate wear** before running a
check to overlay realistic faults — 58% battery, 812 cycles, 87% drive endurance, 94 °C idle, 6 GB RAM, 96% full
disk. The diagnostic is flagged `demo: true`, the UI shows a banner, and the values are never presented as real.

## Known limits

- macOS is not supported.
- Windows sensor coverage varies by vendor; reliability counters may need admin.
- `lsblk` may be missing on minimal installs — there is a sysfs fallback.
- Prices are seed ranges and will be stale; the source/date are shown next to every number.
- No live component shopping links (deliberate: no network).
- The passport verifies integrity, not truthfulness — it proves the record was not altered after issue.

## Contributing (teammates)

Good places to work without touching the core:

1. **Price book** — survey real shops and replace the seed rows (`data/prices.json`).
2. **Fault trees** — device classes beyond laptops/desktops, starting in `lib/health.ts` + `lib/advisor.ts`.
3. **Windows** — verify `lib/detect/windows.ts` on a real machine and tighten the CIM mappings.
4. **Passport UI** — a verification view that accepts a scanned QR on a second device.
5. **Localisation** — Arabic UI strings (the app is currently English with Arabic branding).
6. **Packaging** — tested AppImage on Arch/Mint, tested NSIS installer on Windows.

Please keep the rules above: no invented numbers, no network calls, no telemetry.

## License

MIT — see `LICENSE`.
