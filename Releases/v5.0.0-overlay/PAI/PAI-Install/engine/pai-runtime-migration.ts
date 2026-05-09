/**
 * PAI Installer v4.0 — PAI Runtime Materialisation (GitHub #160)
 *
 * Copies the shipped runtime artefacts (package.json, bun.lock,
 * PAI/PAISECURITYSYSTEM/) from `~/.claude/` to `~/.pai/`, then runs
 * `bun install` to populate `~/.pai/node_modules/`. Closes the
 * SecurityValidator no-op regression chain (#156 → #157 → #158 → #159 → #160):
 * the hook needs the `yaml` package resolvable from ~/.pai/hooks/ and
 * the patterns.example.yaml file present at ~/.pai/PAI/PAISECURITYSYSTEM/.
 *
 * Mechanism: copy (not symlink). Reason: ~/.pai/ is an independent
 * runtime; user-edited patterns.yaml lives alongside the shipped
 * patterns.example.yaml without crossing the ~/.claude boundary.
 *
 * Ordering: runs from `runRepository` AFTER `migratePerPackSymlinks`
 * and `migratePerPackCommands`, so the per-pack canonicalization for
 * skills/commands has already completed and `~/.pai/` exists.
 *
 * Fail-open: each sub-routine soft-fails. A failure here MUST NOT
 * abort the wider install — verify-security-validator.sh will surface
 * the issue post-install if anything went wrong.
 *
 * Maintenance: when bumping the yaml dep version in package.json,
 * also run `bun install` in Releases/v4.0.3+/.claude/ and commit the
 * regenerated bun.lock. The shipped lockfile pins the exact version
 * that the installer materialises.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  copyFileSync,
  cpSync,
} from "fs";
import { join } from "path";
import type { EngineEventHandler } from "./types";
import { tryExec, tryExecAt } from "./exec";
import { getPaiHome, makeCpFilter } from "./pai-paths";

/**
 * Byte-compare two files. Returns true if both exist and have identical
 * contents. Returns false on any read failure or size mismatch (cheap
 * short-circuit before the full read).
 */
function filesIdentical(a: string, b: string): boolean {
  try {
    if (!existsSync(a) || !existsSync(b)) return false;
    const aStat = statSync(a);
    const bStat = statSync(b);
    if (aStat.size !== bStat.size) return false;
    const aBuf = readFileSync(a);
    const bBuf = readFileSync(b);
    return aBuf.equals(bBuf);
  } catch {
    return false;
  }
}

// ─── Action variants ─────────────────────────────────────────────

export type PackageJsonAction = "copied" | "already-current" | "source-absent" | "failed";
export type BunLockAction = "copied" | "already-current" | "source-absent" | "failed";
export type BunInstallAction = "ran" | "skipped-yaml-present" | "failed" | "bun-missing";
export type PaiSecuritySystemAction = "copied" | "source-absent" | "failed";

export interface PaiRuntimeMigrationSummary {
  packageJsonAction: PackageJsonAction;
  bunLockAction: BunLockAction;
  bunInstallAction: BunInstallAction;
  paiSecuritySystemAction: PaiSecuritySystemAction;
  failed: number;
}

// ─── Sub-routines ────────────────────────────────────────────────

interface PackageManifestResult {
  packageJsonAction: PackageJsonAction;
  bunLockAction: BunLockAction;
}

/**
 * Copy `package.json` and `bun.lock` from `~/.claude/` → `~/.pai/`.
 *
 * Skip-if-identical: byte-compare source against dest first; only overwrite
 * if they differ. This keeps idempotency clean — second run on an unchanged
 * machine does no writes and emits "already-current" for both files.
 *
 * Soft-fail per file. A failure on package.json does not block bun.lock
 * (or vice versa) — both are independent decisions for the wrapper.
 */
