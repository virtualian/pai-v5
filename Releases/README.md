<div align="center">

<img src="release-icon-v2.png" alt="PAI Releases" width="256">

# PAI Releases

</div>

---

## What Are Releases?

Releases are **complete `.claude/` directories** ready to drop into your home folder. Each release contains everything you need: skills, hooks, workflows, memory structure, and configuration.

This is the fastest way to get PAI running. Copy the directory, run the wizard, restart Claude Code.

> **Note:** The `.claude` directory is hidden by default on macOS/Linux. Use `ls -la` to see it.

---

## Available Releases

The active release line lives in this directory:

- **[v5.0.0 →](v5.0.0/)** — complete `.claude/` directory, ready to install
- **[v5.0.0-overlay →](v5.0.0-overlay/)** — overlay directives layered onto an existing `~/.claude/`

Prior version snapshots (`v2.3`–`v4.0.3`) have been removed from the working tree. They
remain in git history and are reachable via their release tags (e.g. `git checkout v4.0.3`).

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/danielmiessler/Personal_AI_Infrastructure.git
cd Personal_AI_Infrastructure/Releases/v5.0.0

# 2. Copy the release and run the installer
cp -r .claude ~/ && cd ~/.claude && bash install.sh
```

The wizard asks for your name, AI name, timezone, temperature unit, and optional voice preferences.

See the [main README](../README.md#upgrading-from-a-previous-version) for upgrade instructions.

---

## Troubleshooting

**Can't see .claude directory?** It's hidden. Use `ls -la ~/` or press `Cmd+Shift+.` in Finder.

**Hooks not firing?** Restart Claude Code after installation.

---

**Questions?** See the main [PAI README](../README.md).
