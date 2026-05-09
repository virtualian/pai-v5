/**
 * PAI Installer v4.0 — Per-Command Symlinks (GitHub #113)
 *
 * Converts each PAI-owned file under `~/.claude/commands/<name>.md` into a
 * symlink pointing at `~/.pai/commands/<name>.md`. Claude Code's slash-command
 * scanner is hardcoded to `~/.claude/commands/`, so the read path stays there
 * while `~/.pai/commands/` becomes the single source of truth.
 *
 * This is the commands-side peer of `skill-migration.ts` (#110). Before this
 * module shipped, slash commands had no canonical home under `~/.pai/` at all
 * — each pack's INSTALL.md wizard copied files directly into `~/.claude/
 * commands/`, producing silent drift when pack sources updated.
 *
 * Third-party commands (installed manually, not from a PAI pack) are preserved
 * untouched: if a name does not exist in `~/.pai/commands/`, it is treated as
 * third-party and skipped.
 *
 * Ownership rule:
 *   - If `~/.pai/commands/<name>.md` exists as a real file → PAI-owned
 *   - If `~/.pai/commands/` is empty (fresh install, right after git clone)
 *     → the caller has not yet placed pack-source commands, so nothing to do.
 *     Packs stage their sources into `~/.pai/commands/` during their own
 *     install step; this migrator only converts the `~/.claude/commands/`
 *     side into symlinks.
 *
 * Scope: flat .md files at the top level of `~/.claude/commands/`. Nested
 * directories under commands/ are ignored — they are not how Claude Code
 * loads slash commands.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  symlinkSync,
  renameSync,
  rmSync,
  cpSync,
} from "fs";
import { join, resolve, relative, basename } from "path";
import type { EngineEventHandler } from "./types";
import { getPaiCommandsDir, isJunkEntry } from "./pai-paths";

export type CommandClassification =
  | "already-correct-symlink"
  | "external-symlink"
  | "third-party"
  | "pai-only-claude-side"
  | "pai-only-pai-side"
  | "drift-both-sides";

export interface CommandMigrationSummary {
  migrated: number;
  skipped: number;
  backedUp: number;
  failed: number;
}

// Command-tree-specific extra junk: .gitkeep markers used to keep otherwise-
// empty pack-source dirs tracked in git. Layered onto the shared base
// (.DS_Store, ._*, backup-suffix) via isJunkEntry's extraEntries opt.
const COMMAND_EXTRA_JUNK: ReadonlySet<string> = new Set([".gitkeep"]);

/**
 * Enumerate top-level command filenames under `dir` that are real .md files
 * (not symlinks, not ignored). Used to compute the PAI-owned set from the
 * canonical pai tree.
 */
function collectOwnedFiles(dir: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (isJunkEntry(e.name, { extraEntries: COMMAND_EXTRA_JUNK })) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.isFile() && !e.isSymbolicLink()) {
      out.add(e.name);
    }
  }
  return out;
}

/**
 * Classify a top-level command filename. Pure function — safe to unit-test.
 */
export function classifyCommandFile(
  name: string,
  claudeCommandsDir: string,
  paiCommandsDir: string,
  paiOwnedSet: Set<string>,
): CommandClassification {
  const claudeSide = join(claudeCommandsDir, name);
  const paiSide = join(paiCommandsDir, name);

  let claudeStat: ReturnType<typeof lstatSync> | null = null;
  let paiStat: ReturnType<typeof lstatSync> | null = null;
  try { claudeStat = lstatSync(claudeSide); } catch { /* absent */ }
  try { paiStat = lstatSync(paiSide); } catch { /* absent */ }

  if (claudeStat?.isSymbolicLink()) {
    let target: string;
    try { target = readlinkSync(claudeSide); }
    catch { return "external-symlink"; }
    const resolvedTarget = resolve(claudeCommandsDir, target);
    const expected = resolve(paiSide);
    return resolvedTarget === expected ? "already-correct-symlink" : "external-symlink";
  }

  const claudeIsFile = claudeStat !== null && claudeStat.isFile();
  const paiIsFile = paiStat !== null && paiStat.isFile() && !paiStat.isSymbolicLink();

  if (!paiOwnedSet.has(name)) {
    return "third-party";
  }

  if (claudeIsFile && paiIsFile) return "drift-both-sides";
  if (claudeIsFile && !paiIsFile) return "pai-only-claude-side";
  if (!claudeIsFile && paiIsFile) return "pai-only-pai-side";

  return "third-party";
}

type MigrateMode = "move" | "link-only" | "drift";

/**
 * Migrate a single command file. Atomic per-file state machine with rollback.
 *
 * Modes:
 *   "move"       — claude side has the file; move it to pai, symlink back
 *   "link-only"  — pai side already has the file; just create the symlink
 *   "drift"      — both sides have real files; back up pai, move claude over, symlink
 */