async function materializePackageManifest(
  claudeRoot: string,
  paiHome: string,
  emit: EngineEventHandler,
): Promise<PackageManifestResult> {
  const result: PackageManifestResult = {
    packageJsonAction: "source-absent",
    bunLockAction: "source-absent",
  };

  const files: Array<{
    name: "package.json" | "bun.lock";
    setAction: (a: "copied" | "already-current" | "source-absent" | "failed") => void;
  }> = [
    {
      name: "package.json",
      setAction: (a) => { result.packageJsonAction = a; },
    },
    {
      name: "bun.lock",
      setAction: (a) => { result.bunLockAction = a; },
    },
  ];

  for (const { name, setAction } of files) {
    const src = join(claudeRoot, name);
    const dest = join(paiHome, name);

    await emit({
      event: "progress",
      step: "repository",
      percent: 82,
      detail: `Materializing ${name} into ~/.pai/...`,
    });

    if (!existsSync(src)) {
      setAction("source-absent");
      await emit({
        event: "message",
        content: `PAI runtime: ${name} absent at source — skipped.`,
      });
      continue;
    }

    if (filesIdentical(src, dest)) {
      setAction("already-current");
      await emit({
        event: "message",
        content: `PAI runtime: ${name} already current — no copy needed.`,
      });
      continue;
    }

    try {
      copyFileSync(src, dest);
      setAction("copied");
      await emit({
        event: "message",
        content: `PAI runtime: ${name} copied to ~/.pai/${name}.`,
      });
    } catch (err) {
      setAction("failed");
      const msg = err instanceof Error ? err.message : String(err);
      await emit({
        event: "message",
        content: `PAI runtime: ${name} copy failed — ${msg}`,
      });
    }
  }

  return result;
}

/**
 * Run `bun install` inside `~/.pai/` to populate `~/.pai/node_modules/`.
 *
 * Fast-skip: if `~/.pai/node_modules/yaml/package.json` already exists AND
 * the manifest copy was either `already-current` or `source-absent`, the
 * SecurityValidator hook can resolve `yaml` and we skip the install.
 * If the manifest was just `copied`, we run install regardless of the
 * yaml marker — a manifest refresh might bump the pinned version and
 * skipping would leave node_modules stale.
 *
 * Bun detection uses `command -v bun`; if absent we return "bun-missing"
 * rather than failing the install. SecurityValidator's lazy-yaml fail-open
 * (PR #157) keeps the hook non-fatal in that scenario.
 *
 * `tryExec`/`tryExecAt` return null on any failure including non-zero exit,
 * so we never throw out of this function.
 */
async function runBunInstall(
  paiHome: string,
  manifestRefreshed: boolean,
  emit: EngineEventHandler,
): Promise<BunInstallAction> {
  const yamlMarker = join(paiHome, "node_modules", "yaml", "package.json");
  if (!manifestRefreshed && existsSync(yamlMarker)) {
    await emit({
      event: "message",
      content: `PAI runtime: bun install skipped — yaml already resolvable at ~/.pai/node_modules/yaml/.`,
    });
    return "skipped-yaml-present";
  }

  await emit({
    event: "progress",
    step: "repository",
    percent: 84,
    detail: `Running bun install in ~/.pai/...`,
  });

  const bunPath = tryExec("command -v bun");
  if (!bunPath) {
    await emit({
      event: "message",
      content: `PAI runtime: bun not found on PATH — skipping install. SecurityValidator will fail open until 'bun install' is run in ~/.pai/.`,
    });
    return "bun-missing";
  }

  // 120s timeout matches the spec; bun install on a cold cache for a
  // single-dep manifest fits comfortably inside this bound. Uses
  // `tryExecAt` (no shell) so paths with quotes/dollars/backticks
  // cannot inject commands.
  const out = tryExecAt("bun", ["install"], paiHome, 120000);
  if (out === null) {
    await emit({
      event: "message",
      content: `PAI runtime: bun install failed in ~/.pai/. Run it manually to populate node_modules.`,
    });
    return "failed";
  }

  await emit({
    event: "message",
    content: `PAI runtime: bun install completed in ~/.pai/.`,
  });
  return "ran";
}

/**
 * Copy `~/.claude/PAI/PAISECURITYSYSTEM/` → `~/.pai/PAI/PAISECURITYSYSTEM/`
 * recursively.
 *
 * `cpSync` walks ONLY the source tree, so dest-only files (the user's
 * edited `patterns.yaml`) are never visited and stay untouched. We use
 * `force: true` (the default) to ensure shipped artefacts like
 * `patterns.example.yaml` overwrite any older version in dest — this is
 * the whole point of the materialisation step.
 *
 * Skip the whole subroutine if the source dir is absent; that's the
 * shipped-artefact contract from PR #159 and means the user is on a
 * tree without security-system files.
 */
async function materializePaiSecuritySystem(
  claudeRoot: string,
  paiHome: string,
  emit: EngineEventHandler,
): Promise<PaiSecuritySystemAction> {
  const srcDir = join(claudeRoot, "PAI", "PAISECURITYSYSTEM");
  const destDir = join(paiHome, "PAI", "PAISECURITYSYSTEM");

  if (!existsSync(srcDir)) {
    await emit({
      event: "message",
      content: `PAI runtime: PAISECURITYSYSTEM absent at source — skipped.`,
    });
    return "source-absent";
  }

  try {
    cpSync(srcDir, destDir, {
      recursive: true,
      dereference: false,
      force: true,
      // allowBackups: true — no-op for shipped tree (no backup files), explicit for intent.
      filter: makeCpFilter({ allowBackups: true }),
    });
    await emit({
      event: "message",
      content: `PAI runtime: PAISECURITYSYSTEM copied to ~/.pai/PAI/PAISECURITYSYSTEM/.`,
    });
    return "copied";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emit({
      event: "message",
      content: `PAI runtime: PAISECURITYSYSTEM copy failed — ${msg}`,
    });
    return "failed";
  }
}

