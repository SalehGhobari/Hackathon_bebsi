# Fahes · فحص

**A Jordanian replace-and-recycle app for laptops, desktops and the devices around them.**

Scan this PC, its removable drives, USB peripherals or the local network, then file each item under **Recycle** or
**Replace**. Replacements are matched against real OpenSooq listings and Jordanian prices in JOD; recyclables become a
photo-backed PDF manifest for a verified Amman e-waste partner.

Built for the Jordanian market: local prices, local classifieds, local recyclers, Arabic RTL UI.

> Scan it. Stash it. Replace what is worth keeping, recycle what is not.

No account, no server, no upload — everything stays on the machine it runs on.

![Scan and stash](docs/scan-stash.png)

## Quick start

```bash
git clone https://github.com/SalehGhobari/MLH-Hackathon-_Fahes.git
cd MLH-Hackathon-_Fahes
npm install
npm run dev
```

Or use the launcher, which works from any directory:

```bash
./run.sh                                             # Linux
powershell -ExecutionPolicy Bypass -File .\run.ps1   # Windows
```

Requires **Node.js 20+**. Linux optionally uses `smartmontools` and `lm-sensors` for drive health and temperatures; the
app degrades gracefully and prints the install command for your distro. On Windows, run as administrator for
reliability counters and thermal zones.

## Features

| | |
|---|---|
| **Scan** | local hardware (battery, disks, SMART, RAM, thermals), removable/USB devices, private-LAN sweep |
| **Replace** | compatible parts from 338 real OpenSooq listings, with city, price and compatibility badges |
| **Recycle** | per-item photos, verified recycler, PDF handover manifest with mass/material estimates |
| **Impact** | diverted kilograms, avoided CO₂e and recovered materials per stash |
| **Arabic** | full RTL layout, Arabic market parsing and search |
| **Local AI** | optional Ollama model turns a sentence into filters — never into prices, specs or health scores |

### Recycle

![Recycle stash and manifest](docs/recycle-stash.png)

Add a photo to each item, pick a recycler, generate the manifest, then **Email recycler** opens your mail app with a
ready message. The manifest includes a data-destruction warning and the exact wipe command for each detected drive
(`nvme sanitize`, `hdparm security-erase`, `shred`).

### Replace

![Replacement target and market](docs/replace-market.png)

Search in Arabic or English, filter by category, condition and price, and hide incompatible parts. Compatibility is
derived from the detected machine (DDR generation, SO-DIMM/DIMM, NVMe/SATA) and is conservative: known mismatch is
flagged, missing data says *check* rather than guessing.

## How it works

```
Electron main (Node)                  Renderer (plain HTML/CSS/JS)
  lib/detect/  hardware + LAN scan      ui/  no frameworks
  lib/market/  OpenSooq index           strict CSP, no network, no Node
  lib/store.ts local JSON store
  lib/passport.ts signed second-life record
        ↕ IPC with contextIsolation
```

Design rules:

1. **Deterministic data.** Prices, compatibility, mass and impact never come from a model.
2. **No invented numbers.** Missing values are `unknown`; estimates are labelled and shown as ranges.
3. **Local only.** No telemetry, accounts, update pings or remote assets.

## Data and privacy

- Stored in `fahes-data.json` under `~/.config/Fahes` (Linux) or `%APPDATA%\Fahes` (Windows), file mode `0600`.
- Serials are hashed; delete the file to delete everything.
- The renderer has no network or Node access.
- The wipe record is an operator **attestation**, not cryptographic proof of erasure — the UI says so.
- **Nothing leaves the machine unless you enable the optional DeepSeek matching** described below. There is no
  telemetry, no account and no update ping.

## Optional: DeepSeek matching

Off by default, and the app is fully functional without it. When you turn it on, Fahes sends the part name, category
and detected specs to `api.deepseek.com` and asks it to pick from data already on your machine. Nothing else is sent,
and the renderer keeps `connect-src 'none'`.

The integration is built so the model cannot invent a fact:

- **Matching is a closed set.** The main process builds a numbered shortlist of real rows — OpenSooq listings or
  price-book entries — and the model may only return ids from that shortlist. Anything else is counted and discarded
  (the UI shows how many were dropped), so a hallucinated listing or price can never reach the screen.
- **Prices are never requested.** They come from the rows we already hold.
- **Physical specs are a labelled estimate.** Weight, dimensions and materials come back as a separate layer
  (`aiPhysical`) and never overwrite the deterministic estimate. Where they appear — including the manifest PDF —
  they carry a "DeepSeek estimate — unverified" label, and you have to explicitly choose to use them.

The API key is stored through Electron's `safeStorage`. On a Linux box with no keyring that falls back to plaintext
storage, and the Info tab says so rather than implying the key is encrypted.

```bash
npm run test:deepseek   # key round-trip, closed-set validation, aiPhysical layering (no network)
```

## Build

```bash
npm run pack:linux   # release/Fahes-0.1.0-x86_64.AppImage
npm run pack:win     # release/Fahes-Setup-0.1.0-x64.exe  (run on Windows)
```

Tests and checks:

```bash
npm run typecheck
npm run test:scan    # hardware + demo scan, store/passport round-trip (no GUI)
npm run test:stash   # stash, photo, manifest, ledger (no GUI)
```

## Known limits

macOS is unsupported. Windows sensor coverage varies by vendor. Prices are dated snapshots and will go stale — every
number ships with its source and capture date. The second-life passport proves the record was not altered, not that it
is true.

## License

MIT — see [`LICENSE`](LICENSE).
