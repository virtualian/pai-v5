#!/usr/bin/env bash
#
# check-overlay.sh — diff Releases/v5.0.0-overlay/ against live ~/.claude/
#
# For each overlay file, suggest one of:
#   drop   — live matches overlay; upstream may have addressed our fix
#   keep   — live unchanged from upstream; overlay still needed
#   merge  — live differs in unexpected ways; manual reconciliation required
#   ok     — Class B file, all overlay keys present and equal in live
#
# Exits 0 always (informational). Use grep on output to drive workflow.

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
  echo "ERROR: jq not installed (needed for Class B comparison)" >&2
  exit 1
fi

echo "checking overlay $OVERLAY_DIR vs live $LIVE_DIR"
echo

# Class A files
while IFS= read -r -d '' overlay_file; do
  rel_path="${overlay_file#$OVERLAY_DIR/}"
  case "$rel_path" in
    README.md|*.overlay|*.imports) continue ;;
  esac
  live_target="$LIVE_DIR/$rel_path"

  if [[ ! -f "$live_target" ]]; then
    printf '  %-7s  %s   (live missing; deploy will create it)\n' 'keep' "$rel_path"
    continue
  fi

  if cmp -s "$overlay_file" "$live_target"; then
    printf '  %-7s  %s   (live = overlay; upstream may have absorbed this — drop candidate)\n' 'drop?' "$rel_path"
  else
    # Differs. Check if the overlay's exact line-set is a subset of live (i.e., live = upstream + our patch).
    # Heuristic: if `diff` shows ONLY additions on the live side relative to overlay, it's a divergence.
    line_diff=$(diff "$overlay_file" "$live_target" | head -10)
    if [[ -z "$line_diff" ]]; then
      printf '  %-7s  %s   (somehow differs but no diff lines — investigate)\n' 'merge' "$rel_path"
    else
      printf '  %-7s  %s   (live differs — first 10 diff lines below)\n' 'merge' "$rel_path"
      echo "$line_diff" | sed 's/^/         /'
    fi
  fi
done < <(find "$OVERLAY_DIR" -type f -print0)

# Class B files
while IFS= read -r -d '' overlay_file; do
  rel_path="${overlay_file#$OVERLAY_DIR/}"
  base_rel="${rel_path%.overlay}"
  live_target="$LIVE_DIR/$base_rel"

  if [[ ! -f "$live_target" ]]; then
    printf '  %-7s  %s   (live %s missing; deploy will create)\n' 'keep' "$rel_path" "$base_rel"
    continue
  fi

  # Strip metadata keys before comparing
  stripped_overlay="$(jq 'walk(if type=="object" then with_entries(select(.key | startswith("_") | not)) else . end)' "$overlay_file")"

  # For each top-level overlay key, check if live has the same value.
  missing_or_drift=()
  while IFS= read -r key; do
    overlay_val="$(echo "$stripped_overlay" | jq --arg k "$key" '.[$k]')"
    live_val="$(jq --arg k "$key" '.[$k]' "$live_target")"
    if [[ "$overlay_val" != "$live_val" ]]; then
      missing_or_drift+=("$key")
    fi
  done < <(echo "$stripped_overlay" | jq -r 'keys[]')

  if [[ ${#missing_or_drift[@]} -eq 0 ]]; then
    printf '  %-7s  %s   (all overlay keys equal in live)\n' 'ok' "$rel_path"
  else
    printf '  %-7s  %s   (drift on keys: %s)\n' 'merge' "$rel_path" "${missing_or_drift[*]}"
  fi
done < <(find "$OVERLAY_DIR" -type f -name '*.overlay' -print0)

# Class B-imports files
while IFS= read -r -d '' imports_file; do
  rel_path="${imports_file#$OVERLAY_DIR/}"
  base_rel="${rel_path%.imports}"
  live_target="$LIVE_DIR/$base_rel"

  if [[ ! -f "$live_target" ]]; then
    printf '  %-7s  %s   (live %s missing; deploy will warn)\n' 'keep' "$rel_path" "$base_rel"
    continue
  fi

  missing=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if ! grep -Fxq "$line" "$live_target"; then
      missing+=("$line")
    fi
  done < "$imports_file"

  if [[ ${#missing[@]} -eq 0 ]]; then
    printf '  %-7s  %s   (all @imports present in live)\n' 'ok' "$rel_path"
  else
    printf '  %-7s  %s   (missing @imports: %s)\n' 'merge' "$rel_path" "${missing[*]}"
  fi
done < <(find "$OVERLAY_DIR" -type f -name '*.imports' -print0)

echo
echo "done. legend: drop?=upstream may have absorbed; keep=overlay still needed; merge=manual reconcile; ok=Class B/Class B-imports in sync."
