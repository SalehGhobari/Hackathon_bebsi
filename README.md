# Fahes · فحص

**A Jordanian replace-and-recycle app for laptops, desktops and the devices around them.**

Scan this PC, its removable drives, USB peripherals or the local network, then file each item under **Recycle** or
**Replace**. Replacements are searched live on OpenSooq and priced in JOD; recyclables become a photo-backed PDF
manifest for a verified Amman e-waste partner.

Built for the Jordanian market: local prices, local classifieds, local recyclers, Arabic RTL UI.

> Scan it. Stash it. Replace what is worth keeping, recycle what is not.

No account and no server. Everything stays on the machine it runs on unless you switch on the optional DeepSeek
matching described below.

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
| **Replace** | live OpenSooq search plus a bundled offline index, with city, price and compatibility badges |
| **Recycle** | per-item photos and specs, verified recycler, PDF handover manifest |
| **Impact** | diverted kilograms, avoided CO₂e and recovered materials per stash |
| **Arabic** | full RTL layout, Arabic market parsing and search |
| **Local AI** | optional Ollama model turns a sentence into filters — never into prices, specs or health scores |

### Recycle

![Recycle stash and manifest](docs/recycle-stash.png)

Add a photo to each item, pick a recycler, generate the manifest, then **Email recycler** opens your mail app with a
ready message. Every item carries a weight, dimensions and recoverable materials, and the manifest prints them per
item. It also includes a data-destruction warning and the exact wipe command for each detected drive
(`nvme sanitize`, `hdparm security-erase`, `shred`).

### Replace

![Replacement target and market](docs/replace-market.png)

Type a part and search OpenSooq live — the query you enter is fetched and parsed on the spot, so a specific part is
not limited to the bundled index. The bundled index stays for offline use, and if a live fetch returns nothing the
stored listings remain and the note says which was used.

Filter in Arabic or English, by category, condition and price, and hide incompatible parts. Compatibility is derived
from the detected machine (DDR generation, SO-DIMM/DIMM, NVMe/SATA) and is conservative: a known mismatch is flagged,
missing data says *check* rather than guessing.

Retail price rows are dated snapshots from Jordanian vendors, each carrying its source and capture date. Those shops
render their price grids client-side, so the app does not read a live price from them — instead every retail match
links to the vendor's product page and to a live search for that exact part, so the current price is one click away.

## How it works

```
Electron main (Node)                  Renderer (plain HTML/CSS/JS)
  lib/detect/  hardware + LAN scan      ui/  no frameworks
  lib/market/  OpenSooq index + live query    strict CSP
  lib/store.ts local JSON store
  lib/passport.ts signed second-life record
        ↕ IPC with contextIsolation
```

Design rules:

1. **Deterministic data.** Prices, compatibility, mass and impact never come from a model.
2. **No invented numbers.** Missing values are `unknown`; estimates are labelled and shown as ranges.
3. **Local by default.** No telemetry, accounts, update pings or remote assets. The one exception is the optional
   DeepSeek matching, which is off until you turn it on.

## Data and privacy

- Stored in `fahes-data.json` under `~/.config/Fahes` (Linux) or `%APPDATA%\Fahes` (Windows), file mode `0600`.
- Serials are hashed; delete the file to delete everything.
- The renderer has no network or Node access.
- The wipe record is an operator **attestation**, not cryptographic proof of erasure — the UI says so.
- **Nothing leaves the machine unless you enable the optional DeepSeek matching.**

## Optional: DeepSeek matching

Off by default, and the app works fully without it. When on, Fahes sends the part name, category and detected specs to
`api.deepseek.com`; nothing else is sent and the renderer keeps `connect-src 'none'`. The key is stored through
Electron's `safeStorage`, and the Info tab says whether it is really encrypted or only obfuscated (which is what
happens on a Linux box with no keyring).

It does two things: **matching** ranks a stashed item against the OpenSooq index or the retail price book, and
**specs** fills in a recycle item's weight, dimensions and materials — automatically when you stash something, or via
**Add specs**.

The model cannot invent a fact. Matching is a **closed set**: the main process builds a shortlist of real rows and the
model may only return ids from it, with anything else counted and discarded. Prices are never requested. Specs are a
labelled estimate shown beside the deterministic one, and marked "DeepSeek estimate — unverified" wherever they
appear, including the manifest PDF.

`DEEPSEEK_BASE_URL` overrides the endpoint for a proxy.

## Build

```bash
npm run pack:linux   # release/Fahes-0.1.0-x86_64.AppImage
npm run pack:win     # release/Fahes-Setup-0.1.0-x64.exe  (run on Windows)
```

Tests and checks:

```bash
npm run typecheck
npm run test:scan       # hardware + demo scan, store/passport round-trip (no GUI)
npm run test:stash      # stash, photo, manifest, ledger (no GUI)
npm run test:market     # OpenSooq parsing and buckets (no network)
npm run test:classify   # part-vs-machine classification cases (no network)
npm run test:retail     # retail query shaping and click-through links (no network)
npm run test:deepseek   # key round-trip, closed-set validation, spec layering (no network)
```

## License

MIT — see [`LICENSE`](LICENSE).
