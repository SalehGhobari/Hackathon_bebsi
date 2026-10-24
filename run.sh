#!/usr/bin/env bash
# Fahes launcher. Always runs from the repository, no matter where you call it from.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install them first (e.g. sudo pacman -S nodejs npm, or sudo apt install nodejs npm)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install
fi

# npm 12 blocks Electron's postinstall by default; fetch the binary if needed.
if [ ! -x node_modules/electron/dist/electron ]; then
  echo "Fetching the Electron runtime…"
  node node_modules/electron/install.js || true
fi

exec npm run dev
