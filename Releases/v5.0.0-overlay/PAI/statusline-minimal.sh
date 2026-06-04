#!/bin/bash
# PAI Status Line — Minimal with toggle support (pai-v5 overlay port)
#
# Modes (set in settings.json → statusline.mode):
#   "minimal" (default) — single-line compact display (this script)
#   "full"              — defers to v5's native PAI/statusline-command.sh
#
# Layout: model effort weekly%/context% hostname folder branch
#
# Ported from the marrair fork's runtime statusline-command.sh, which existed
# only in ~/.claude/ (unversioned). Adapted for v5's single-root layout:
#   - settings.json is read from $CLAUDE_CONFIG_DIR (not $PAI_DIR)
#   - the "full" target is v5's own responsive statusline at
#     $PAI_DIR/statusline-command.sh (not the fork's old statusline-full.sh)
# The statusLine JSON schema is identical between fork and v5, so the data
# extraction below is unchanged from the original.

set -o pipefail

CC_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PAI_DIR="${PAI_DIR:-$HOME/.claude/PAI}"
SETTINGS_FILE="$CC_DIR/settings.json"

# ── Mode toggle ───────────────────────────────────────────────────────────────

sl_mode=$(jq -r '.statusline.mode // "minimal"' "$SETTINGS_FILE" 2>/dev/null)
sl_mode="${sl_mode:-minimal}"

if [ "$sl_mode" = "full" ] && [ -f "$PAI_DIR/statusline-command.sh" ]; then
    exec bash "$PAI_DIR/statusline-command.sh"
fi

# ── Parse input JSON ──────────────────────────────────────────────────────────

input=$(cat)

eval "$(echo "$input" | jq -r '
  "context_pct=" + (.context_window.used_percentage // 0 | round | tostring) + "\n" +
  "weekly_pct=" + (.rate_limits.seven_day.used_percentage // 0 | round | tostring) + "\n" +
  "current_dir=" + (.workspace.current_dir // .cwd // "." | @sh) + "\n" +
  "model_id=" + (.model.display_name // .model.id // "" | gsub(" context"; "") | @sh)
')"

# Read persistent effort level from Claude Code settings (null/absent = auto)
effort_name=$(jq -r '.effortLevel // "auto"' "$SETTINGS_FILE" 2>/dev/null)
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

# ── Model + effort prefix ─────────────────────────────────────────────────────

prefix=""
[ -n "$model_id" ] && prefix="${CYAN}${model_id}${RST}"
[ -n "$effort_name" ] && prefix="${prefix} ${PURPLE}${effort_name}${RST}"
[ -n "$prefix" ] && prefix="${prefix} "

printf "${prefix}${weekly_color}${weekly_pct}%%${RST}${DIM}/${RST}${pct_color}${context_pct}%%${RST} ${DIM}${host_short}${RST} ${BLUE}${folder_name}${RST}"
[ -n "$branch" ] && printf " ${DIM}${branch}${RST}"
printf "\n"
