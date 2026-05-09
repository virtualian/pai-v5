/**
 * PAI Installer v4.0 — MEMORY migration tests (GitHub #107)
 *
 * Run from Releases/v4.0.3+/.claude/PAI-Install/:
 *   bun test engine/memory-migration.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EngineEvent } from "./types";
import { migrateMemoryDirectory } from "./memory-migration";

// ─── Fixture helpers ─────────────────────────────────────────────

interface Fixture {
  root: string;
  claudeConfigDir: string;
  paiDir: string;
  sourceMemory: string;
  destMemory: string;
  markerPath: string;
  events: EngineEvent[];
  emit: (e: EngineEvent) => Promise<void>;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pai-mem-mig-"));
  const claudeConfigDir = join(root, "claude");
  const paiDir = join(root, "pai");
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(paiDir, { recursive: true });

  const events: EngineEvent[] = [];
  const emit = async (e: EngineEvent): Promise<void> => {
    events.push(e);
  };

  return {
    root,
    claudeConfigDir,
    paiDir,
    sourceMemory: join(claudeConfigDir, "MEMORY"),
    destMemory: join(paiDir, "MEMORY"),
    markerPath: join(paiDir, "MEMORY", "STATE", "migration.json"),
    events,
    emit,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

function seedSourceMemory(fx: Fixture): void {
  mkdirSync(fx.sourceMemory, { recursive: true });
  mkdirSync(join(fx.sourceMemory, "LEARNING", "REFLECTION"), { recursive: true });
  writeFileSync(join(fx.sourceMemory, "ABOUTME.md"), "# About\n");
  writeFileSync(join(fx.sourceMemory, "LEARNING", "REFLECTION", "note.md"), "note\n");
}

function seedDestMemory(fx: Fixture): void {
  mkdirSync(fx.destMemory, { recursive: true });
  writeFileSync(join(fx.destMemory, "existing.md"), "already here\n");
}

// ─── Tests ───────────────────────────────────────────────────────

describe("migrateMemoryDirectory", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });
  afterEach(() => fx.cleanup());

  test("fresh install: noop when source absent", async () => {
    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);
    expect(result.action).toBe("noop-nothing-to-migrate");
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test("noop when source has only .DS_Store", async () => {
    mkdirSync(fx.sourceMemory, { recursive: true });
    writeFileSync(join(fx.sourceMemory, ".DS_Store"), "");
    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);
    expect(result.action).toBe("noop-nothing-to-migrate");
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test("upgrade: migrates source to dest and writes marker", async () => {
    seedSourceMemory(fx);
    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);

    expect(result.action).toBe("migrated");
    expect(result.method).toBe("rename");
    expect(existsSync(fx.sourceMemory)).toBe(false);
    expect(existsSync(join(fx.destMemory, "ABOUTME.md"))).toBe(true);
    expect(existsSync(join(fx.destMemory, "LEARNING", "REFLECTION", "note.md"))).toBe(true);
    expect(existsSync(fx.markerPath)).toBe(true);

    const marker = JSON.parse(readFileSync(fx.markerPath, "utf-8"));
    expect(marker.from).toBe(fx.sourceMemory);
    expect(marker.to).toBe(fx.destMemory);
    expect(marker.method).toBe("rename");
    expect(typeof marker.migratedAt).toBe("string");
  });

  test("second run is idempotent: noop-already-migrated", async () => {
    seedSourceMemory(fx);
    await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);

    // Re-create an empty source — second run should still see the marker
    // and noop regardless of what's on the old side.
    mkdirSync(fx.sourceMemory, { recursive: true });
    writeFileSync(join(fx.sourceMemory, "new-leftover.md"), "should be ignored\n");

    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);
    expect(result.action).toBe("noop-already-migrated");
    // Source untouched on the idempotent path
    expect(existsSync(join(fx.sourceMemory, "new-leftover.md"))).toBe(true);
  });

  test("ambiguity: refuses when both sides populated and no marker", async () => {
    seedSourceMemory(fx);
    seedDestMemory(fx);

    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);
    expect(result.action).toBe("refused-ambiguous");
    expect(result.sourceStats?.fileCount).toBeGreaterThan(0);
    expect(result.destStats?.fileCount).toBeGreaterThan(0);
    expect(result.diagnostic).toContain("refused");
    // Neither side mutated
    expect(existsSync(join(fx.sourceMemory, "ABOUTME.md"))).toBe(true);
    expect(existsSync(join(fx.destMemory, "existing.md"))).toBe(true);
    expect(existsSync(fx.markerPath)).toBe(false);

    // Telemetry written to LEARNING/SYSTEM/
    const telemetryDir = join(fx.paiDir, "MEMORY", "LEARNING", "SYSTEM");
    expect(existsSync(telemetryDir)).toBe(true);
    const entries = readdirSync(telemetryDir).filter((n) => n.startsWith("memory-migration-"));
    expect(entries.length).toBeGreaterThan(0);
  });

  test("dry-run: would-migrate leaves filesystem untouched", async () => {
    seedSourceMemory(fx);
    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit, { dryRun: true });

    expect(result.action).toBe("dry-run-would-migrate");
    expect(result.sourceStats?.fileCount).toBeGreaterThan(0);
    // Filesystem unchanged
    expect(existsSync(join(fx.sourceMemory, "ABOUTME.md"))).toBe(true);
    expect(existsSync(fx.destMemory)).toBe(false);
    expect(existsSync(fx.markerPath)).toBe(false);
  });

  test("dry-run: would-refuse-ambiguous on populated conflict", async () => {
    seedSourceMemory(fx);
    seedDestMemory(fx);
    const result = await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit, { dryRun: true });

    expect(result.action).toBe("dry-run-would-refuse-ambiguous");
    // No telemetry written for dry-run
    const telemetryDir = join(fx.paiDir, "MEMORY", "LEARNING", "SYSTEM");
    expect(existsSync(telemetryDir)).toBe(false);
  });

  test("post-migration telemetry entry written to LEARNING/SYSTEM", async () => {
    seedSourceMemory(fx);
    await migrateMemoryDirectory(fx.claudeConfigDir, fx.paiDir, fx.emit);
    const telemetryDir = join(fx.paiDir, "MEMORY", "LEARNING", "SYSTEM");
    const entries = readdirSync(telemetryDir).filter((n) => n.startsWith("memory-migration-"));
    expect(entries.length).toBeGreaterThan(0);
    const body = JSON.parse(readFileSync(join(telemetryDir, entries[0]), "utf-8"));
    expect(body.action).toBe("migrated");
    expect(body.method).toBe("rename");
  });
});
