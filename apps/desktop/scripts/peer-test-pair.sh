#!/usr/bin/env bash
# Spawn two tether-academy desktop instances on the same machine, each with its
# own user-data dir so they get distinct identities and can pair with each other.
# Window positions are nudged to side-by-side so the two UIs don't overlap.
#
# Usage: ./scripts/peer-test-pair.sh [/path/to/second-instance-user-data]
#   defaults second user-data to /tmp/tether-test-instance-2

set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$(cd ../.. && pwd)"

DATA_2="${1:-/tmp/tether-test-instance-2}"
mkdir -p "$DATA_2"

cleanup() {
  echo
  echo "[peer-test] shutting down both instances"
  if [[ -n "${PID1:-}" ]]; then kill "$PID1" 2>/dev/null || true; fi
  if [[ -n "${PID2:-}" ]]; then kill "$PID2" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "[peer-test] killing any leftover Electron instances (from previous runs)"
pkill -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1

echo "[peer-test] rebuilding bridge, UI, and web static export (clears incremental cache so the latest source lands in the running app)"
rm -f packages/ui/tsconfig.tsbuildinfo packages/academy-bridge/tsconfig.tsbuildinfo
pnpm --filter '@academy/academy-bridge' build
pnpm --filter '@academy/ui' build
# Refreshes the bundled web app the renderer loads; skips the lint/yaml pre-checks for speed.
echo "[peer-test] running next build for apps/web (skipping lint/yaml pre-checks)"
pnpm --filter '@academy/web' exec next build

# If a previous run left a SingletonLock behind, clear it so instance 1 can start fresh.
LOCK="/Users/source/Library/Application Support/Tether Academy/SingletonLock"
if [[ -e "$LOCK" ]]; then
  echo "[peer-test] removing stale lock: $LOCK"
  rm -f "$LOCK"
fi

echo "[peer-test] starting instance 1 (default userData)"
pnpm exec electron . --no-sandbox &
PID1=$!

# Wait a beat so instance 1 grabs its singleton lock before instance 2 starts.
sleep 2

echo "[peer-test] starting instance 2 (user-data: $DATA_2)"
pnpm exec electron . --no-sandbox --user-data-dir="$DATA_2" &
PID2=$!

echo "[peer-test] both running. PIDs: $PID1, $PID2"
echo "[peer-test] open Settings > Devices in each window to pair them."
echo "[peer-test] press Ctrl+C to stop both."

wait
