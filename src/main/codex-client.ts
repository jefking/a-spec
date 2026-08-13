import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";

type RequestId = number;
type JsonObject = Record<string, unknown>;

type RpcMessage = {
  id?: RequestId;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

export type AccountState = {
  account: null | { type: string; email?: string | null; planType?: string };
  requiresOpenaiAuth: boolean;
};

export type LoginStartResult =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: string };

type ThreadResponse = {
  thread: { id: string };
};

type ReviewResponse = {
  turn: { id: string };
  reviewThreadId: string;
};

type CompletedTurn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: null | { message: string };
};

export class CodexClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexClientError";
  }
}

function unpackedPath(path: string): string {
  const marker = `${sep}app.asar${sep}`;
  return path.includes(marker)
    ? path.replace(marker, `${sep}app.asar.unpacked${sep}`)
    : path;
}

export function resolveCodexBinary(): {
  binary: string;
  packageRoot: string;
} {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new CodexClientError(
      `A-Spec currently supports Linux x64, not ${process.platform} ${process.arch}.`,
    );
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    const packageRoot = join(resourcesPath, "codex-runtime");
    const binary = join(
      packageRoot,
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
      "codex",
    );
    if (existsSync(binary)) return { binary, packageRoot };
  }

  const require = createRequire(import.meta.url);
  const platformPackage = unpackedPath(
    require.resolve("@openai/codex-linux-x64/package.json"),
  );
  const packageRoot = unpackedPath(
    dirname(require.resolve("@openai/codex/package.json")),
  );
  const binary = join(
    dirname(platformPackage),
    "vendor",
    "x86_64-unknown-linux-musl",
    "bin",
    "codex",
  );

  if (!existsSync(binary)) {
    throw new CodexClientError(`Bundled Codex runtime is missing at ${binary}.`);
  }
  return { binary, packageRoot };
}

export class CodexAppServer extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private stopping = false;

  constructor(
    private readonly runtimeResolver: typeof resolveCodexBinary = resolveCodexBinary,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    const runtime = this.runtimeResolver();
    this.stopping = false;
    this.process = spawn(runtime.binary, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_MANAGED_BY_NPM: "1",
        CODEX_MANAGED_PACKAGE_ROOT: runtime.packageRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) this.emit("diagnostic", message);
    });
    this.process.once("error", (error) => this.handleExit(error));
    this.process.once("exit", (code, signal) => {
      if (!this.stopping) {
        this.handleExit(
          new CodexClientError(
            `Codex app-server exited unexpectedly (${signal ?? code ?? "unknown"}).`,
          ),
        );
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "a_spec",
        title: "A-Spec",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolveStop();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });
    });
    this.rejectPending(new CodexClientError("Codex app-server stopped."));
  }

  async readAccount(): Promise<AccountState> {
    return this.request<AccountState>("account/read", { refreshToken: false });
  }

  async startChatGptLogin(): Promise<LoginStartResult> {
    return this.request<LoginStartResult>("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "codex",
    });
  }

  async createSeedThread(root: string): Promise<string> {
    const response = await this.request<ThreadResponse>("thread/start", {
      cwd: root,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: true,
      serviceName: "a-spec",
      config: {
        web_search: "disabled",
        features: { apps: false },
        apps: { _default: { enabled: false } },
      },
    });
    return response.thread.id;
  }

  async reviewUncommittedChanges(
    seedThreadId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const fork = await this.request<ThreadResponse>("thread/fork", {
      threadId: seedThreadId,
      ephemeral: true,
    });
    const threadId = fork.thread.id;

    let turnId: string | null = null;
    let finalReview: string | null = null;
    let settled = false;

    return new Promise<string>((resolveReview, rejectReview) => {
      const cleanup = () => {
        this.off("notification", onNotification);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const interrupt = async () => {
        if (!turnId) return;
        try {
          await this.request("turn/interrupt", { threadId, turnId });
        } catch {
          // The turn may have completed between the change event and interrupt.
        }
      };
      const onAbort = () => {
        void interrupt();
        finish(() => rejectReview(new DOMException("Review superseded", "AbortError")));
      };
      const onNotification = (message: RpcMessage) => {
        if (message.params?.threadId !== threadId) return;
        if (message.method === "item/completed") {
          const item = message.params.item as
            | { type?: string; review?: string }
            | undefined;
          if (item?.type === "exitedReviewMode") {
            finalReview = item.review ?? "";
          }
        }
        if (message.method === "turn/completed") {
          const turn = message.params.turn as CompletedTurn | undefined;
          if (!turn || (turnId && turn.id !== turnId)) return;
          if (turn.status === "completed" && finalReview !== null) {
            finish(() => resolveReview(finalReview as string));
            return;
          }
          if (turn.status === "interrupted") {
            finish(() =>
              rejectReview(new DOMException("Review superseded", "AbortError")),
            );
            return;
          }
          const messageText = turn.error?.message ?? "Codex review failed.";
          finish(() => rejectReview(new CodexClientError(messageText)));
        }
      };

      this.on("notification", onNotification);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      void this.request<ReviewResponse>("review/start", {
        threadId,
        delivery: "inline",
        target: { type: "uncommittedChanges" },
      })
        .then((response) => {
          turnId = response.turn.id;
          if (signal.aborted) void interrupt();
        })
        .catch((error: Error) => finish(() => rejectReview(error)));
    });
  }

  private request<T = unknown>(
    method: string,
    params: JsonObject,
    timeoutMs = 30_000,
  ): Promise<T> {
    const child = this.process;
    if (!child?.stdin.writable) {
      return Promise.reject(new CodexClientError("Codex app-server is not running."));
    }
    const id = ++this.requestId;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new CodexClientError(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timeout,
      });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: JsonObject) {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(id: RequestId, result: unknown) {
    this.process?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: RequestId, message: string) {
    this.process?.stdin.write(
      `${JSON.stringify({ id, error: { code: -32601, message } })}\n`,
    );
  }

  private handleLine(line: string) {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit("diagnostic", `Ignored malformed app-server message: ${line}`);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new CodexClientError(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  private handleServerRequest(message: RpcMessage) {
    const id = message.id as number;
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      this.respond(id, { decision: "decline" });
      return;
    }
    if (
      message.method === "applyPatchApproval" ||
      message.method === "execCommandApproval"
    ) {
      this.respond(id, {
        decision: { denied: { rejection: "A-Spec is read-only." } },
      });
      return;
    }
    this.respondError(
      id,
      "A-Spec does not support interactive or write-capable requests.",
    );
  }

  private handleExit(error: Error) {
    this.process = null;
    this.rejectPending(error);
    this.emit("exit", error);
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}
