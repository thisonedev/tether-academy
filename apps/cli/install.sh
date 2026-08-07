#!/bin/sh
# Bootstraps `tether-academy` on a machine with nothing installed yet.
#
#   curl -fsSL https://tetheracademy.cc/install.sh | sh
#
# Only job: get Node running against a checkout so apps/cli/src/install.js
# (the actual install logic) can take over from there.
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

# bootstrap-install.js skips cli.js/paparam (see that file for why).
# Not `exec`: the EXIT trap must still fire to clean up $tmp_dir.
node "$tmp_dir/apps/cli/bin/bootstrap-install.js"
