/**
 * preserve-claudemd.test.ts — Bun tests for CLAUDE.md preservation logic.
 *
 * Run: bun test preserve-claudemd.test.ts
 *
 * Uses a throwaway tmp root per test so nothing touches the real ~/.claude.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyPreservation,
  backupIfDiffers,
  extractUserImports,
  filterResolvableImports,
  injectImportsAbovePaiHeading,
} from "./preserve-claudemd";

const TEMPLATE = `# PAI {{PAI_VERSION}} — Personal AI Infrastructure

# MODES

Everything else.
`;

let root: string;
let claudeMd: string;

beforeEach(() => {
  root = join(tmpdir(), `preserve-claudemd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  claudeMd = join(root, "CLAUDE.md");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("extractUserImports", () => {
  test("pulls a single @-import from the top", () => {
    const content = `@.claude/CLAUDE-USER.md\n\n# PAI 4.0.3\n\nbody`;
    expect(extractUserImports(content)).toEqual(["@.claude/CLAUDE-USER.md"]);
  });

  test("stops at the first heading", () => {
    const content = `@a.md\n\n# PAI\n@b.md\n`;
    expect(extractUserImports(content)).toEqual(["@a.md"]);
  });

  test("returns empty when there are no imports", () => {
    expect(extractUserImports(TEMPLATE)).toEqual([]);
  });

  test("handles multiple imports in order", () => {
    const content = `@x.md\n@y.md\n@z.md\n\n# PAI\n`;
    expect(extractUserImports(content)).toEqual(["@x.md", "@y.md", "@z.md"]);
  });
});

describe("injectImportsAbovePaiHeading", () => {
  test("no imports = template verbatim", () => {
    expect(injectImportsAbovePaiHeading(TEMPLATE, [])).toBe(TEMPLATE);
  });

  test("inserts imports above # PAI", () => {
    const out = injectImportsAbovePaiHeading(TEMPLATE, ["@user.md"]);
    expect(out.startsWith("@user.md\n\n# PAI")).toBe(true);
    expect(out).toContain("# MODES");
  });

  test("preserves multiple imports in order", () => {
    const out = injectImportsAbovePaiHeading(TEMPLATE, ["@a.md", "@b.md"]);
    expect(out.startsWith("@a.md\n@b.md\n\n# PAI")).toBe(true);
  });
});

describe("filterResolvableImports", () => {
  test("keeps imports whose target exists", () => {
    writeFileSync(join(root, "exists.md"), "x");
    const result = filterResolvableImports(["@exists.md"], root);
    expect(result.kept).toEqual(["@exists.md"]);
    expect(result.dropped).toEqual([]);
  });

  test("drops imports whose target is missing", () => {
    const result = filterResolvableImports(["@missing.md"], root);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual(["@missing.md"]);
  });

  test("resolves nested paths relative to rootDir", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "user.md"), "x");
    const result = filterResolvableImports(["@.claude/user.md"], root);
    expect(result.kept).toEqual(["@.claude/user.md"]);
  });

  test("resolves Claude Code HOME-relative imports (the real ~/.claude/CLAUDE.md case)", () => {
    // Real case: rootDir = ~/.claude, import @.claude/foo.md, file at ~/.claude/foo.md.
    // Under tmp: root = HOME-proxy, claudeDir = .claude subdir, file directly inside it.
    const claudeDir = join(root, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "user-config.md"), "x");
    // rootDir is the .claude dir; resolver should try parentDir (root) + ".claude/user-config.md".
    const result = filterResolvableImports(["@.claude/user-config.md"], claudeDir);
    expect(result.kept).toEqual(["@.claude/user-config.md"]);
  });
});

describe("backupIfDiffers", () => {
  test("no backup when content is identical", () => {
    writeFileSync(claudeMd, "same\n");
    const result = backupIfDiffers(claudeMd, "same\n", "same\n");
    expect(result.backupPath).toBeNull();
    expect(result.diff).toBeNull();
  });

  test("writes backup with old bytes when content differs", () => {
    const result = backupIfDiffers(claudeMd, "old line\n", "new line\n");
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe("old line\n");
    expect(result.diff).toEqual({ added: 1, removed: 1 });
  });

  test("backup filename includes millisecond precision", () => {
    const result = backupIfDiffers(claudeMd, "old\n", "new\n");
    expect(result.backupPath).toMatch(/CLAUDE\.md\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});

describe("applyPreservation", () => {
  test("fresh install (no pre-existing file) → no preservation, no backup, unchanged false", () => {
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(result.finalContent).toBe(TEMPLATE);
    expect(result.unchanged).toBe(false);
    expect(result.log).toEqual([]);
    expect(readdirSync(root).filter((f) => f.startsWith("CLAUDE.md.bak"))).toEqual([]);
  });

  test("no imports + content identical → unchanged flag set, no backup, no log noise", () => {
    writeFileSync(claudeMd, TEMPLATE);
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(result.finalContent).toBe(TEMPLATE);
    expect(result.unchanged).toBe(true);
    expect(result.log).toEqual([]);
  });

  test("resolvable user import → preserved above # PAI heading", () => {
    writeFileSync(join(root, "custom.md"), "x");
    writeFileSync(claudeMd, `@custom.md\n\n# PAI 4.0.2\n\nold body\n`);
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(result.finalContent.startsWith("@custom.md\n\n# PAI")).toBe(true);
    expect(result.log.some((l) => l.includes("preserved 1, dropped 0"))).toBe(true);
  });

  test("dangling user import → dropped with log", () => {
    writeFileSync(claudeMd, `@ghost.md\n\n# PAI 4.0.2\n`);
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(result.finalContent).not.toContain("@ghost.md");
    expect(result.log.some((l) => l.includes("preserved 0, dropped 1"))).toBe(true);
    expect(result.log.some((l) => l.includes("dropped broken import: @ghost.md"))).toBe(true);
  });

  test("mix of resolvable + dangling → only resolvable preserved", () => {
    writeFileSync(join(root, "real.md"), "x");
    writeFileSync(claudeMd, `@real.md\n@ghost.md\n\n# PAI 4.0.2\n`);
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(result.finalContent).toContain("@real.md");
    expect(result.finalContent).not.toContain("@ghost.md");
    expect(result.log.some((l) => l.includes("preserved 1, dropped 1"))).toBe(true);
  });

  test("content change triggers backup + drift log", () => {
    writeFileSync(claudeMd, `# PAI 4.0.2\n\nold body\n`);
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    const hasBackupLog = result.log.some((l) => l.startsWith("[preserve-claudemd] backup:"));
    const hasDriftLog = result.log.some((l) => l.startsWith("[preserve-claudemd] drift:"));
    expect(hasBackupLog).toBe(true);
    expect(hasDriftLog).toBe(true);
    const backups = readdirSync(root).filter((f) => f.startsWith("CLAUDE.md.bak"));
    expect(backups.length).toBe(1);
  });

  test("identical content after preservation → unchanged true, no backup", () => {
    writeFileSync(claudeMd, TEMPLATE);
    const result = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(result.unchanged).toBe(true);
    const backups = readdirSync(root).filter((f) => f.startsWith("CLAUDE.md.bak"));
    expect(backups.length).toBe(0);
    expect(result.log).toEqual([]);
  });

  test("preserved import survives second rebuild (idempotence)", () => {
    writeFileSync(join(root, "custom.md"), "x");
    writeFileSync(claudeMd, `@custom.md\n\n# PAI 4.0.2\n\nold\n`);

    const first = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    writeFileSync(claudeMd, first.finalContent);

    const second = applyPreservation({
      existingPath: claudeMd,
      newContent: TEMPLATE,
      rootDir: root,
    });
    expect(second.finalContent.startsWith("@custom.md\n\n# PAI")).toBe(true);
  });
});
