import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ChangedFile,
  RepositoryInfo,
  SnapshotSummary,
} from "../shared/types";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

type GitResult = { stdout: string; stderr: string };

export async function runGit(
  cwd: string,
  args: readonly string[],
  allowFailure = false,
): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "false",
        LC_ALL: "C",
      },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    if (allowFailure) {
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
    const detail = (failure.stderr ?? failure.message).trim();
    throw new GitError(detail || "Git command failed.");
  }
}

export async function resolveRepository(
  selectedPath: string,
): Promise<RepositoryInfo> {
  const canonicalSelection = await realpath(selectedPath);
  const result = await runGit(canonicalSelection, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const root = await realpath(result.stdout.trim());
  const revision = await readRevision(root);
  return {
    root,
    name: basename(root),
    ...revision,
  };
}

export async function resolveGitDirectory(root: string): Promise<string> {
  const result = await runGit(root, ["rev-parse", "--absolute-git-dir"]);
  return realpath(result.stdout.trim());
}

export async function readRevision(
  root: string,
): Promise<Pick<RepositoryInfo, "branch" | "head">> {
  const [branchResult, headResult] = await Promise.all([
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true),
    runGit(root, ["rev-parse", "--verify", "--short=12", "HEAD"], true),
  ]);
  return {
    branch: branchResult.stdout.trim() || "detached",
    head: headResult.stdout.trim() || "unborn",
  };
}

export function parsePorcelainV2(output: string): ChangedFile[] {
  const records = output.split("\0");
  const files: ChangedFile[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const kind = record[0];
    if (kind === "?" || kind === "!") {
      if (kind === "?") {
        files.push({ path: record.slice(2), status: "??" });
      }
      continue;
    }

    if (kind === "1") {
      const fields = record.split(" ");
      files.push({ path: fields.slice(8).join(" "), status: fields[1] });
      continue;
    }

    if (kind === "2") {
      const fields = record.split(" ");
      const path = fields.slice(9).join(" ");
      const originalPath = records[index + 1];
      files.push({
        path,
        status: `${fields[1]} ${originalPath ? `from ${originalPath}` : ""}`.trim(),
      });
      index += 1;
      continue;
    }

    if (kind === "u") {
      const fields = record.split(" ");
      files.push({ path: fields.slice(10).join(" "), status: fields[1] });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function hashPath(
  hasher: ReturnType<typeof createHash>,
  path: string,
): Promise<number> {
  try {
    const metadata = await lstat(path);
    hasher.update(`${metadata.mode}:${metadata.size}:`);
    if (metadata.isSymbolicLink()) {
      hasher.update(await readlink(path));
      return 0;
    }
    if (!metadata.isFile()) return 0;
    let lines = 0;
    let sawContent = false;
    let lastByte = 0;
    let binary = false;
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hasher.update(buffer);
        sawContent ||= buffer.length > 0;
        if (buffer.includes(0)) binary = true;
        for (const byte of buffer) {
          if (byte === 10) lines += 1;
        }
        if (buffer.length > 0) lastByte = buffer[buffer.length - 1];
      });
      stream.on("end", resolveStream);
      stream.on("error", rejectStream);
    });
    if (binary) return 0;
    return lines + (sawContent && lastByte !== 10 ? 1 : 0);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== "ENOENT") throw error;
    hasher.update("<deleted>");
    return 0;
  }
}

function parseNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [added, deleted] = line.split("\t");
    if (added !== "-") additions += Number.parseInt(added, 10) || 0;
    if (deleted !== "-") deletions += Number.parseInt(deleted, 10) || 0;
  }
  return { additions, deletions };
}

async function readDiffStat(root: string, hasHead: boolean) {
  const baseArgs = ["diff", "--no-ext-diff", "--no-textconv", "--numstat"];
  if (hasHead) {
    const result = await runGit(root, [...baseArgs, "HEAD", "--"], true);
    return parseNumstat(result.stdout);
  }
  const [staged, unstaged] = await Promise.all([
    runGit(root, [...baseArgs, "--cached", "--"], true),
    runGit(root, [...baseArgs, "--"], true),
  ]);
  const left = parseNumstat(staged.stdout);
  const right = parseNumstat(unstaged.stdout);
  return {
    additions: left.additions + right.additions,
    deletions: left.deletions + right.deletions,
  };
}

export async function captureSnapshot(
  root: string,
): Promise<SnapshotSummary | null> {
  const [statusResult, revision] = await Promise.all([
    runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    readRevision(root),
  ]);
  const files = parsePorcelainV2(statusResult.stdout);
  if (files.length === 0) return null;

  const hasher = createHash("sha256");
  hasher.update(revision.branch);
  hasher.update("\0");
  hasher.update(revision.head);
  hasher.update("\0");
  hasher.update(statusResult.stdout);

  let untrackedAdditions = 0;
  for (const file of files) {
    hasher.update("\0");
    hasher.update(file.path);
    const lines = await hashPath(hasher, resolve(root, file.path));
    if (file.status === "??") untrackedAdditions += lines;
  }

  const stats = await readDiffStat(root, revision.head !== "unborn");
  return {
    id: hasher.digest("hex"),
    ...revision,
    files,
    fileCount: files.length,
    additions: stats.additions + untrackedAdditions,
    deletions: stats.deletions,
    capturedAt: new Date().toISOString(),
  };
}
