# v5.0.0 Overlay

This tree contains the fork's targeted modifications to a vanilla PAI v5.0.0 install.
It does NOT contain v5.0.0 itself — it sits on top of whatever upstream's installer
puts down at `~/.claude/`.

## Why an overlay (not a fork-and-patch)

Upstream ships v5.0.0 as a tarball, not a git clone. Editing tarball-installed
files directly under `~/.claude/` risks losing fixes on next upgrade and conflates
source with runtime state (`history.jsonl`, `sessions/`, caches). The overlay
pattern keeps `~/.claude/` vanilla and re-applies our changes after each
upstream upgrade.

## Three deploy classes (plus runtime state, excluded entirely)

| Class | Examples | Strategy | In overlay? |
|---|---|---|---|
| **A. Pure overlay** | `askuq-gate.md`, modified `Algorithm/*.md` patches, hook overlays | Replace via rsync | YES |
| **B. Merge-semantics** | `settings.json` (CC adds keys; user adds permissions), `CLAUDE.md` | Per-file merge logic in `deploy-overlay.sh` (JSON merge, section append) | YES (as `*.overlay` files) |
| **C. Self-updating** | `AISTEERINGRULES.md` (auto-extended by `/learn`), `MEMORY/**`, `USER/PRINCIPAL_IDENTITY.md`, `USER/DA_IDENTITY.md` | One-time copy at Phase C cutover, then leave alone | NO — personalisation transfer list |
| **D. Runtime state** | `history.jsonl`, `sessions/`, `cache/`, `.credentials.json` | Never tracked anywhere | NO |

PAI self-updates Class-C files (notably `AISTEERINGRULES.md` via `/learn` and
`MEMORY/**` via the auto-memory system). If those lived in the overlay, every
`deploy-overlay.sh` run would stomp accumulated state.

