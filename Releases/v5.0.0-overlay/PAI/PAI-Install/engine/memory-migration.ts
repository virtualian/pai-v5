/**
 * PAI Installer v4.0 — MEMORY directory migration (GitHub #107)
 *
 * PR #106 completed the CLAUDE_CONFIG_DIR + PAI_DIR two-root split for
 * v4.0.3+, which relocates `MEMORY/` from `~/.claude/MEMORY/` to
 * `~/.pai/MEMORY/`. Anyone upgrading from v4.0.2 with an existing
 * `~/.claude/MEMORY/` directory needs to move it before their first
 * post-upgrade session or they will boot with no correction history, no
 * synthesis digest, and new writes landing in the new location while old
 * data stays orphaned under the old root.
 *
 * PR #106 shipped the upgrade recipe as documentation only. This module
 * automates detection and relocation so upgraders cannot accidentally skip
 * the step. Patterned off `command-migration.ts` (PR #135) — same marker
 * file idiom, same renameSync-with-EXDEV-fallback strategy, same event
 * emitter wiring.
 *
 * ──── Semantics ────────────────────────────────────────────────
 *
 * 1. If the marker file `STATE/migration.json` exists in the destination
 *    MEMORY, the migration has already run: noop.
 * 2. If the source `<claudeConfigDir>/MEMORY` does not exist or contains
 *    only ignorable entries (`.DS_Store`, etc.), there is nothing to
 *    migrate: noop.
 * 3. If the destination `<paiDir>/MEMORY` is absent or ignorable-only, the
 *    migration runs: rename the source into place (falling back to a
 *    recursive copy + delete on EXDEV), write the marker, write a
 *    telemetry entry to LEARNING/SYSTEM/.
 * 4. If BOTH sides contain meaningful content and there is no marker, the
 *    migration REFUSES with a diagnostic listing both paths and their
 *    size/mtime. Merging is a data-integrity decision the user must make.
 *
 * ──── Dry run ──────────────────────────────────────────────────
 *
 * Passing `{ dryRun: true }` performs all classification logic but makes
 * no filesystem writes. The return value still indicates what would have
 * happened, via the `dry-run-would-*` action variants.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
  cpSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { EngineEventHandler } from "./types";

// ─── Types ─────────────────────────────────────────────────────

export type MemoryMigrationAction =
  | "noop-already-migrated"
  | "noop-nothing-to-migrate"
  | "migrated"
  | "dry-run-would-migrate"
  | "dry-run-would-refuse-ambiguous"
  | "dry-run-noop"
  | "refused-ambiguous";

export interface DirStats {
  path: string;
  fileCount: number;
  totalBytes: number;
  latestMtime: string | null;
}

export interface MemoryMigrationResult {
  action: MemoryMigrationAction;
  source: string;
  dest: string;
  markerPath: string;
  method?: "rename" | "copy-fallback";
  sourceStats?: DirStats;
  destStats?: DirStats;
  diagnostic?: string;
}

export interface MemoryMigrationOptions {
  dryRun?: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────

const IGNORED_BASENAMES = new Set([".DS_Store", ".gitkeep"]);

function isIgnoredName(name: string): boolean {
  if (IGNORED_BASENAMES.has(name)) return true;
  if (name.startsWith("._")) return true;
  return false;
}

/**
 * Walk `dir` recursively and summarise content. Returns `null` if the
 * directory doesn't exist. An empty-but-present directory returns zero
 * counts, which the caller treats as "nothing meaningful here".
 */
function summariseDir(dir: string): DirStats | null {
  if (!existsSync(dir)) return null;

  let fileCount = 0;
  let totalBytes = 0;
  let latestMtimeMs = 0;

  const walk = (cur: string): void => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isIgnoredName(e.name)) continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (e.isFile() || e.isSymbolicLink()) {
        try {
          const st = statSync(full);
          fileCount += 1;
          totalBytes += st.size;
          if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs;
        } catch {
          // unreadable — still count as a file for ambiguity purposes
          fileCount += 1;
        }
      }
    }
  };

  walk(dir);

  return {
    path: dir,
    fileCount,
    totalBytes,
    latestMtime: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
  };
}

function hasMeaningfulContent(stats: DirStats | null): boolean {
  return stats !== null && stats.fileCount > 0;
}

function markerPathFor(destMemoryDir: string): string {
  return join(destMemoryDir, "STATE", "migration.json");
}

function readMarker(markerPath: string): boolean {
  return existsSync(markerPath);
}

function writeMarker(
  markerPath: string,
  source: string,
  dest: string,
  method: "rename" | "copy-fallback",
): void {
  mkdirSync(join(markerPath, ".."), { recursive: true });
  const payload = {
    from: source,
    to: dest,
    migratedAt: new Date().toISOString(),
    method,
    schema: 1,
  };
  writeFileSync(markerPath, JSON.stringify(payload, null, 2) + "\n");
}

