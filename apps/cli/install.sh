#!/bin/sh
# Bootstraps `tether-academy` on a machine with nothing installed yet.
#
#   curl -fsSL https://raw.githubusercontent.com/thisonedev/tether-academy/master/apps/cli/install.sh | sh
#
# This script's only job is getting Node running against a checkout of the
# repo. The actual install logic (clone into ~/.tether-academy/versions/<sha>,
# pnpm install, build, symlink `current`, write the PATH shim) lives in one
# place, apps/cli/src/install.js, and runs from the checkout this script
# makes. There's no separate copy of that logic to drift out of sync.
set -eu

REPO_URL="${TETHER_ACADEMY_REPO:-https://github.com/thisonedev/tether-academy.git}"
BRANCH="${TETHER_ACADEMY_BRANCH:-master}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "tether-academy install requires $1 ($2)" >&2
    exit 1
  fi
}

need git "https://git-scm.com"
need node "https://nodejs.org"
need pnpm "npm install -g pnpm"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/tether-academy-bootstrap.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT INT TERM

echo "-> Fetching installer from $REPO_URL ($BRANCH)..."
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$tmp_dir"

# Not `exec`: the EXIT trap must still fire afterward to clean up $tmp_dir.
node "$tmp_dir/apps/cli/bin/tether-academy.js" install
