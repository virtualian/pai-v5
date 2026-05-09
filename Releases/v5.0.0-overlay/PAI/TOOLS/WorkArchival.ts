#!/usr/bin/env bun
/**
 * WorkArchival - Archive old completed WORK directories
 *
 * Scans ~/.pai/MEMORY/WORK/ for timestamped directories, checks their
 * completion status via PRD.md or META.yaml frontmatter, and archives
 * directories that are both completed and older than a configurable threshold.
 *
 * Commands:
 *   --dry-run      Preview what would be archived without moving anything
 *   --days N       Override the 90-day age threshold (default: 90)
 *   --help, -h     Show usage information
 *
 * Examples:
 *   bun run WorkArchival.ts                   Archive completed dirs older than 90 days
 *   bun run WorkArchival.ts --dry-run         Preview without archiving
 *   bun run WorkArchival.ts --days 30         Archive completed dirs older than 30 days
 *   bun run WorkArchival.ts --days 30 --dry-run
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { parseFrontmatter } from "../../hooks/lib/prd-utils";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(process.env.HOME!, ".claude");
const WORK_DIR = path.join(CLAUDE_DIR, "MEMORY", "WORK");
const ARCHIVE_DIR = path.join(WORK_DIR, "ARCHIVE");
const DEFAULT_AGE_DAYS = 90;

// Pattern: YYYYMMDD-HHMMSS_slug
const DIR_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_(.+)$/;

// ============================================================================
// Types
// ============================================================================

interface WorkDir {
  name: string;
  fullPath: string;
  timestamp: Date;
  slug: string;
}

interface ArchiveResult {
  archived: number;
  skipped: number;
  errors: number;
  details: string[];
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a directory name into a WorkDir, or null if it doesn't match.
 */
function parseWorkDir(dirName: string, basePath: string): WorkDir | null {
  const match = dirName.match(DIR_PATTERN);
  if (!match) return null;

  const [, year, month, day, hour, min, sec, slug] = match;
  const timestamp = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(min),
    parseInt(sec)
  );

  return {
    name: dirName,
    fullPath: path.join(basePath, dirName),
    timestamp,
    slug,
  };
}

/**
 * Parse a simple YAML file (no frontmatter delimiters) into key-value pairs.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Check if a work directory is completed based on PRD.md or META.yaml.
 * Returns true if phase: complete (PRD.md) or status: COMPLETED (META.yaml).
 */
function isCompleted(dirPath: string): boolean {
  // Check PRD.md first (current format)
  const prdPath = path.join(dirPath, "PRD.md");
  if (fs.existsSync(prdPath)) {
    try {
      const content = fs.readFileSync(prdPath, "utf-8");
      const frontmatter = parseFrontmatter(content);
      if (frontmatter?.phase?.toLowerCase() === "complete") {
        return true;
      }
    } catch {
      // Fall through to META.yaml check
    }
  }

  // Check META.yaml (legacy format)
  const metaPath = path.join(dirPath, "META.yaml");
  if (fs.existsSync(metaPath)) {
    try {
      const content = fs.readFileSync(metaPath, "utf-8");
      const meta = parseSimpleYaml(content);
      if (meta.status?.toUpperCase() === "COMPLETED") {
        return true;
      }
    } catch {
      // Not readable
    }
  }

  return false;
}

/**
 * Get the archive destination path for a directory based on its timestamp.
 * Format: ARCHIVE/YYYY-MM/dirname
 */
function getArchiveDest(workDir: WorkDir): string {
  const year = workDir.timestamp.getFullYear();
  const month = String(workDir.timestamp.getMonth() + 1).padStart(2, "0");
  return path.join(ARCHIVE_DIR, `${year}-${month}`, workDir.name);
}

// ============================================================================
// Archival Logic
// ============================================================================

