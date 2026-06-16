#!/bin/bash
# PAI Status Line — Minimal with toggle support
#
# Modes (set in settings.json → statusline.mode):
#   "minimal" (default) — single-line compact display
#   "full"              — original PAI statusline with all sections
#
# Layout: Context% FolderName BranchName #PR

set -o pipefail

PAI_DIR="${PAI_DIR:-$HOME/.claude}"
SETTINGS_FILE="$PAI_DIR/settings.json"

# ── Mode toggle ───────────────────────────────────────────────────────────────

sl_mode=$(jq -r '.statusline.mode // "minimal"' "$SETTINGS_FILE" 2>/dev/null)
sl_mode="${sl_mode:-minimal}"

if [ "$sl_mode" = "full" ] && [ -f "$PAI_DIR/statusline-full.sh" ]; then
    exec bash "$PAI_DIR/statusline-full.sh"
fi

# ── Parse input JSON ──────────────────────────────────────────────────────────

input=$(cat)

# context %, both rate-limit allowances (5h session + 7d weekly) with their reset
# epochs, the live session effort, working dir, and model label. resets_at is a
# native epoch integer (Claude Code v2.1.80+); .effort.level reflects /effort changes.
eval "$(echo "$input" | jq -r '
  "context_pct=" + (.context_window.used_percentage // 0 | round | tostring) + "\n" +
  "session_pct=" + (.rate_limits.five_hour.used_percentage // 0 | round | tostring) + "\n" +
  "session_reset=" + (.rate_limits.five_hour.resets_at // "" | tostring | @sh) + "\n" +
  "weekly_pct=" + (.rate_limits.seven_day.used_percentage // 0 | round | tostring) + "\n" +
  "weekly_reset=" + (.rate_limits.seven_day.resets_at // "" | tostring | @sh) + "\n" +
  "effort_in=" + (.effort.level // "" | @sh) + "\n" +
  "current_dir=" + (.workspace.current_dir // .cwd | @sh) + "\n" +
  "model_id=" + (.model.display_name // .model.id // "" | gsub(" context"; "") | @sh)
')"

# Effort: prefer the LIVE session value from the payload (.effort.level — reflects
# mid-session /effort changes); fall back to the persisted settings.json default,
# then "auto". The previous code read only settings.json, so a session-only /effort
# change (e.g. "max") never appeared here.
effort_name="$effort_in"
[ -z "$effort_name" ] && effort_name=$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null)
effort_name="${effort_name:-auto}"

# ── Context color ─────────────────────────────────────────────────────────────

[ "$context_pct" -gt 100 ] && context_pct=100
[ "$weekly_pct" -gt 100 ] && weekly_pct=100

pct_color_for() {
    local v="$1"
    if [ "$v" -lt 60 ]; then
        echo '\033[38;2;74;222;128m'     # emerald <60%
    elif [ "$v" -lt 80 ]; then
        echo '\033[38;2;251;191;36m'     # amber 60-79%
    else
        echo '\033[38;2;251;113;133m'    # rose 80%+
    fi
}
pct_color=$(pct_color_for "$context_pct")
weekly_color=$(pct_color_for "$weekly_pct")

# ── Project folder + Git branch ───────────────────────────────────────────────

folder_name=$(basename "$current_dir")

branch=""
if git rev-parse --git-dir > /dev/null 2>&1; then
    branch=$(git branch --show-current 2>/dev/null || echo "detached")
    [ ${#branch} -gt 15 ] && branch="${branch:0:15}..."
fi

# ── Hostname ─────────────────────────────────────────────────────────────────

host_short=$(hostname -s 2>/dev/null || hostname)

# ── Output (single line) ─────────────────────────────────────────────────────

RST='\033[0m'
DIM='\033[38;2;148;163;184m'
BLUE='\033[38;2;96;165;250m'
CYAN='\033[38;2;34;211;238m'
PURPLE='\033[38;2;167;139;250m'

# ── Allowance countdowns (T-minus to reset) ───────────────────────────────────
# Weekly (7d): days if >=1 day remains, else hours. Session (5h): hours if >=1h
# remains, else minutes. resets_at is epoch seconds; a missing or past reset drops
# the "-..." suffix and only the bare percentage is shown. Smallest unit is
# clamped to >=1 so it never reads "0mins"/"0h".
[ "${session_pct:-0}" -gt 100 ] 2>/dev/null && session_pct=100
session_color=$(pct_color_for "${session_pct:-0}")
now=$(date +%s)

_until_weekly() {   # epoch -> "Nd" | "Nh" | ""
    local r="$1" s
    case "$r" in ''|*[!0-9]*) echo ""; return ;; esac
    s=$(( r - now )); [ "$s" -le 0 ] && { echo ""; return; }
    local d=$(( s / 86400 ))
    if [ "$d" -ge 1 ]; then echo "${d}d"; else local h=$(( s / 3600 )); [ "$h" -lt 1 ] && h=1; echo "${h}h"; fi
}
_until_session() {  # epoch -> "Nh" | "Nm" | ""
    local r="$1" s
    case "$r" in ''|*[!0-9]*) echo ""; return ;; esac
    s=$(( r - now )); [ "$s" -le 0 ] && { echo ""; return; }
    local h=$(( s / 3600 ))
    if [ "$h" -ge 1 ]; then echo "${h}h"; else local m=$(( s / 60 )); [ "$m" -lt 1 ] && m=1; echo "${m}m"; fi
}

weekly_cd=$(_until_weekly "$weekly_reset")
session_cd=$(_until_session "$session_reset")

# nn% keeps its threshold color; the dimmed -<countdown> trails it.
weekly_field="${weekly_color}${weekly_pct}%%${RST}"
[ -n "$weekly_cd" ] && weekly_field="${weekly_field}${DIM}-${weekly_cd}${RST}"
session_field="${session_color}${session_pct}%%${RST}"
[ -n "$session_cd" ] && session_field="${session_field}${DIM}-${session_cd}${RST}"
context_field="${pct_color}${context_pct}%%${RST}"

# ── Model + effort prefix ─────────────────────────────────────────────────────

prefix=""
[ -n "$model_id" ] && prefix="${CYAN}${model_id}${RST}"
[ -n "$effort_name" ] && prefix="${prefix} ${PURPLE}${effort_name}${RST}"
[ -n "$prefix" ] && prefix="${prefix} "

# Line: <model> <effort>  <weekly>-Nd|<session>-N(h|m)|<context>%  host folder branch
printf "${prefix}${weekly_field}${DIM}|${RST}${session_field}${DIM}|${RST}${context_field} ${DIM}${host_short}${RST} ${BLUE}${folder_name}${RST}"
[ -n "$branch" ] && printf " ${DIM}${branch}${RST}"
printf "\n"
