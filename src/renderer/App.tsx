import { useEffect, useMemo, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEFAULT_CADENCE_MS,
  MAX_CADENCE_MS,
  MAX_QUESTION_LENGTH,
  MIN_CADENCE_MS,
  CADENCE_STEP_MS,
  type ReviewerState,
  type ReviewerStatus,
  type TimelineEntry,
} from "../shared/types";

const CADENCE_STORAGE_KEY = "a-spec:cadence-ms";

const initialState: ReviewerState = {
  repository: null,
  currentSnapshot: null,
  cadenceMs: DEFAULT_CADENCE_MS,
  status: { type: "selecting" },
  entries: [],
};

function formatClock(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 7);
}

function StatusCard({ status }: { status: ReviewerStatus }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status.type !== "waiting") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [status.type]);

  let detail: string | null = null;
  if (status.type === "waiting") {
    const remaining = Math.max(0, new Date(status.reviewAt).getTime() - now);
    detail = `${(remaining / 1_000).toFixed(1)}s`;
  }
  if (status.type === "reviewing" || status.type === "answering") {
    detail = `${status.snapshot.fileCount} file${status.snapshot.fileCount === 1 ? "" : "s"}`;
  }

  const message =
    status.type === "selecting" ? "Choose a repository to begin." : status.message;

  return (
    <section className={`status-card status-${status.type}`} aria-live="polite">
      <span className="status-orbit" aria-hidden="true"><span /></span>
      <div className="status-copy">
        <strong>{message}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </section>
  );
}

function MarkdownReview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: () => null,
          a: ({ children }) => <span className="safe-link">{children}</span>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function TimelineCard({ entry, sequence }: { entry: TimelineEntry; sequence: number }) {
  const visibleFiles = entry.snapshot.files.slice(0, 4);
  const hiddenCount = entry.snapshot.files.length - visibleFiles.length;
  const label = entry.kind === "answer" ? "ANSWER" : "REVIEW";
  return (
    <article className={`review-card entry-${entry.kind}`}>
      <header className="review-header">
        <div>
          <span className="review-number">{label} {String(sequence).padStart(2, "0")}</span>
          <h2>{formatClock(entry.completedAt)}</h2>
        </div>
        <div className="diff-stat" aria-label="Diff statistics">
          <span className="additions">+{entry.snapshot.additions}</span>
          <span className="deletions">−{entry.snapshot.deletions}</span>
        </div>
      </header>
      <div className="snapshot-line">
        <span>{entry.snapshot.branch}</span>
        <span className="snapshot-dot">·</span>
        <code>{entry.snapshot.head}</code>
        <span className="snapshot-dot">·</span>
        <span>{shortId(entry.snapshot.id)}</span>
      </div>
      <div className="file-list" aria-label="Changed files">
        {visibleFiles.map((file) => (
          <span className="file-pill" key={`${file.status}:${file.path}`}>
            <b>{file.status.slice(0, 2)}</b>{file.path}
          </span>
        ))}
        {hiddenCount > 0 && <span className="file-pill more">+{hiddenCount} more</span>}
      </div>
      {entry.kind === "answer" && (
        <div className="question-copy">
          <span>QUESTION</span>
          <p>{entry.question}</p>
        </div>
      )}
      <MarkdownReview markdown={entry.markdown} />
    </article>
  );
}

