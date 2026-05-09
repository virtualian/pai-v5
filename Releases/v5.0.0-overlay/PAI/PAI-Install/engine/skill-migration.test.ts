/**
 * PAI Installer v4.0 — Per-Pack Skill Symlinks Tests (GitHub #110)
 *
 * First-ever engine-level test in PAI-Install. Runs via `bun test` which
 * auto-discovers *.test.ts files; no package.json config needed.
 *
 * Run from Releases/v4.0.3+/.claude/PAI-Install/:
 *   bun test engine/skill-migration.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  rmSync,
  existsSync,
  readdirSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { EngineEvent } from "./types";
import {
  classifySkillDir,
  migratePerPackSymlinks,
} from "./skill-migration";

// ─── Fixture helpers ─────────────────────────────────────────────

interface Fixture {
  root: string;          // tempdir root
  paiDirArg: string;     // "paiDir" arg passed to migratePerPackSymlinks (= claude root)
  claudeSkillsDir: string;
  paiSkillsDir: string;
  events: EngineEvent[];
  emit: (e: EngineEvent) => void;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pai-skill-mig-"));
  const claudeHome = join(root, "claude");
  const paiHome = join(root, "pai");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(paiHome, { recursive: true });

  const claudeSkillsDir = join(claudeHome, "skills");
  const paiSkillsDir = join(paiHome, "skills");
  mkdirSync(claudeSkillsDir, { recursive: true });
  // Intentionally DO NOT create paiSkillsDir here — migration should create it.

  process.env.PAI_DIR = paiHome;

  const events: EngineEvent[] = [];
  const emit = (e: EngineEvent): void => { events.push(e); };

  return {
    root,
    paiDirArg: claudeHome,
    claudeSkillsDir,
    paiSkillsDir,
    events,
    emit,
    cleanup: () => {
      delete process.env.PAI_DIR;
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function makePackDir(parent: string, name: string, skillMdContent = `name: ${name}`): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMdContent);
  return dir;
}

// ─── classifySkillDir — 6 branches ───────────────────────────────

describe("classifySkillDir", () => {
  let fx: Fixture;
  beforeEach(() => { fx = setupFixture(); mkdirSync(fx.paiSkillsDir, { recursive: true }); });
  afterEach(() => fx.cleanup());

  test("skip-system-dir for PAI", () => {
    expect(classifySkillDir("PAI", fx.claudeSkillsDir, fx.paiSkillsDir, new Set()))
      .toBe("skip-system-dir");
  });

  test("skip-system-dir for CORE", () => {
    expect(classifySkillDir("CORE", fx.claudeSkillsDir, fx.paiSkillsDir, new Set()))
      .toBe("skip-system-dir");
  });

  test("already-correct-symlink when claude side points at pai side", () => {
    makePackDir(fx.paiSkillsDir, "Research");
    symlinkSync(join("..", "..", "pai", "skills", "Research"), join(fx.claudeSkillsDir, "Research"));
    expect(classifySkillDir("Research", fx.claudeSkillsDir, fx.paiSkillsDir, new Set(["Research"])))
      .toBe("already-correct-symlink");
  });

  test("external-symlink when claude side points elsewhere", () => {
    const external = join(fx.root, "elsewhere", "find-skills");
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(fx.claudeSkillsDir, "find-skills"));
    expect(classifySkillDir("find-skills", fx.claudeSkillsDir, fx.paiSkillsDir, new Set()))
      .toBe("external-symlink");
  });

  test("third-party when name not in paiOwnedSet", () => {
    makePackDir(fx.claudeSkillsDir, "tts-tutor-skill");
    expect(classifySkillDir("tts-tutor-skill", fx.claudeSkillsDir, fx.paiSkillsDir, new Set(["Research"])))
      .toBe("third-party");
  });

  test("pai-only-claude-side when dir only in claude tree", () => {
    makePackDir(fx.claudeSkillsDir, "Research");
    expect(classifySkillDir("Research", fx.claudeSkillsDir, fx.paiSkillsDir, new Set(["Research"])))
      .toBe("pai-only-claude-side");
  });

  test("pai-only-pai-side when dir only in pai tree", () => {
    makePackDir(fx.paiSkillsDir, "Research");
    expect(classifySkillDir("Research", fx.claudeSkillsDir, fx.paiSkillsDir, new Set(["Research"])))
      .toBe("pai-only-pai-side");
  });

  test("drift-both-sides when both trees have real dirs", () => {
    makePackDir(fx.claudeSkillsDir, "Research", "claude-version");
    makePackDir(fx.paiSkillsDir, "Research", "pai-version");
    expect(classifySkillDir("Research", fx.claudeSkillsDir, fx.paiSkillsDir, new Set(["Research"])))
      .toBe("drift-both-sides");
  });
});

// ─── migratePerPackSymlinks — integration ────────────────────────

describe("migratePerPackSymlinks", () => {
  let fx: Fixture;
  beforeEach(() => { fx = setupFixture(); });
  afterEach(() => fx.cleanup());

  test("fresh install: all claude-side dirs become symlinks to pai side", async () => {
    makePackDir(fx.claudeSkillsDir, "Research");
    makePackDir(fx.claudeSkillsDir, "Telos");

    const summary = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    expect(summary.migrated).toBe(2);
    expect(summary.failed).toBe(0);
    expect(lstatSync(join(fx.claudeSkillsDir, "Research")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(fx.claudeSkillsDir, "Telos")).isSymbolicLink()).toBe(true);
    // Symlink target must be relative
    expect(readlinkSync(join(fx.claudeSkillsDir, "Research")).startsWith("/")).toBe(false);
    // Content resolved through the symlink
    expect(readFileSync(join(fx.claudeSkillsDir, "Research", "SKILL.md"), "utf-8"))
      .toBe("name: Research");
    // pai side now has real dirs
    expect(lstatSync(join(fx.paiSkillsDir, "Research")).isDirectory()).toBe(true);
    expect(lstatSync(join(fx.paiSkillsDir, "Research")).isSymbolicLink()).toBe(false);
  });

  test("pai-only-pai-side: creates symlink without data move", async () => {
    mkdirSync(fx.paiSkillsDir, { recursive: true });
    makePackDir(fx.paiSkillsDir, "Research", "original-content");

    const summary = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    expect(summary.migrated).toBe(1);
    expect(lstatSync(join(fx.claudeSkillsDir, "Research")).isSymbolicLink()).toBe(true);
    // Original content preserved
    expect(readFileSync(join(fx.paiSkillsDir, "Research", "SKILL.md"), "utf-8"))
      .toBe("original-content");
  });

  test("drift: pai side backed up before claude side wins", async () => {
    mkdirSync(fx.paiSkillsDir, { recursive: true });
    makePackDir(fx.claudeSkillsDir, "Research", "claude-wins");
    makePackDir(fx.paiSkillsDir, "Research", "pai-loses");

    const summary = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    expect(summary.migrated).toBe(1);
    expect(summary.backedUp).toBe(1);
    // Final canonical content is the claude version
    expect(readFileSync(join(fx.paiSkillsDir, "Research", "SKILL.md"), "utf-8"))
      .toBe("claude-wins");
    // Old pai content preserved in a backup sibling
    const backups = readdirSync(fx.paiSkillsDir).filter(n => n.startsWith("Research.backup-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(fx.paiSkillsDir, backups[0], "SKILL.md"), "utf-8"))
      .toBe("pai-loses");
  });

  test("third-party skills are preserved", async () => {
    // Simulate upgrade: pai side already has canonical packs.
    mkdirSync(fx.paiSkillsDir, { recursive: true });
    makePackDir(fx.paiSkillsDir, "Research");
    // Claude side has a third-party pack absent from pai.
    makePackDir(fx.claudeSkillsDir, "tts-tutor-skill");

    const summary = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    expect(summary.failed).toBe(0);
    // Third-party is untouched — still a real directory, not a symlink.
    const thirdParty = lstatSync(join(fx.claudeSkillsDir, "tts-tutor-skill"));
    expect(thirdParty.isDirectory()).toBe(true);
    expect(thirdParty.isSymbolicLink()).toBe(false);
    // pai side did NOT get a tts-tutor-skill entry
    expect(existsSync(join(fx.paiSkillsDir, "tts-tutor-skill"))).toBe(false);
  });

  test("external symlinks (find-skills) are preserved untouched", async () => {
    const external = join(fx.root, "agents-home", "find-skills");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "SKILL.md"), "find-skills-content");
    mkdirSync(fx.paiSkillsDir, { recursive: true });
    makePackDir(fx.paiSkillsDir, "Research"); // another pack, to make paiOwnedSet non-empty
    symlinkSync(external, join(fx.claudeSkillsDir, "find-skills"));

    await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    // find-skills is still a symlink pointing at the external location.
    const stat = lstatSync(join(fx.claudeSkillsDir, "find-skills"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(fx.claudeSkillsDir, "find-skills"))).toBe(external);
    // Nothing was written to pai side for it.
    expect(existsSync(join(fx.paiSkillsDir, "find-skills"))).toBe(false);
  });

  test("idempotency: second run is a no-op", async () => {
    makePackDir(fx.claudeSkillsDir, "Research");

    const first = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);
    expect(first.migrated).toBe(1);

    fx.events.length = 0; // clear event log
    const second = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    expect(second.migrated).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    // No "migrated" messages should have been emitted on the second run.
    const migratedMsgs = fx.events.filter(
      e => e.event === "message" && (e as { content?: string }).content?.includes("migrated to"),
    );
    expect(migratedMsgs.length).toBe(0);
  });

  test(".DS_Store and ._* entries are ignored at top level", async () => {
    makePackDir(fx.claudeSkillsDir, "Research");
    writeFileSync(join(fx.claudeSkillsDir, ".DS_Store"), "junk");
    writeFileSync(join(fx.claudeSkillsDir, "._apple-fork"), "junk");

    const summary = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    expect(summary.migrated).toBe(1); // only Research
    // The junk entries must NOT appear in the pai tree.
    expect(existsSync(join(fx.paiSkillsDir, ".DS_Store"))).toBe(false);
    expect(existsSync(join(fx.paiSkillsDir, "._apple-fork"))).toBe(false);
  });

  test("idempotency on a drifted tree: backup dirs do not get re-migrated on second run", async () => {
    // Setup drift: both sides have real Research dirs with different content.
    mkdirSync(fx.paiSkillsDir, { recursive: true });
    makePackDir(fx.claudeSkillsDir, "Research", "claude-wins");
    makePackDir(fx.paiSkillsDir, "Research", "pai-loses");

    // First run: creates a backup dir in pai tree.
    const first = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);
    expect(first.migrated).toBe(1);
    expect(first.backedUp).toBe(1);
    const backups = readdirSync(fx.paiSkillsDir).filter(n => n.startsWith("Research.backup-"));
    expect(backups.length).toBe(1);

    // Second run: must NOT symlink the backup dir from pai side to claude side.
    fx.events.length = 0;
    const second = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);
    expect(second.migrated).toBe(0);
    expect(second.backedUp).toBe(0);
    expect(second.failed).toBe(0);
    // No entry for the backup dir should have been created on claude side.
    expect(existsSync(join(fx.claudeSkillsDir, backups[0]))).toBe(false);
  });

  test("PAI and CORE top-level names are skipped", async () => {
    makePackDir(fx.claudeSkillsDir, "PAI");
    makePackDir(fx.claudeSkillsDir, "Research");

    const summary = await migratePerPackSymlinks(fx.paiDirArg, fx.emit);

    // Only Research is migrated. PAI is skipped as a system dir.
    expect(summary.migrated).toBe(1);
    expect(lstatSync(join(fx.claudeSkillsDir, "PAI")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(fx.claudeSkillsDir, "Research")).isSymbolicLink()).toBe(true);
  });
});
