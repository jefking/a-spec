// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSnapshot,
  parsePorcelainV2,
  resolveRepository,
  runGit,
} from "../src/main/git";

const temporaryDirectories: string[] = [];

async function temporaryRepository(withCommit = true) {
  const root = await mkdtemp(join(tmpdir(), "a-spec-git-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "A-Spec Test"]);
  await runGit(root, ["config", "user.email", "a-spec@example.test"]);
  if (withCommit) {
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "tracked.ts"), "export const value = 1;\n");
    await runGit(root, ["add", ".gitignore", "tracked.ts"]);
    await runGit(root, ["commit", "-qm", "initial"]);
  }
  return root;
}

async function hashTree(root: string) {
  const hash = createHash("sha256");
  async function visit(path: string) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      hash.update(relative(root, fullPath));
      const metadata = await stat(fullPath);
      hash.update(String(metadata.mode));
      if (entry.isDirectory()) await visit(fullPath);
      if (entry.isFile()) hash.update(await readFile(fullPath));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("parsePorcelainV2", () => {
  it("parses ordinary, renamed, untracked, and ignored records", () => {
    const output = [
      "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/file with space.ts",
      "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new.ts",
      "src/old.ts",
      "? notes.txt",
      "! ignored.log",
      "",
    ].join("\0");
    expect(parsePorcelainV2(output)).toEqual([
      { path: "notes.txt", status: "??" },
      { path: "src/file with space.ts", status: ".M" },
      { path: "src/new.ts", status: "R. from src/old.ts" },
    ]);
  });
});

describe("Git snapshots", () => {
  it("resolves nested selections to the worktree root", async () => {
    const root = await temporaryRepository();
    const nested = join(root, "nested");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
    const repository = await resolveRepository(nested);
    expect(repository.root).toBe(root);
    expect(repository.name).toBe(root.split("/").at(-1));
  });

  it("captures staged, unstaged, and untracked content but excludes ignored files", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
    await runGit(root, ["add", "tracked.ts"]);
    await writeFile(join(root, "tracked.ts"), "export const value = 3;\n");
    await writeFile(join(root, "untracked.ts"), "export const fresh = true;\n");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "ignored")));
    await writeFile(join(root, "ignored", "cache.txt"), "ignore me\n");

    const snapshot = await captureSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.files.map((file) => file.path)).toEqual([
      "tracked.ts",
      "untracked.ts",
    ]);
    expect(snapshot?.additions).toBeGreaterThan(0);
  });

  it("changes its fingerprint when content changes under the same Git status", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
    const first = await captureSnapshot(root);
    await writeFile(join(root, "tracked.ts"), "export const value = 200;\n");
    const second = await captureSnapshot(root);
    expect(first?.files).toEqual(second?.files);
    expect(first?.id).not.toBe(second?.id);
  });

  it("keeps the same fingerprint for an unchanged snapshot", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
    const first = await captureSnapshot(root);
    const repeated = await captureSnapshot(root);
    expect(repeated?.id).toBe(first?.id);
  });

  it("supports repositories without a first commit", async () => {
    const root = await temporaryRepository(false);
    await writeFile(join(root, "new.ts"), "const first = true;\n");
    const snapshot = await captureSnapshot(root);
    expect(snapshot?.head).toBe("unborn");
    expect(snapshot?.files).toEqual([{ path: "new.ts", status: "??" }]);
  });

  it("does not mutate repository bytes while capturing", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
    const before = await hashTree(root);
    await captureSnapshot(root);
    const after = await hashTree(root);
    expect(after).toBe(before);
  });
});
