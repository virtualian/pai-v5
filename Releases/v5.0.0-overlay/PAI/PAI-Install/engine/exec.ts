/**
 * PAI Installer v4.0 — Shared subprocess helper (GitHub #121)
 *
 * Safe synchronous subprocess wrapper with a configurable timeout that
 * returns `null` on any failure instead of throwing. Previously hand-rolled
 * three times across `actions.ts`, `detect.ts`, and once more inline inside
 * `repo-url.ts#readOriginRemote`. Promoted here as a leaf utility with zero
 * imports from the installer tree, so any consumer (current or future) can
 * depend on it without risking a circular import through the heavier graphs
 * of the original hosts.
 *
 * Default timeout is 30s to match the historical `actions.ts` default.
 * Call sites that need a tighter bound — e.g. `detect.ts` short probes —
 * pass the timeout explicitly.
 */

import { execSync, execFileSync } from "child_process";

export function tryExec(cmd: string, timeout = 30000): string | null {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Like `tryExec`, but invokes a single binary with structured arg vector and
 * working directory — no shell, no string concatenation. Use this whenever
 * the binary path or any arg might contain user-controlled input (env vars,
 * filesystem paths, etc.) so quotes/dollars/backticks cannot inject commands.
 */
export function tryExecAt(
  file: string,
  args: string[],
  cwd: string,
  timeout = 30000,
): string | null {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}
