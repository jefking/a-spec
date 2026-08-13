import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import {
  CodexAppServer,
  CodexClientError,
  type AccountState,
} from "./codex-client";
import {
  captureSnapshot,
  GitError,
  resolveGitDirectory,
  resolveRepository,
} from "./git";
import {
  DEFAULT_CADENCE_MS,
  MAX_CADENCE_MS,
  MIN_CADENCE_MS,
  CADENCE_STEP_MS,
  type RepositoryInfo,
  type ReviewerState,
  type SnapshotSummary,
} from "../shared/types";

type AppServerNotification = {
  method?: string;
  params?: Record<string, unknown>;
};

export class ReviewController extends EventEmitter {
  private state: ReviewerState = {
    repository: null,
    cadenceMs: DEFAULT_CADENCE_MS,
    status: { type: "selecting" },
    entries: [],
  };
  private codex: CodexAppServer | null = null;
  private account: AccountState | null = null;
  private codexReady = false;
  private worktreeWatcher: FSWatcher | null = null;
  private gitWatcher: FSWatcher | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private reviewTimer: NodeJS.Timeout | null = null;
  private pendingSnapshot: SnapshotSummary | null = null;
  private activeReview: AbortController | null = null;
  private lastObservedSnapshotId: string | null = null;
  private generation = 0;
  private restartAttempts = 0;
  private restarting = false;

  getState(): ReviewerState {
    return structuredClone(this.state);
  }

  async openRepository(selectedPath: string): Promise<void> {
    const repository = await resolveRepository(selectedPath);
    await this.resetRepositorySession();
    const generation = ++this.generation;
    this.state = {
      repository,
      cadenceMs: this.state.cadenceMs,
      status: { type: "connecting", message: "Connecting to Codex…" },
      entries: [],
    };
    this.emitState();

    await this.startWatchers(repository);
    const [snapshotResult, codexResult] = await Promise.allSettled([
      captureSnapshot(repository.root),
      this.connectCodex(generation),
    ]);
    if (generation !== this.generation) return;

    if (snapshotResult.status === "fulfilled") {
      this.pendingSnapshot = snapshotResult.value;
      this.lastObservedSnapshotId = snapshotResult.value?.id ?? null;
      this.updateRepositoryRevision(snapshotResult.value);
    } else {
      this.setFailure(snapshotResult.reason);
      return;
    }

    if (codexResult.status === "rejected") {
      this.setFailure(codexResult.reason);
      return;
    }
    this.advanceAfterConnection(true);
  }

  setCadence(milliseconds: number): number {
    const bounded = Math.min(
      MAX_CADENCE_MS,
      Math.max(MIN_CADENCE_MS, milliseconds),
    );
    const cadence =
      Math.round(bounded / CADENCE_STEP_MS) * CADENCE_STEP_MS;
    this.state.cadenceMs = cadence;
    if (this.reviewTimer && this.pendingSnapshot) {
      this.scheduleReview(this.pendingSnapshot, false);
    } else {
      this.emitState();
    }
    return cadence;
  }

  async startLogin(): Promise<string> {
    if (!this.codex) throw new CodexClientError("Codex is not connected.");
    const login = await this.codex.startChatGptLogin();
    if (login.type !== "chatgpt" || !("authUrl" in login)) {
      throw new CodexClientError("Codex did not return a ChatGPT sign-in URL.");
    }
    this.state.status = {
      type: "auth-required",
      message: "Finish signing in in your browser.",
      loginPending: true,
    };
    this.emitState();
    return login.authUrl;
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    await this.resetRepositorySession();
    if (this.codex) {
      const client = this.codex;
      this.codex = null;
      await client.stop();
    }
  }

  private async connectCodex(generation: number): Promise<void> {
    if (!this.codex) {
      const client = new CodexAppServer();
      client.on("notification", (message: AppServerNotification) => {
        if (message.method === "account/login/completed") {
          void this.handleLoginCompleted(message.params);
        }
      });
      client.on("exit", (error: Error) => this.handleCodexExit(error));
      this.codex = client;
      await client.start();
      this.restartAttempts = 0;
    }
    if (generation !== this.generation || !this.codex) return;
    this.account = await this.codex.readAccount();
    this.codexReady = Boolean(
      this.account.account || !this.account.requiresOpenaiAuth,
    );
  }