function archiveWorkDirs(ageDays: number, dryRun: boolean): ArchiveResult {
  const result: ArchiveResult = {
    archived: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  // Check if WORK directory exists
  if (!fs.existsSync(WORK_DIR)) {
    console.log("WORK directory does not exist:", WORK_DIR);
    console.log("Nothing to archive.");
    return result;
  }

  // Read all entries in WORK/
  let entries: string[];
  try {
    entries = fs.readdirSync(WORK_DIR);
  } catch {
    console.log("Could not read WORK directory:", WORK_DIR);
    return result;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ageDays);

  for (const entry of entries) {
    // Skip ARCHIVE directory itself
    if (entry === "ARCHIVE") continue;

    const entryPath = path.join(WORK_DIR, entry);

    // Skip non-directories
    try {
      if (!fs.statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Parse the directory name
    const workDir = parseWorkDir(entry, WORK_DIR);
    if (!workDir) {
      result.details.push(`SKIP ${entry} (does not match YYYYMMDD-HHMMSS_slug pattern)`);
      result.skipped++;
      continue;
    }

    // Check age
    if (workDir.timestamp >= cutoff) {
      result.details.push(`SKIP ${entry} (too recent, ${daysSince(workDir.timestamp)} days old)`);
      result.skipped++;
      continue;
    }

    // Check completion status
    if (!isCompleted(workDir.fullPath)) {
      result.details.push(`SKIP ${entry} (not completed, ${daysSince(workDir.timestamp)} days old)`);
      result.skipped++;
      continue;
    }

    // Archive it
    const dest = getArchiveDest(workDir);
    const destDir = path.dirname(dest);

    if (dryRun) {
      result.details.push(`WOULD ARCHIVE ${entry} -> ${path.relative(WORK_DIR, dest)}`);
      result.archived++;
      continue;
    }

    try {
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.renameSync(workDir.fullPath, dest);
      result.details.push(`ARCHIVED ${entry} -> ${path.relative(WORK_DIR, dest)}`);
      result.archived++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.details.push(`ERROR ${entry}: ${msg}`);
      result.errors++;
    }
  }

  return result;
}

function daysSince(date: Date): number {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// ============================================================================
// CLI
// ============================================================================

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    days: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
WorkArchival - Archive old completed WORK directories

Usage:
  bun run WorkArchival.ts                   Archive completed dirs older than 90 days
  bun run WorkArchival.ts --dry-run         Preview without archiving
  bun run WorkArchival.ts --days 30         Use 30-day threshold instead of 90
  bun run WorkArchival.ts --days 30 --dry-run

How it works:
  Scans ~/.pai/MEMORY/WORK/ for directories matching YYYYMMDD-HHMMSS_slug.
  Checks each directory's PRD.md (phase: complete) or META.yaml (status: COMPLETED).
  Moves qualifying directories to WORK/ARCHIVE/YYYY-MM/ based on their timestamp.

Options:
  --dry-run     Preview what would be archived without moving anything
  --days N      Override the 90-day age threshold (default: 90)
  -h, --help    Show this help message
`);
  process.exit(0);
}

const ageDays = values.days ? parseInt(values.days, 10) : DEFAULT_AGE_DAYS;
if (isNaN(ageDays) || ageDays < 0) {
  console.error("Invalid --days value. Must be a non-negative integer.");
  process.exit(1);
}

const dryRun = values["dry-run"] ?? false;

console.log(`WorkArchival`);
console.log(`  Source:    ${WORK_DIR}`);
console.log(`  Archive:  ${ARCHIVE_DIR}`);
console.log(`  Threshold: ${ageDays} days`);
console.log(`  Dry run:  ${dryRun ? "yes" : "no"}`);
console.log();

const result = archiveWorkDirs(ageDays, dryRun);

// Print details
for (const detail of result.details) {
  console.log(`  ${detail}`);
}

// Print summary
console.log();
console.log(`Summary:`);
console.log(`  Archived: ${result.archived}`);
console.log(`  Skipped:  ${result.skipped}`);
console.log(`  Errors:   ${result.errors}`);
