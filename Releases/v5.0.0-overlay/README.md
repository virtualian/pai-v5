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
| **A. Pure overlay** | `SecurityValidator.hook.ts`, modified `Algorithm/*.md` patches, hook overlays | Replace via rsync | YES |
| **B. Merge-semantics** | `settings.json` (CC adds keys; user adds permissions), `CLAUDE.md` | Per-file merge logic in `deploy-overlay.sh` (JSON merge, section append) | YES (as `*.overlay` files) |
| **C. Self-updating** | `AISTEERINGRULES.md` (auto-extended by `/learn`), `MEMORY/**`, `USER/PRINCIPAL_IDENTITY.md`, `USER/DA_IDENTITY.md` | One-time copy at Phase C cutover, then leave alone | NO — personalisation transfer list |
| **D. Runtime state** | `history.jsonl`, `sessions/`, `cache/`, `.credentials.json` | Never tracked anywhere | NO |

PAI self-updates Class-C files (notably `AISTEERINGRULES.md` via `/learn` and
`MEMORY/**` via the auto-memory system). If those lived in the overlay, every
`deploy-overlay.sh` run would stomp accumulated state.

## Current contents

| Path | Class | Source | Why it's here |
|---|---|---|---|
| `PAI/AISTEERINGRULES.md` | A | runtime (auto-extended; 95 lines) | System-level behavioural rules ("Surgical fixes only", "Never assert without verification", scope-lock, etc.). Vanilla v5.0.0 has none. **System file**, not the user-overrides at `PAI/USER/AISTEERINGRULES.md` (which is Class C). |
| `PAI/ALGORITHM/askuq-gate.md` | A | synthesised | Addendum to v6.3.0 OBSERVE phase: makes AskUserQuestion ENUMERATE→OFFER a phase-exit hard gate (fork's v3.7.0 had it; v6.3.0 mentions but doesn't gate). |
| `hooks/SecurityValidator.hook.ts` | A | v4 ≡ runtime | PreToolUse hard-block for catastrophic destructive ops (`rm -rf ~`, etc.) and confirm-gate for sensitive ones. Vanilla v5.0.0 has SecurityPipeline + ContentScanner + PromptGuard + ContainmentGuard but lacks the per-pattern destructive-intent gate. |
| `PAI/PAI-Install/engine/pai-paths.ts` | A | v4.0.3+ committed | **Shared path resolver** (commit `2a44839`, fork PR #162/#163). Reads `CLAUDE_CONFIG_DIR` + `PAI_DIR` env vars with sane defaults; eliminates hard-coded `~/.claude/` literals across migrators. Foundation of two-root architecture work (issue #3). NEVER deployed to marrair runtime — committed-but-not-installed. |
| `PAI/PAI-Install/engine/pai-runtime-migration.ts` | A | v4.0.3+ committed | Runtime migrator that moves `~/.claude/{PAI,hooks,MEMORY,…}` → `~/.pai/` when env vars indicate two-root. |
| `PAI/PAI-Install/engine/{memory,skill,command}-migration{,.test}.ts` | A | v4.0.3+ committed | Per-subtree migrators (PR #110, #121, #114). Move MEMORY, skills, commands respectively. With unit tests for memory and skill migrators. |
| `PAI/PAI-Install/engine/exec.ts` | A | v4.0.3+ committed | `tryExec` extraction (PR #121, #107). Migration helpers' shared error-handling. |
| `PAI/PAI-Install/engine/repo-url.ts` | A | v4.0.3+ committed | Repo URL helper for installer flows. |
| `PAI/TOOLS/preserve-claudemd.ts` + `.test.ts` | A | v4.0.3+ committed | Preserves user `CLAUDE.md` `@-imports` + safety backup on rebuild (PR #126/#127). |
| `PAI/TOOLS/WorkArchival.ts` | A | v4.0.3+ committed | Archival tool for completed work entries. |
| `settings.json.overlay` | B | synthesised | JSON-merge snippet wiring AISTEERINGRULES into `loadAtStartup`, registering SecurityValidator under `hooks.PreToolUse`, and setting `voiceEnabled: false` (replaces fork's voice-removal cascade). |

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
