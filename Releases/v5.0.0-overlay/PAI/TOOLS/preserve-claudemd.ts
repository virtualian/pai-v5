/**
 * preserve-claudemd.ts — protect user edits to ~/.claude/CLAUDE.md across rebuilds.
 *
 * Called by BuildCLAUDE.build() on every rebuild (install, upgrade, SessionStart hook).
 *
 * Fixes:
 *   - #126: user-added @-imports at top of CLAUDE.md are re-injected into the new output
 *   - #127 (minimal): non-identical overwrites take a timestamped backup + log drift summary
 *
 * The release template ships import-free (see #111), so every @-import found in the
 * existing CLAUDE.md is by definition user-added — no in-tree/out-of-tree classifier needed.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";

const IMPORT_LINE = /^@\S+$/;
const PAI_HEADING = /^#\s+PAI\b/m;
const LOG_PREFIX = "[preserve-claudemd]";

/**
 * Extract @-import lines from the top of CLAUDE.md, stopping at the first `#` heading.
 * Blank lines between imports are allowed and not returned.
 */
export function extractUserImports(content: string): string[] {
  const lines = content.split("\n");
  const imports: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#")) break;
    if (IMPORT_LINE.test(line)) imports.push(line);
  }
  return imports;
}

/**
 * Splice import lines immediately above the first `# PAI` heading in `template`.
 * No-op if no imports or no PAI heading is found.
 */
export function injectImportsAbovePaiHeading(
  template: string,
  imports: string[]
): string {
  if (imports.length === 0) return template;
  const match = template.match(PAI_HEADING);
  if (!match || match.index === undefined) return template;

  const before = template.slice(0, match.index).trimEnd();
  const after = template.slice(match.index);
  const prefix = before ? `${before}\n\n` : "";
  return `${imports.join("\n")}\n\n${prefix}${after}`;
}

/**
 * Resolve each import's target path and keep only the ones that exist.
 *
 * Claude Code resolves `@path` with some tolerance: a path like `@.claude/foo.md` found
 * inside `~/.claude/CLAUDE.md` resolves to `~/.claude/foo.md` (HOME + path), not to
 * `~/.claude/.claude/foo.md` (rootDir + path). We try both candidates so either semantics
 * works — an import is kept if ANY candidate exists.
 *
 * Dangling imports (@foo.md where foo.md was deleted) are dropped to prevent ENOENT at
 * session load.
 */
export function filterResolvableImports(
  imports: string[],
  rootDir: string
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  const parentDir = dirname(rootDir);
  for (const line of imports) {
    const rel = line.slice(1);
    const candidates = isAbsolute(rel)
      ? [rel]
      : [resolve(rootDir, rel), resolve(parentDir, rel)];
    if (candidates.some(existsSync)) kept.push(line);
    else dropped.push(line);
  }
  return { kept, dropped };
}

/**
 * Write a timestamped backup of `oldContent` to a sibling of `oldPath` if it differs
 * from `newContent`. Caller is responsible for having already read `oldContent` — this
 * avoids a redundant readFileSync on the hot SessionStart rebuild path.
 *
 * Millisecond-precision timestamp prevents collisions when multiple SessionStart hooks
 * fire within the same second.
 */
export function backupIfDiffers(
  oldPath: string,
  oldContent: string,
  newContent: string
): {
  backupPath: string | null;
  diff: { added: number; removed: number } | null;
} {
  if (oldContent === newContent) return { backupPath: null, diff: null };

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const l of newLines) if (!oldSet.has(l)) added++;
  for (const l of oldLines) if (!newSet.has(l)) removed++;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${oldPath}.bak.${stamp}`;
  writeFileSync(backupPath, oldContent);

  return { backupPath, diff: { added, removed } };
}

/**
 * Top-level preservation wrapper called from BuildCLAUDE.build().
 *
 * Reads the existing CLAUDE.md at most once, extracts user imports (if any), drops
 * dangling ones, re-injects the rest into the new template-rendered content, and takes
 * a safety backup if the final content differs from the existing file.
 *
 * Returns:
 *   - `finalContent` — the content the caller should write
 *   - `unchanged` — true when the existing file is byte-identical to `finalContent`, so
 *     the caller can skip the writeFileSync without re-reading the file
 *   - `log` — lines to surface to stderr (caller decides where to print)
 */
export function applyPreservation(args: {
  existingPath: string;
  newContent: string;
  rootDir: string;
}): { finalContent: string; unchanged: boolean; log: string[] } {
  const { existingPath, newContent, rootDir } = args;
  const log: string[] = [];

  if (!existsSync(existingPath)) {
    return { finalContent: newContent, unchanged: false, log };
  }

  const existing = readFileSync(existingPath, "utf-8");
  const foundImports = extractUserImports(existing);

  let merged = newContent;
  if (foundImports.length > 0) {
    const { kept, dropped } = filterResolvableImports(foundImports, rootDir);
    merged = injectImportsAbovePaiHeading(newContent, kept);
    log.push(`${LOG_PREFIX} preserved ${kept.length}, dropped ${dropped.length}`);
    for (const d of dropped) {
      log.push(`${LOG_PREFIX}   dropped broken import: ${d}`);
    }
  }

  const unchanged = existing === merged;
  if (!unchanged) {
    const { backupPath, diff } = backupIfDiffers(existingPath, existing, merged);
    if (backupPath && diff) {
      log.push(`${LOG_PREFIX} backup: ${backupPath}`);
      log.push(`${LOG_PREFIX} drift: +${diff.added} -${diff.removed} lines`);
    }
  }

  return { finalContent: merged, unchanged, log };
}
