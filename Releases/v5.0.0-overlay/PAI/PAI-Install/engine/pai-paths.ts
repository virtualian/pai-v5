/**
 * PAI Installer v4.0 — Shared path helpers + junk-file predicate (GitHub #162).
 *
 * Extracted from three migration modules that each inlined byte-identical
 * copies of the PAI_DIR resolver and the .DS_Store / `._*` / backup-suffix
 * filter:
 *   - skill-migration.ts (#110)
 *   - command-migration.ts (#113)
 *   - pai-runtime-migration.ts (#160)
 *
 * Behaviour-preserving by design. Each caller passes the options that
 * reproduce its prior local behaviour exactly:
 *   - skill-migration:   isJunkEntry(name)
 *   - command-migration: isJunkEntry(name, { extraEntries: new Set([".gitkeep"]) })
 *   - pai-runtime:       isJunkEntry(name, { allowBackups: true })
 *
 * The PAI_DIR resolver is the most-likely-to-need-future-fixing piece of the
 * three duplicates (e.g., `${HOME}` literal, `~user` patterns, trailing-slash
 * normalisation). Centralising it means a single fix lands everywhere.
 */

import { homedir } from "os";
import { join, basename } from "path";

/**
 * Resolve the canonical PAI runtime root (`~/.pai` by default).
 *
 * Honours `PAI_DIR` env var with prefix expansion:
 *   - Bare "~" or "~/..."   → expanded against `os.homedir()`
 *   - "$HOME..."            → expanded against `os.homedir()`
 *   - Anything else         → used verbatim
 *   - Empty/whitespace/unset → falls back to `~/.pai`
 *
 * Read at every call (not cached) so test fixtures can mutate the env var
 * between calls. This matches the behaviour of the prior inlined copies.
 *
 * NOTE: This is DIFFERENT from the installer's `paiDir` variable in actions.ts,
 * which is misleadingly named and resolves to `~/.claude/`. `getPaiHome()`
 * returns the `~/.pai/` runtime root, never the Claude config root.
 */
export function getPaiHome(): string {
  let envPaiDir = (process.env.PAI_DIR || "").trim();
  if (envPaiDir === "~" || envPaiDir.startsWith("~/")) {
    envPaiDir = join(homedir(), envPaiDir.slice(1));
  } else if (envPaiDir.startsWith("$HOME")) {
    envPaiDir = join(homedir(), envPaiDir.slice("$HOME".length));
  }
  return envPaiDir || join(homedir(), ".pai");
}

/** `<paiHome>/skills` — canonical PAI skills directory. */
export const getPaiSkillsDir = (): string => join(getPaiHome(), "skills");

/** `<paiHome>/commands` — canonical PAI commands directory. */
export const getPaiCommandsDir = (): string => join(getPaiHome(), "commands");

/**
 * Backup-file naming convention used by the migrators when resolving drift.
 * Format: `<name>.backup-YYYY-MM-DDTHH-MM-SS-sssZ` (the output of
 * `new Date().toISOString().replace(/[:.]/g, "-")` appended to the original
 * basename). Skill and command migrators write these; pai-runtime doesn't.
 *
 * Kept private — callers should always go through `isJunkEntry` rather than
 * reimplementing the regex.
 */
const BACKUP_SUFFIX_RE = /\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export interface IsJunkOpts {
  /**
   * Additional names to treat as junk on top of the always-junk set
   * (`.DS_Store`, `._*`, backup-suffix). E.g. command-migration adds
   * `.gitkeep` so empty-directory markers don't get symlinked.
   */
  extraEntries?: ReadonlySet<string>;

  /**
   * `true` → backup-suffix names are NOT treated as junk.
   * `false` (default) → backup-suffix names ARE junk (skill+command behaviour:
   *   they create backups during drift resolution and must skip them on
   *   subsequent runs to avoid re-symlinking the backup directory).
   *
   * Used by pai-runtime-migration which copies a shipped tree that contains
   * no backup files; the suffix exclusion would be a no-op there but is
   * disabled explicitly for intent clarity.
   */
  allowBackups?: boolean;
}

/**
 * Classify a basename as junk that should be skipped during dir enumeration
 * or filtered out of `cpSync`. Pure function.
 *
 * Always-junk: `.DS_Store`, anything starting with `._` (macOS resource forks),
 * and (unless `allowBackups: true`) names matching `BACKUP_SUFFIX_RE`.
 */
export function isJunkEntry(name: string, opts?: IsJunkOpts): boolean {
  if (name === ".DS_Store") return true;
  if (opts?.extraEntries?.has(name)) return true;
  if (name.startsWith("._")) return true;
  if (!opts?.allowBackups && BACKUP_SUFFIX_RE.test(name)) return true;
  return false;
}

/**
 * Build a `cpSync` filter predicate from `IsJunkOpts`. The returned function
 * receives the absolute source path (per Node's `cpSync.filter` contract) and
 * returns `true` to copy, `false` to skip.
 */
export function makeCpFilter(opts?: IsJunkOpts): (src: string) => boolean {
  return (src: string) => !isJunkEntry(basename(src), opts);
}
