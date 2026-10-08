export const MIN_CADENCE_MS = 500;
export const MAX_CADENCE_MS = 10_000;
export const DEFAULT_CADENCE_MS = 2_000;
export const CADENCE_STEP_MS = 500;
export const MAX_QUESTION_LENGTH = 2_000;

export type ChangedFile = {
  path: string;
  status: string;
};

export type RepositoryInfo = {
  root: string;
  name: string;
  branch: string;
  head: string;
};

export type SnapshotSummary = {
  id: string;
  branch: string;
  head: string;
  files: ChangedFile[];
  fileCount: number;
  additions: number;
  deletions: number;
  capturedAt: string;
};

export type ReviewEntry = {
  id: string;
  kind: "review";
  snapshot: SnapshotSummary;
  startedAt: string;
  completedAt: string;
  markdown: string;
};

export type QuestionEntry = {
  id: string;
  kind: "answer";
  question: string;
  snapshot: SnapshotSummary;
  startedAt: string;
  completedAt: string;
  markdown: string;
};

export type TimelineEntry = ReviewEntry | QuestionEntry;

export type ReviewerStatus =
  | { type: "selecting" }
  | { type: "connecting"; message: string }
  | { type: "auth-required"; message: string; loginPending: boolean }
  | { type: "clean"; message: string }
  | { type: "watching"; message: string }
  | { type: "waiting"; message: string; reviewAt: string }
  | { type: "reviewing"; message: string; snapshot: SnapshotSummary }
  | { type: "answering"; message: string; snapshot: SnapshotSummary }
  | { type: "error"; message: string; recoverable: boolean };

export type ReviewerState = {
  repository: RepositoryInfo | null;
  currentSnapshot: SnapshotSummary | null;
  cadenceMs: number;
  status: ReviewerStatus;
  entries: TimelineEntry[];
};

export type SelectRepositoryResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; message?: string };

export type StartLoginResult =
  | { ok: true }
  | { ok: false; message: string };

export type AskQuestionResult =
  | { ok: true }
  | { ok: false; message: string };

export type ReviewerApi = {
  selectRepository: () => Promise<SelectRepositoryResult>;
  changeRepository: () => Promise<SelectRepositoryResult>;
  setCadenceMs: (milliseconds: number) => Promise<number>;
  startLogin: () => Promise<StartLoginResult>;
  askQuestion: (question: string) => Promise<AskQuestionResult>;
  subscribeReviewerState: (
    listener: (state: ReviewerState) => void,
  ) => () => void;
};

declare global {
  interface Window {
    reviewer: ReviewerApi;
  }
}