  private advanceAfterConnection(initial: boolean) {
    if (!this.account?.account && this.account?.requiresOpenaiAuth) {
      this.state.status = {
        type: "auth-required",
        message: "Sign in with ChatGPT to start reviewing.",
        loginPending: false,
      };
      this.emitState();
      return;
    }
    if (!this.pendingSnapshot) {
      this.state.status = {
        type: "clean",
        message: "Working tree clean — watching.",
      };
      this.emitState();
      return;
    }
    this.scheduleReview(this.pendingSnapshot, initial);
  }

  private async handleLoginCompleted(params?: Record<string, unknown>) {
    if (!this.state.repository || !this.codex) return;
    if (params?.success !== true) {
      this.state.status = {
        type: "auth-required",
        message:
          typeof params?.error === "string" ? params.error : "Sign-in failed.",
        loginPending: false,
      };
      this.emitState();
      return;
    }
    try {
      this.account = await this.codex.readAccount();
      this.codexReady = Boolean(
        this.account.account || !this.account.requiresOpenaiAuth,
      );
      this.advanceAfterConnection(true);
    } catch (error) {
      this.setFailure(error);
    }
  }

  private async startWatchers(repository: RepositoryInfo) {
    const gitDirectory = await resolveGitDirectory(repository.root);
    const insideRoot =
      gitDirectory === repository.root ||
      gitDirectory.startsWith(`${repository.root}${sep}`);

    this.worktreeWatcher = watch(repository.root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      ignored: (path) =>
        insideRoot &&
        (path === gitDirectory || path.startsWith(`${gitDirectory}${sep}`)),
    });
    this.worktreeWatcher.on("all", () => this.queueSnapshotRefresh());
    this.worktreeWatcher.on("error", (error) => this.setFailure(error));

