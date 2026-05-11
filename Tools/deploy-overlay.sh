#!/usr/bin/env bash
#
# deploy-overlay.sh — apply Releases/v5.0.0-overlay/ to live ~/.claude/
#
# Class A (pure overlay): rsync verbatim → ~/.claude/<path>
# Class B (merge):        *.overlay files → jq deep-merge into ~/.claude/<base>
# Class C/D:              never in overlay (see Releases/v5.0.0-overlay/README.md)
#
# Idempotent. Run after every fresh upstream install or whenever
# the overlay tree changes.
#
# Requires: bash, rsync, jq.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERLAY_DIR="$REPO_ROOT/Releases/v5.0.0-overlay"
LIVE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

if [[ ! -d "$OVERLAY_DIR" ]]; then
  echo "ERROR: overlay tree not found at $OVERLAY_DIR" >&2
  exit 1
fi

if [[ ! -d "$LIVE_DIR" ]]; then
  echo "ERROR: live tree not found at $LIVE_DIR (CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-unset})" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not installed (needed for Class B merge)" >&2
  exit 1
fi

echo "deploying overlay $OVERLAY_DIR → $LIVE_DIR"

# Class A: rsync everything except README.md and *.overlay
# rsync's --checksum makes it idempotent (re-runs are no-ops if files match)
rsync -a --checksum \
  --exclude='README.md' \
  --exclude='*.overlay' \
  "$OVERLAY_DIR/" "$LIVE_DIR/"

# Class B: per-file JSON deep-merge
# For each <path>.overlay file under overlay/, merge into <path> under live/.
while IFS= read -r -d '' overlay_file; do
  rel_path="${overlay_file#$OVERLAY_DIR/}"
  base_rel="${rel_path%.overlay}"
  live_target="$LIVE_DIR/$base_rel"

  if [[ ! -f "$live_target" ]]; then
    echo "  WARN: live target $live_target missing — copying overlay verbatim (stripped of _* keys)"
    jq 'walk(if type=="object" then with_entries(select(.key | startswith("_") | not)) else . end)' \
      "$overlay_file" > "$live_target"
    continue
  fi

  # Strip metadata keys (_overlay_doc, _why, _voiceEnabled_why, etc.) from overlay before merge.
  # Then deep-merge: live * overlay (overlay wins on conflict; objects merge recursively;
  # arrays REPLACE, see WARNING below).
  tmpfile="$(mktemp)"
  jq -s --argfile overlay <(jq 'walk(if type=="object" then with_entries(select(.key | startswith("_") | not)) else . end)' "$overlay_file") \
    '.[0] * $overlay' "$live_target" > "$tmpfile"

  # Idempotency check: only write if content actually differs
  if ! cmp -s "$tmpfile" "$live_target"; then
    mv "$tmpfile" "$live_target"
    echo "  merged: $base_rel"
  else
    rm "$tmpfile"
    echo "  unchanged: $base_rel"
  fi
done < <(find "$OVERLAY_DIR" -type f -name '*.overlay' -print0)

# WARNING: jq's `*` operator REPLACES arrays rather than concatenating.
# For settings.json's loadAtStartup and hooks.PreToolUse arrays, the overlay's
# entries currently REPLACE upstream's entries. This is acceptable while the
# overlay's arrays are a strict superset of upstream's, but breaks the moment
# upstream adds a new entry we want to keep.
#
# TODO(v5-overlay): per-key array-append handler for known array keys
# (loadAtStartup, hooks.*, permissions.*). Until then, after every
# upstream upgrade, run check-overlay.sh and manually reconcile arrays.

echo "done. run check-overlay.sh to verify."