> **Exception — `PAI/USER/SECURITY/PATTERNS.yaml`.** The model above treats `USER/`-tree
> files as personalisation (Class C, not overlaid). `PATTERNS.yaml` is the deliberate
> exception: it is a *static* security config (the catastrophic-command guardrail), not
> self-updating personalisation, so it does not fit Class C. A hardened copy is tracked as
> **Class A** so the security fix is version-controlled and redeploys with the overlay.
> Trade-off: `deploy-overlay.sh` rsync-overwrites the live file, so any user-local edit to
> `PATTERNS.yaml` on a target host is clobbered on next deploy. (pai-v5#12)

## Current contents

| Path | Class | Source | Why it's here |
|---|---|---|---|
| `PAI/AISTEERINGRULES.md` | A | runtime (auto-extended; 95 lines) | System-level behavioural rules ("Surgical fixes only", "Never assert without verification", scope-lock, etc.). Vanilla v5.0.0 has none. **System file**, not the user-overrides at `PAI/USER/AISTEERINGRULES.md` (which is Class C). |
| `PAI/ALGORITHM/askuq-gate.md` | A | synthesised | Addendum to v6.3.0 OBSERVE phase: makes AskUserQuestion ENUMERATE→OFFER a phase-exit hard gate (fork's v3.7.0 had it; v6.3.0 mentions but doesn't gate). |
| `PAI/PAI-Install/engine/repo-url.ts` | A | v4.0.3+ committed | Repo URL helper for installer flows. |
| `PAI/TOOLS/preserve-claudemd.ts` + `.test.ts` | A | v4.0.3+ committed | Preserves user `CLAUDE.md` `@-imports` + safety backup on rebuild (PR #126/#127). Independent of two-root. |
| `PAI/TOOLS/WorkArchival.ts` | A | v4.0.3+ committed | Archival tool for completed work entries. Independent of two-root. |
| `PAI/USER/SECURITY/PATTERNS.yaml` | A (exception) | vanilla v5.0.0 + 2 patterns | Hardened security guardrail: adds `bash.blocked` rules for `rm -rf $HOME`/`${HOME}` and recursive `chmod` on root — both passed silently in vanilla (pai-v5#12; upstream issue #1299). First `USER/`-tree file in the overlay — see exception note above. |

### Files NOT in this overlay (deliberately)

- **Two-root migration machinery** (`pai-paths.ts`, `pai-runtime-migration.ts`,
  `memory-migration{,.test}.ts`, `skill-migration{,.test}.ts`,
  `command-migration.ts`, `exec.ts`) — present in `Releases/v4.0.3+/.claude/PAI-Install/engine/`
  on `virtualian/pai`, but not pulled in here. The two-root architecture
  port (HIGH#3 in the design doc; was issue #3 on this fork) is not being
  implemented; these 7 files exist solely to support that migration. If
  the decision changes later, they're recoverable from `virtualian/pai`'s
  `Releases/v4.0.3+/.claude/PAI-Install/engine/`.
| `settings.json.overlay` | B | synthesised | JSON-merge snippet setting `voiceEnabled: false` (replaces fork's voice-removal cascade). |

## Source authority rule

The fork has **two physical sources** for the same conceptual content:

- `marrair:~/projects/pai/Releases/v4.0.3+/.claude/...` — the **committed** tree (frozen as of `v4.0.3+-final` tag)
- `marrair:~/.pai/...` and `~/.claude/...` — the **live runtime**

These diverge because marrair's workflow has been edit-commit-without-immediately-reinstalling. So `Releases/v4.0.3+/` contains intentional code work that `install.sh` was supposed to deploy to runtime but never did.

| Subtree | Authority | Rationale |
|---|---|---|
| `PAI-Install/engine/*.ts` | v4 committed | Code, intentional, static |
| `hooks/*.hook.ts` and `hooks/lib/*.ts` (fork-side) | v4 committed | Code, intentional, static |
| `PAI/Tools/*.ts` | v4 committed | Code, intentional, static |
| `PAI/AISTEERINGRULES.md` | runtime | Auto-extended by `/learn` (52 → 95 lines between commit and snapshot) |
| `PAI/USER/AISTEERINGRULES.md` | runtime | Auto-extended by `/learn` (Class C — never overlay anyway) |
| `PAI/Algorithm/*.md` | **runtime** (rule exception) | Empirically newer in runtime — likely auto-extended by AlgorithmUpgrade workflow |
| `MEMORY/**` | runtime | AI-written; Class C |
| `PAI/USER/PRINCIPAL_IDENTITY.md`, `DA_IDENTITY.md`, etc. | runtime | Auto-updated by `/interview`; Class C |

## Deploy

From this clone, after a fresh `~/.claude/` from upstream's installer:

```bash
bash Tools/deploy-overlay.sh
```

Class A files rsync verbatim to `~/.claude/<path>`. Class B files
(`*.overlay`) JSON-merge with the corresponding live file using `jq`.

## Check for drift

```bash
bash Tools/check-overlay.sh
```

Per-file diff between this overlay and live `~/.claude/`. For each
divergence the script suggests one of:

- **drop** — upstream now matches our overlay; remove from overlay
- **keep** — upstream unchanged; overlay still needed
- **merge** — upstream changed the file but our patch is still required

## Personalisation transfer (NOT in this overlay)

These get copied once at Phase C cutover, then left alone:

- `~/.claude/PAI/USER/PRINCIPAL_IDENTITY.md`, `DA_IDENTITY.md`
- `~/.claude/PAI/USER/RESUME.md`, `BUSINESS/`, `OPINIONS.md`, `WRITINGSTYLE.md`, etc.
- `~/.claude/PAI/USER/AISTEERINGRULES.md` (user-overrides; distinct from system AISTEERINGRULES which IS in overlay)
- `~/.pai/MEMORY/**` (active memory tree; under `~/.pai/` if two-root, else `~/.claude/MEMORY/`)
- `~/.claude/CLAUDE-USER.md`, `marr/MARR-USER-CLAUDE.md`

## Upstream PR workflow

Each overlay file is a candidate fix for upstream:

```bash
git checkout -b feat/<short-description> upstream/main
# copy overlay file into the appropriate path
git add <path>
git commit -m '...'
git push origin feat/<short-description>
gh pr create --repo danielmiessler/Personal_AI_Infrastructure --base main
```

If accepted upstream, drop the file from the overlay (no longer needed).