    this.gitWatcher = watch(
      [join(gitDirectory, "index"), join(gitDirectory, "HEAD"), join(gitDirectory, "refs")],
      { ignoreInitial: true },
    );
    this.gitWatcher.on("all", () => this.queueSnapshotRefresh());
    this.gitWatcher.on("error", (error) => this.setFailure(error));
  }

  private queueSnapshotRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const generation = this.generation;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSnapshot(generation);
    }, 120);
  }

  private async refreshSnapshot(generation: number) {
    const repository = this.state.repository;
    if (!repository || generation !== this.generation) return;
    try {
      const snapshot = await captureSnapshot(repository.root);
      if (generation !== this.generation) return;
      this.updateRepositoryRevision(snapshot);
      const snapshotId = snapshot?.id ?? null;
      if (snapshotId === this.lastObservedSnapshotId) return;
      this.lastObservedSnapshotId = snapshotId;
      this.pendingSnapshot = snapshot;
      this.cancelPendingReview();
      this.activeReview?.abort();
      this.activeReview = null;

      if (!snapshot) {
        this.state.status = {
          type: "clean",
          message: "Working tree clean — watching.",
        };
        this.emitState();
        return;
      }
      if (!this.codexReady) {
        if (this.account?.requiresOpenaiAuth && !this.account.account) {
          this.state.status = {
            type: "auth-required",
            message: "Sign in with ChatGPT to review the latest changes.",
            loginPending: false,
          };
        } else {
          this.state.status = {
            type: "connecting",
            message: "Waiting for Codex…",
          };
        }
        this.emitState();
        return;
      }
      this.scheduleReview(snapshot, false);
    } catch (error) {
      if (generation === this.generation) this.setFailure(error);
    }
  }

  private scheduleReview(snapshot: SnapshotSummary, immediate: boolean) {
    this.cancelPendingReview();
    this.pendingSnapshot = snapshot;
    const delay = immediate ? 0 : this.state.cadenceMs;
    const reviewAt = new Date(Date.now() + delay).toISOString();
    this.state.status = {
      type: "waiting",
      message: immediate ? "Starting review…" : "Changes detected — waiting for quiet.",
      reviewAt,
    };
    this.emitState();
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = null;
      void this.runReview(snapshot, this.generation);
    }, delay);
  }

  private async runReview(snapshot: SnapshotSummary, generation: number) {
    const repository = this.state.repository;
    const codex = this.codex;
    if (!repository || !this.codexReady || !codex) return;

    try {
      const latestBeforeStart = await captureSnapshot(repository.root);
      if (
        generation !== this.generation ||
        !latestBeforeStart ||
        latestBeforeStart.id !== snapshot.id
      ) {
        if (generation === this.generation) {
          this.pendingSnapshot = latestBeforeStart;
          this.lastObservedSnapshotId = latestBeforeStart?.id ?? null;
          if (latestBeforeStart) this.scheduleReview(latestBeforeStart, false);
        }
        return;
      }

      const abortController = new AbortController();
      this.activeReview = abortController;
      const startedAt = new Date().toISOString();
      this.state.status = {
        type: "reviewing",
        message: "Codex is reviewing the current snapshot…",
        snapshot,
      };
      this.emitState();
      const markdown = await codex.reviewUncommittedChanges(
        repository.root,
        abortController.signal,
      );
      if (generation !== this.generation || abortController.signal.aborted) return;

      const latestAfterReview = await captureSnapshot(repository.root);
      if (!latestAfterReview || latestAfterReview.id !== snapshot.id) {
        this.pendingSnapshot = latestAfterReview;
        this.lastObservedSnapshotId = latestAfterReview?.id ?? null;
        if (latestAfterReview) this.scheduleReview(latestAfterReview, false);
        return;
      }

      this.state.entries.push({
        id: randomUUID(),
        snapshot,
        startedAt,
        completedAt: new Date().toISOString(),
        markdown,
      });
      this.pendingSnapshot = snapshot;
      this.state.status = {
        type: "watching",
        message: "Review complete — watching for changes.",
      };
      this.emitState();
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      if (generation === this.generation) this.setFailure(error);
    } finally {
      if (generation === this.generation) this.activeReview = null;
    }
  }

  private updateRepositoryRevision(snapshot: SnapshotSummary | null) {
    if (!snapshot || !this.state.repository) return;
    this.state.repository = {
      ...this.state.repository,
      branch: snapshot.branch,
      head: snapshot.head,
    };
  }

  private handleCodexExit(error: Error) {
    if (!this.state.repository || this.restarting) return;
    this.codexReady = false;
    this.activeReview?.abort();
    this.activeReview = null;
    this.state.status = { type: "error", message: error.message, recoverable: true };
    this.emitState();
    if (this.restartAttempts >= 3) return;
    this.restartAttempts += 1;
    this.restarting = true;
    const generation = this.generation;
    setTimeout(() => {
      void this.restartCodex(generation);
    }, Math.min(4_000, 500 * 2 ** this.restartAttempts));
  }

  private async restartCodex(generation: number) {
    this.restarting = false;
    if (!this.state.repository || generation !== this.generation) return;
    this.codex = null;
    this.state.status = { type: "connecting", message: "Reconnecting to Codex…" };
    this.emitState();
    try {
      await this.connectCodex(generation);
      if (generation === this.generation) this.advanceAfterConnection(false);
    } catch (error) {
      if (generation === this.generation) this.handleCodexExit(error as Error);
    }
  }

  private setFailure(error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    let message = failure.message;
    if (failure instanceof GitError) message = `Git: ${message}`;
    if (/rate.?limit|usage limit/i.test(message)) {
      message = `Codex usage limit: ${message}`;
    } else if (/unauthorized|authentication|sign.?in/i.test(message)) {
      message = `Codex authentication: ${message}`;
    } else if (/sandbox/i.test(message)) {
      message = `Codex sandbox: ${message}`;
    }
    this.state.status = { type: "error", message, recoverable: true };
    this.emitState();
  }

  private cancelPendingReview() {
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = null;
  }

  private async resetRepositorySession() {
    this.cancelPendingReview();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.activeReview?.abort();
    this.activeReview = null;
    this.pendingSnapshot = null;
    this.lastObservedSnapshotId = null;
    this.codexReady = false;
    await Promise.all([
      this.worktreeWatcher?.close(),
      this.gitWatcher?.close(),
    ]);
    this.worktreeWatcher = null;
    this.gitWatcher = null;
  }

  private emitState() {
    this.emit("state", this.getState());
  }
}
