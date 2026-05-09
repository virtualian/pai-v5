/**
 * PAI Installer v4.0 — Repo URL Resolution (GitHub #115)
 *
 * Priority (first match wins):
 *   1. PAI_REPO_URL env var (set by install.sh --repo-url= or ambient env)
 *   2. Existing `origin` remote at <paiDir>/.git (fork-remote preservation)
 *   3. DEFAULT_PAI_REPO_URL (upstream fallback)
 */

import { existsSync } from "fs";
import { join } from "path";
import { tryExec } from "./exec";

export const DEFAULT_PAI_REPO_URL = "https://github.com/danielmiessler/Personal_AI_Infrastructure.git";

type RepoUrlSource = "env" | "remote" | "default";

export interface ResolvedRepoUrl {
  url: string;
  source: RepoUrlSource;
  sourceLabel: string;
}

const SOURCE_LABELS: Record<RepoUrlSource, string> = {
  env: "PAI_REPO_URL env var",
  remote: "existing origin remote",
  default: "upstream default",
};

export function resolveRepoUrl(paiDir?: string): ResolvedRepoUrl {
  const envUrl = (process.env.PAI_REPO_URL || "").trim();
  if (envUrl) {
    return { url: envUrl, source: "env", sourceLabel: SOURCE_LABELS.env };
  }

  if (paiDir) {
    const existingRemote = readOriginRemote(paiDir);
    if (existingRemote) {
      return { url: existingRemote, source: "remote", sourceLabel: SOURCE_LABELS.remote };
    }
  }

  return { url: DEFAULT_PAI_REPO_URL, source: "default", sourceLabel: SOURCE_LABELS.default };
}

export function readOriginRemote(paiDir: string): string | null {
  if (!existsSync(join(paiDir, ".git"))) return null;

  // 5s timeout guards against hangs on corrupted repos.
  const raw = tryExec(`git -C "${paiDir}" remote get-url origin 2>/dev/null`, 5000);
  return raw || null;
}