// ─── Public entry point ──────────────────────────────────────────

/**
 * Main entry point. Materialises the shipped PAI runtime artefacts from
 * `~/.claude/` into `~/.pai/` so the SecurityValidator hook (and any
 * future hook depending on `yaml` or shipped pattern files) can resolve
 * its dependencies at runtime.
 *
 * Order of operations:
 *   1. Copy package.json + bun.lock (manifest is needed before install).
 *   2. Run bun install (or skip if yaml is already resolvable / bun missing).
 *   3. Copy PAISECURITYSYSTEM tree (independent of the bun install outcome).
 *
 * @param paiDir The installer's `paiDir` variable — SEMANTICALLY the
 *               Claude Code config root (`~/.claude`), despite the
 *               misleading name. Same convention as skill-migration.ts.
 * @param emit   Installer event handler.
 * @returns      Per-subroutine action variants and a `failed` count for
 *               the wider install to surface in its summary.
 */
export async function migratePaiRuntime(
  paiDir: string,
  emit: EngineEventHandler,
): Promise<PaiRuntimeMigrationSummary> {
  const claudeRoot = paiDir;
  const paiHome = getPaiHome();

  const summary: PaiRuntimeMigrationSummary = {
    packageJsonAction: "source-absent",
    bunLockAction: "source-absent",
    bunInstallAction: "failed",
    paiSecuritySystemAction: "source-absent",
    failed: 0,
  };

  // Invariant: paiHome must be (or become) a directory we can write to.
  // If it exists as a regular file we cannot proceed without overwriting
  // user data — surface a clear diagnostic and abort the module (the
  // wider install continues; this is fail-open at the module boundary).
  if (existsSync(paiHome) && !statSync(paiHome).isDirectory()) {
    summary.failed = 1;
    summary.packageJsonAction = "failed";
    summary.bunLockAction = "failed";
    summary.bunInstallAction = "failed";
    summary.paiSecuritySystemAction = "failed";
    await emit({
      event: "message",
      content: `PAI runtime: aborted — ${paiHome} exists but is not a directory. Resolve manually before re-running the installer.`,
    });
    return summary;
  }
  if (!existsSync(paiHome)) {
    try {
      mkdirSync(paiHome, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.failed = 1;
      summary.packageJsonAction = "failed";
      summary.bunLockAction = "failed";
      summary.bunInstallAction = "failed";
      summary.paiSecuritySystemAction = "failed";
      await emit({
        event: "message",
        content: `PAI runtime: aborted — could not create ${paiHome}: ${msg}`,
      });
      return summary;
    }
  }

  // 1. Manifest copy.
  const manifestResult = await materializePackageManifest(claudeRoot, paiHome, emit);
  summary.packageJsonAction = manifestResult.packageJsonAction;
  summary.bunLockAction = manifestResult.bunLockAction;
  if (summary.packageJsonAction === "failed") summary.failed++;
  if (summary.bunLockAction === "failed") summary.failed++;

  // 2. bun install. If the manifest was just copied, force install so a
  // version bump in package.json/bun.lock actually lands in node_modules
  // (otherwise the yaml-marker fast-skip would leave the old version).
  const manifestRefreshed =
    summary.packageJsonAction === "copied" || summary.bunLockAction === "copied";
  summary.bunInstallAction = await runBunInstall(paiHome, manifestRefreshed, emit);
  if (summary.bunInstallAction === "failed") summary.failed++;

  // 3. PAISECURITYSYSTEM copy.
  summary.paiSecuritySystemAction = await materializePaiSecuritySystem(
    claudeRoot,
    paiHome,
    emit,
  );
  if (summary.paiSecuritySystemAction === "failed") summary.failed++;

  await emit({
    event: "message",
    content:
      `PAI runtime materialisation: ` +
      `package.json=${summary.packageJsonAction}, ` +
      `bun.lock=${summary.bunLockAction}, ` +
      `bun install=${summary.bunInstallAction}, ` +
      `PAISECURITYSYSTEM=${summary.paiSecuritySystemAction}, ` +
      `failed=${summary.failed}.`,
  });

  return summary;
}
