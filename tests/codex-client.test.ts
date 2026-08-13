// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer } from "../src/main/codex-client";

const temporaryDirectories: string[] = [];

async function fakeCodex() {
  const root = await mkdtemp(join(tmpdir(), "a-spec-codex-"));
  temporaryDirectories.push(root);
  const binary = join(root, "codex");
  const source = `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", line => {
  const message = JSON.parse(line);
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: "test@example.test", planType: "plus" }, requiresOpenaiAuth: true } });
  if (message.method === "thread/start") {
    if (message.params.cwd !== "/tmp/repository" || message.params.ephemeral !== true) {
      send({ id: message.id, error: { code: -32602, message: "review thread must be ephemeral and use the repository cwd" } });
    } else {
      send({ id: message.id, result: { thread: { id: "review-thread" } } });
    }
  }
  if (message.method === "thread/fork") send({ id: message.id, error: { code: -32602, message: "ephemeral threads cannot be forked" } });
  if (message.method === "review/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" }, reviewThreadId: "review-thread" } });
    send({ method: "item/completed", params: { threadId: "review-thread", turnId: "turn-1", item: { type: "exitedReviewMode", id: "turn-1", review: "## Review\\n\\nLooks good." } } });
    send({ method: "turn/completed", params: { threadId: "review-thread", turn: { id: "turn-1", status: "completed", error: null } } });
  }
  if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
});
`;
  await writeFile(binary, source, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { binary, packageRoot: root };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex app-server client", () => {
  it("initializes, reads shared auth, and reviews on a fresh ephemeral thread", async () => {
    const runtime = await fakeCodex();
    const client = new CodexAppServer(() => runtime);
    await client.start();
    await expect(client.readAccount()).resolves.toMatchObject({
      account: { type: "chatgpt" },
    });
    await expect(
      client.reviewUncommittedChanges(
        "/tmp/repository",
        new AbortController().signal,
      ),
    ).resolves.toBe("## Review\n\nLooks good.");
    await client.stop();
  });

  it("rejects a superseded review without returning stale output", async () => {
    const runtime = await fakeCodex();
    const client = new CodexAppServer(() => runtime);
    await client.start();
    const abort = new AbortController();
    abort.abort();
    await expect(
      client.reviewUncommittedChanges("/tmp/repository", abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await client.stop();
  });
});