export function App() {
  const [state, setState] = useState(initialState);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [questionError, setQuestionError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.reviewer.subscribeReviewerState(setState);
    const stored = Number.parseInt(localStorage.getItem(CADENCE_STORAGE_KEY) ?? "", 10);
    if (Number.isFinite(stored)) void window.reviewer.setCadenceMs(stored);
    return unsubscribe;
  }, []);

  const cadenceLabel = useMemo(
    () => `${(state.cadenceMs / 1_000).toFixed(1)}s quiet`,
    [state.cadenceMs],
  );
  const newestEntries = useMemo(
    () =>
      [...state.entries].sort(
        (left, right) =>
          new Date(right.completedAt).getTime() -
          new Date(left.completedAt).getTime(),
      ),
    [state.entries],
  );

  async function chooseRepository(change = false) {
    setSelectionError(null);
    const result = change
      ? await window.reviewer.changeRepository()
      : await window.reviewer.selectRepository();
    if (!result.ok && !result.cancelled) {
      setSelectionError(result.message ?? "That directory is not a Git worktree.");
    }
  }

  async function signIn() {
    setLoginError(null);
    const result = await window.reviewer.startLogin();
    if (!result.ok) setLoginError(result.message);
  }

  async function updateCadence(value: number) {
    const cadence = await window.reviewer.setCadenceMs(value);
    localStorage.setItem(CADENCE_STORAGE_KEY, String(cadence));
  }

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuestionError(null);
    const result = await window.reviewer.askQuestion(question);
    if (result.ok) {
      setQuestion("");
    } else {
      setQuestionError(result.message);
    }
  }

  if (!state.repository) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-card">
          <div className="brand-mark" aria-hidden="true"><span>A</span></div>
          <p className="eyebrow">READ-ONLY CODE REVIEW</p>
          <h1>Choose what<br />Codex watches.</h1>
          <p className="lede">
            A-Spec observes one Git worktree and quietly reviews each stable set of local changes.
          </p>
          <button className="primary-button" onClick={() => void chooseRepository()}>
            Choose directory <span aria-hidden="true">↗</span>
          </button>
          {selectionError && <p className="inline-error" role="alert">{selectionError}</p>}
          <p className="privacy-note"><span>●</span> Codex cannot modify the selected repository.</p>
        </section>
      </main>
    );
  }

  const authStatus =
    state.status.type === "auth-required" ? state.status : null;
  const isAuthRequired = authStatus !== null;
  const questionBusy =
    state.status.type === "reviewing" || state.status.type === "answering";
  const canAsk = Boolean(
    state.currentSnapshot &&
      !isAuthRequired &&
      !questionBusy &&
      state.status.type !== "connecting" &&
      state.status.type !== "error",
  );
  const questionHint = !state.currentSnapshot
    ? "Make a local change to ask about its place in the codebase."
    : isAuthRequired
      ? "Sign in to ask Codex about this snapshot."
      : questionBusy
        ? "Codex is already working on this snapshot."
        : "Codex can inspect the current diff and surrounding repository files, but cannot modify them.";
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="wordmark"><span className="mini-mark">A</span>A-SPEC</div>
        <div className="read-only-badge"><span /> READ ONLY</div>
      </header>

      <main className="workspace">
        <section className="repo-header">
          <div className="repo-identity">
            <p className="eyebrow">WATCHING WORKTREE</p>
            <h1>{state.repository.name}</h1>
            <p className="repo-path" title={state.repository.root}>{state.repository.root}</p>
            <div className="repo-meta">
              <span className="branch-icon">⑂</span>{state.repository.branch}
              <code>{state.repository.head}</code>
            </div>
          </div>
          <button className="ghost-button" onClick={() => void chooseRepository(true)}>
            Change directory
          </button>
        </section>

        <section className="cadence-panel">
          <div className="cadence-heading">
            <div>
              <label htmlFor="cadence">Review cadence</label>
              <p>Wait for edits to settle before Codex reads the diff.</p>
            </div>
            <output htmlFor="cadence">{cadenceLabel}</output>
          </div>
          <input
            id="cadence"
            type="range"
            min={MIN_CADENCE_MS}
            max={MAX_CADENCE_MS}
            step={CADENCE_STEP_MS}
            value={state.cadenceMs}
            onChange={(event) => void updateCadence(Number(event.target.value))}
          />
          <div className="range-labels"><span>Immediate</span><span>Calm</span></div>
        </section>

        {selectionError && <p className="inline-error" role="alert">{selectionError}</p>}
        <StatusCard status={state.status} />

        {isAuthRequired && (
          <section className="auth-panel">
            <div>
              <h2>Connect your local Codex account</h2>
              <p>A-Spec reuses the same secure login as Codex CLI. No API key is stored here.</p>
            </div>
            <button
              className="primary-button compact"
              disabled={authStatus?.loginPending}
              onClick={() => void signIn()}
            >
              {authStatus?.loginPending ? "Waiting for browser…" : "Sign in with ChatGPT"}
            </button>
            {loginError && <p className="inline-error" role="alert">{loginError}</p>}
          </section>
        )}

        <section className="question-panel">
          <div className="question-heading">
            <div>
              <p className="eyebrow">ASK THIS CHANGESET</p>
              <h2>Question the diff in context.</h2>
            </div>
            {state.currentSnapshot && (
              <code>{shortId(state.currentSnapshot.id)}</code>
            )}
          </div>
          <form onSubmit={(event) => void askQuestion(event)}>
            <label className="sr-only" htmlFor="changeset-question">
              Question about the current changes
            </label>
            <textarea
              id="changeset-question"
              value={question}
              maxLength={MAX_QUESTION_LENGTH}
              rows={3}
              disabled={!canAsk}
              aria-describedby="question-hint"
              placeholder="What do these changes do, and how do they fit into the existing design?"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="question-actions">
              <p id="question-hint">{questionHint}</p>
              <div>
                <span>{question.length}/{MAX_QUESTION_LENGTH}</span>
                <button
                  className="primary-button compact"
                  type="submit"
                  disabled={!canAsk || question.trim().length === 0}
                >
                  {state.status.type === "answering" ? "Answering…" : "Ask Codex"}
                </button>
              </div>
            </div>
          </form>
          {questionError && <p className="inline-error" role="alert">{questionError}</p>}
        </section>

        <section className="timeline" aria-label="Review timeline">
          {state.entries.length > 0 && (
            <div className="timeline-heading">
              <p className="eyebrow">SESSION TIMELINE</p>
              <span>{state.entries.length} completed</span>
            </div>
          )}
          {newestEntries.map((entry, index) => (
            <TimelineCard
              key={entry.id}
              entry={entry}
              sequence={state.entries.length - index}
            />
          ))}
          {state.entries.length === 0 && !isAuthRequired && (
            <div className="empty-timeline">
              <div className="empty-glyph">⌁</div>
              <p>Completed reviews and answers will collect here for this session.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