function writeTelemetry(
  paiDir: string,
  result: Omit<MemoryMigrationResult, "markerPath">,
): void {
  try {
    const dir = join(paiDir, "MEMORY", "LEARNING", "SYSTEM");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `memory-migration-${ts}.json`);
    writeFileSync(file, JSON.stringify({ ...result, recordedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch {
    // telemetry is best-effort; never fail the install over a log write
  }
}

function moveTree(source: string, dest: string): "rename" | "copy-fallback" {
  mkdirSync(join(dest, ".."), { recursive: true });
  try {
    renameSync(source, dest);
    return "rename";
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "EXDEV") throw err;
    // Cross-filesystem: copy then delete. cpSync preserves mode by default.
    cpSync(source, dest, { recursive: true, dereference: false, preserveTimestamps: true });
    rmSync(source, { recursive: true, force: true });
    return "copy-fallback";
  }
}

// ─── Main entry point ─────────────────────────────────────────

/**
 * Migrate `<claudeConfigDir>/MEMORY` to `<paiDir>/MEMORY`.
 *
 * @param claudeConfigDir  e.g. `~/.claude` (the legacy location).
 * @param paiDir           e.g. `~/.pai` (the canonical destination root).
 * @param emit             Installer event handler.
 * @param options.dryRun   If true, report what would happen without
 *                         touching the filesystem.
 */
export async function migrateMemoryDirectory(
  claudeConfigDir: string,
  paiDir: string,
  emit: EngineEventHandler,
  options: MemoryMigrationOptions = {},
): Promise<MemoryMigrationResult> {
  const source = join(claudeConfigDir, "MEMORY");
  const dest = join(paiDir, "MEMORY");
  const markerPath = markerPathFor(dest);
  const dryRun = options.dryRun === true;

  // Idempotent: marker exists means the migration already ran.
  if (readMarker(markerPath)) {
    const result: MemoryMigrationResult = {
      action: "noop-already-migrated",
      source,
      dest,
      markerPath,
    };
    await emit({
      event: "message",
      content: `MEMORY migration: already complete (marker at ${markerPath}).`,
    });
    return result;
  }

  const sourceStats = summariseDir(source);
  const destStats = summariseDir(dest);
  const sourceHasContent = hasMeaningfulContent(sourceStats);
  const destHasContent = hasMeaningfulContent(destStats);

  // Ambiguity: both populated without a marker. Hard refuse — the user
  // must resolve which copy is canonical.
  if (sourceHasContent && destHasContent) {
    const diagnostic =
      `MEMORY migration refused: both locations contain data and no marker file exists.\n` +
      `  source: ${sourceStats!.path} — ${sourceStats!.fileCount} files, ${sourceStats!.totalBytes} bytes, latest mtime ${sourceStats!.latestMtime}\n` +
      `  dest:   ${destStats!.path} — ${destStats!.fileCount} files, ${destStats!.totalBytes} bytes, latest mtime ${destStats!.latestMtime}\n` +
      `Resolve manually: inspect both, pick the canonical one, back up the other, ` +
      `then re-run the installer. Auto-merge is not safe for memory state.`;

    const result: MemoryMigrationResult = {
      action: dryRun ? "dry-run-would-refuse-ambiguous" : "refused-ambiguous",
      source,
      dest,
      markerPath,
      sourceStats: sourceStats!,
      destStats: destStats!,
      diagnostic,
    };
    await emit({ event: "message", content: diagnostic });
    if (!dryRun) {
      writeTelemetry(paiDir, result);
    }
    return result;
  }

  // Nothing to migrate — source is absent or ignorable-only.
  if (!sourceHasContent) {
    const result: MemoryMigrationResult = {
      action: dryRun ? "dry-run-noop" : "noop-nothing-to-migrate",
      source,
      dest,
      markerPath,
      sourceStats: sourceStats ?? undefined,
      destStats: destStats ?? undefined,
    };
    await emit({
      event: "message",
      content: existsSync(source)
        ? `MEMORY migration: nothing to migrate (source ${source} has no meaningful content).`
        : `MEMORY migration: nothing to migrate (source ${source} does not exist).`,
    });
    return result;
  }

  // Migration eligible: source has content, dest is empty/absent.
  if (dryRun) {
    const result: MemoryMigrationResult = {
      action: "dry-run-would-migrate",
      source,
      dest,
      markerPath,
      sourceStats: sourceStats!,
      destStats: destStats ?? undefined,
    };
    await emit({
      event: "message",
      content:
        `MEMORY migration (dry-run): would move ${source} → ${dest} ` +
        `(${sourceStats!.fileCount} files, ${sourceStats!.totalBytes} bytes).`,
    });
    return result;
  }

  // Real migration. If dest exists but only as an ignorable-only stub,
  // remove it so renameSync has a clean target.
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }

  const method = moveTree(source, dest);
  writeMarker(markerPath, source, dest, method);

  const result: MemoryMigrationResult = {
    action: "migrated",
    source,
    dest,
    markerPath,
    method,
    sourceStats: sourceStats!,
  };
  await emit({
    event: "message",
    content:
      `MEMORY migration complete: ${source} → ${dest} ` +
      `(${sourceStats!.fileCount} files, method=${method}).`,
  });
  writeTelemetry(paiDir, result);
  return result;
}

export const __testInternals = {
  summariseDir,
  hasMeaningfulContent,
  markerPathFor,
  moveTree,
  writeMarker,
};
