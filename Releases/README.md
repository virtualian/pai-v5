<div align="center">

<img src="release-icon-v2.png" alt="PAI Releases" width="256">

# PAI Releases

</div>

---

## What Are Releases?

A release is a **complete `.claude/` directory** ready to drop into your home folder — skills, hooks, workflows, memory structure, and configuration: everything needed to run PAI.

The fastest way to install is the one-line installer (below). The release directory is also here to clone, inspect, or copy manually.

> **Note:** The `.claude` directory is hidden by default on macOS/Linux. Use `ls -la` to see it.

---

## Available Releases

### v5.0.0 — Life Operating System (Current)

The biggest release in PAI history. PAI is no longer "AI scaffolding" — it's a **Life Operating System**.

- **Pulse** — the unified daemon on port `31337`: voice, hooks, observability, cron, and the Life Dashboard. Replaces every previous loose service.
- **The DA** — a Digital Assistant identity layer (PRINCIPAL_IDENTITY + DA_IDENTITY), loaded at session start. `/interview` walks you through naming your DA, picking a voice, and capturing TELOS.
- **Algorithm v6.3.0** — a seven-phase loop (OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN) with a classifier that picks mode (MINIMAL / NATIVE / ALGORITHM) and effort tier per prompt.
- **The ISA** — the Ideal State Artifact primitive: one document, twelve sections, capturing what "done" looks like for any task.
- **Containment + release tooling** — privacy is structural. Containment zones declare every directory's privacy class and a guard hook blocks cross-zone leaks; releases pass security gates before publish.
- **Memory v7.6** — structured by purpose: WORK, KNOWLEDGE (typed graph), LEARNING, RELATIONSHIP, OBSERVABILITY, STATE.
- **45 skills, 171 workflows, 37 hooks.**

**[Get v5.0.0 →](v5.0.0/)** · **[Release notes →](v5.0.0/README.md)**

### v5.0.0-overlay — Class B-imports overlay

A deliberately thin overlay layered onto an existing vanilla v5.0.0 `~/.claude/`, rather than a full release. It carries a `CLAUDE.md.imports` manifest plus a small `PAI/` subtree of directives — applied on top of a v5.0.0 install instead of replacing it.

**[Get the overlay →](v5.0.0-overlay/)**

> **Earlier versions:** the prior `v2.3`–`v4.0.3` snapshots have been removed from the working tree. They remain in git history and are reachable via their release tags (e.g. `git checkout v4.0.3`).

---

## Installation

### One-line install (recommended)

```bash
curl -sSL https://ourpai.ai/install.sh | bash
```

The installer verifies Bun, Git, and Claude Code, sets up your DA identity (name + voice + personality), registers Pulse as a service, and validates. An existing `~/.claude/` is backed up first.

### Manual install (clone + run)

```bash
git clone https://github.com/danielmiessler/Personal_AI_Infrastructure.git
cd Personal_AI_Infrastructure/Releases/v5.0.0
cp -R .claude ~/ && cd ~/.claude && ./install.sh
```

The wizard asks for your name, DA name, timezone, and optional voice preferences.

See the [main README](../README.md#upgrading-from-v4x) for upgrade instructions.

---

## Troubleshooting

**Can't see .claude directory?** It's hidden. Use `ls -la ~/` or press `Cmd+Shift+.` in Finder.

**Hooks not firing?** Restart Claude Code after installation.

---

**Questions?** See the main [PAI README](../README.md).