async function migrateCommand(
  name: string,
  claudeCommandsDir: string,
  paiCommandsDir: string,
  mode: MigrateMode,
  summary: CommandMigrationSummary,
  emit: EngineEventHandler,
): Promise<void> {
  const claudeSide = join(claudeCommandsDir, name);
  const paiSide = join(paiCommandsDir, name);
  const relativeTarget = relative(claudeCommandsDir, paiSide);

  let backupPath: string | null = null;
  if (mode === "drift") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = join(paiCommandsDir, `${name}.backup-${ts}`);
    renameSync(paiSide, backupPath);
    summary.backedUp++;
    await emit({
      event: "message",
      content: `Command "${name}": drift detected, backed up ~/.pai/commands/${name} → ${basename(backupPath)}`,
    });
  }

  if (mode === "move" || mode === "drift") {
    try {
      renameSync(claudeSide, paiSide);
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "EXDEV") {
        cpSync(claudeSide, paiSide, { dereference: false });
        rmSync(claudeSide, { force: true });
      } else {
        if (backupPath && !existsSync(paiSide)) {
          try {
            renameSync(backupPath, paiSide);
            summary.backedUp--;
          } catch { /* best effort */ }
        }
        throw err;
      }
    }
  }

  try {
    symlinkSync(relativeTarget, claudeSide);
  } catch (err) {
    try {
      if (mode === "move" || mode === "drift") {
        renameSync(paiSide, claudeSide);
      }
      if (backupPath) {
        renameSync(backupPath, paiSide);
        summary.backedUp--;
      }
    } catch { /* best effort */ }
    throw err;
  }

  summary.migrated++;
  await emit({
    event: "message",
    content: `Command "${name}": migrated to ~/.pai/commands/${name} and symlinked.`,
  });
}

/**
 * Main entry point. Iterates the union of `<claudeDir>/commands` and
 * `<paiCommandsDir>`, classifies each command, and migrates PAI-owned ones.
 *
 * @param paiDir The installer's `paiDir` variable — SEMANTICALLY the Claude
 *               Code config root (`~/.claude`), despite the misleading name.
 *               Same convention as skill-migration.ts.
 * @param emit   Installer event handler.
 * @returns      A summary counter of commands migrated/skipped/backed-up/failed.
 *               Soft-fail: a single command's failure does NOT abort the run.
 */
export async function migratePerPackCommands(
  paiDir: string,
  emit: EngineEventHandler,
): Promise<CommandMigrationSummary> {
  const claudeCommandsDir = join(paiDir, "commands");
  const paiCommandsDir = getPaiCommandsDir();
  const summary: CommandMigrationSummary = { migrated: 0, skipped: 0, backedUp: 0, failed: 0 };

  if (!existsSync(claudeCommandsDir) && !existsSync(paiCommandsDir)) {
    return summary;
  }

  if (!existsSync(paiCommandsDir)) {
    mkdirSync(paiCommandsDir, { recursive: true });
    await emit({
      event: "message",
      content: `Created canonical commands directory at ${paiCommandsDir}.`,
    });
  }

  if (!existsSync(claudeCommandsDir)) {
    mkdirSync(claudeCommandsDir, { recursive: true });
  }

  const paiOwnedSet = collectOwnedFiles(paiCommandsDir);

  const allNames = new Set<string>();
  for (const e of readdirSync(claudeCommandsDir, { withFileTypes: true })) {
    if (!isJunkEntry(e.name, { extraEntries: COMMAND_EXTRA_JUNK }) && e.name.endsWith(".md")) allNames.add(e.name);
  }
  for (const e of readdirSync(paiCommandsDir, { withFileTypes: true })) {
    if (!isJunkEntry(e.name, { extraEntries: COMMAND_EXTRA_JUNK }) && e.name.endsWith(".md")) allNames.add(e.name);
  }

  if (allNames.size === 0) {
    return summary;
  }

  for (const name of allNames) {
    const kind = classifyCommandFile(name, claudeCommandsDir, paiCommandsDir, paiOwnedSet);
    try {
      switch (kind) {
        case "already-correct-symlink":
          summary.skipped++;
          break;
        case "external-symlink":
        case "third-party":
          summary.skipped++;
          await emit({
            event: "message",
            content: `Command "${name}": third-party or external, preserved.`,
          });
          break;
        case "pai-only-claude-side":
          await migrateCommand(name, claudeCommandsDir, paiCommandsDir, "move", summary, emit);
          break;
        case "pai-only-pai-side":
          await migrateCommand(name, claudeCommandsDir, paiCommandsDir, "link-only", summary, emit);
          break;
        case "drift-both-sides":
          await migrateCommand(name, claudeCommandsDir, paiCommandsDir, "drift", summary, emit);
          break;
      }
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      await emit({
        event: "message",
        content: `Command "${name}": migration failed — ${msg}`,
      });
    }
  }

  await emit({
    event: "message",
    content:
      `Command canonicalization: ${summary.migrated} migrated, ` +
      `${summary.skipped} skipped, ${summary.backedUp} backed up, ` +
      `${summary.failed} failed.`,
  });

  return summary;
}

export const __testInternals = { getPaiCommandsDir, collectOwnedFiles, migrateCommand };
