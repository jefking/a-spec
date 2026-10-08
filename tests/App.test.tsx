import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import type { ReviewerApi, ReviewerState } from "../src/shared/types";

function installReviewer(state: ReviewerState) {
  const api: ReviewerApi = {
    selectRepository: vi.fn(async () => ({ ok: false, cancelled: true })),
    changeRepository: vi.fn(async () => ({ ok: false, cancelled: true })),
    setCadenceMs: vi.fn(async (milliseconds) => milliseconds),
    startLogin: vi.fn(async () => ({ ok: true as const })),
    askQuestion: vi.fn(async () => ({ ok: true as const })),
    subscribeReviewerState: vi.fn((listener) => {
      listener(state);
      return () => undefined;
    }),
  };
  window.reviewer = api;
  return api;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("A-Spec renderer", () => {
  it("starts with directory selection and no chat controls", () => {
    installReviewer({
      repository: null,
      currentSnapshot: null,
      cadenceMs: 2_000,
      status: { type: "selecting" },
      entries: [],
    });
    render(<App />);
    expect(screen.getByRole("button", { name: /choose directory/i })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders review Markdown safely and exposes changeset questions", async () => {
    const snapshot = {
      id: "0123456789",
      branch: "main",
      head: "abc123",
      files: [{ path: "src/example.ts", status: ".M" }],
      fileCount: 1,
      additions: 2,
      deletions: 1,
      capturedAt: "2026-01-01T12:00:00.000Z",
    };
    installReviewer({
      repository: {
        root: "/work/example",
        name: "example",
        branch: "main",
        head: "abc123",
      },
      currentSnapshot: snapshot,
      cadenceMs: 2_000,
      status: { type: "watching", message: "Watching" },
      entries: [
        {
          id: "review-1",
          kind: "review",
          startedAt: "2026-01-01T12:00:00.000Z",
          completedAt: "2026-01-01T12:00:01.000Z",
          markdown:
            "## Finding\n\n`safe()` needs a guard.\n\n<img src=x onerror=alert(1)>\n\n![remote](https://example.com/x.png)",
          snapshot,
        },
      ],
    });
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Finding" })).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByRole("textbox", { name: /question about the current changes/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /ask codex/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^review$/i })).not.toBeInTheDocument();
  });

  it("shows the latest completed review at the top of the timeline", () => {
    const snapshot = {
      id: "0123456789",
      branch: "main",
      head: "abc123",
      files: [{ path: "src/example.ts", status: ".M" }],
      fileCount: 1,
      additions: 2,
      deletions: 1,
      capturedAt: "2026-01-01T12:00:00.000Z",
    };
    installReviewer({
      repository: {
        root: "/work/example",
        name: "example",
        branch: "main",
        head: "abc123",
      },
      currentSnapshot: snapshot,
      cadenceMs: 2_000,
      status: { type: "watching", message: "Watching" },
      entries: [
        {
          id: "review-1",
          kind: "review",
          startedAt: "2026-01-01T12:00:00.000Z",
          completedAt: "2026-01-01T12:00:01.000Z",
          markdown: "Earlier review",
          snapshot,
        },
        {
          id: "review-2",
          kind: "review",
          startedAt: "2026-01-01T12:01:00.000Z",
          completedAt: "2026-01-01T12:01:01.000Z",
          markdown: "Latest review",
          snapshot,
        },
      ],
    });

    const { container } = render(<App />);

    const cards = container.querySelectorAll("article");
    expect(cards[0]).toHaveTextContent("REVIEW 02");
    expect(cards[0]).toHaveTextContent("Latest review");
    expect(cards[1]).toHaveTextContent("REVIEW 01");
    expect(cards[1]).toHaveTextContent("Earlier review");
  });

  it("submits a question and renders completed answers in the timeline", async () => {
    const snapshot = {
      id: "0123456789",
      branch: "main",
      head: "abc123",
      files: [{ path: "src/example.ts", status: ".M" }],
      fileCount: 1,
      additions: 2,
      deletions: 1,
      capturedAt: "2026-01-01T12:00:00.000Z",
    };
    const api = installReviewer({
      repository: {
        root: "/work/example",
        name: "example",
        branch: "main",
        head: "abc123",
      },
      currentSnapshot: snapshot,
      cadenceMs: 2_000,
      status: { type: "watching", message: "Watching" },
      entries: [
        {
          id: "answer-1",
          kind: "answer",
          question: "Why is this guard needed?",
          startedAt: "2026-01-01T12:00:00.000Z",
          completedAt: "2026-01-01T12:00:01.000Z",
          markdown: "It protects the existing caller in `src/caller.ts`.",
          snapshot,
        },
      ],
    });
    render(<App />);

    expect(screen.getByText("Why is this guard needed?")).toBeVisible();
    expect(screen.getByText(/protects the existing caller/)).toBeVisible();
    const input = screen.getByRole("textbox", {
      name: /question about the current changes/i,
    });
    fireEvent.change(input, { target: { value: "How does this affect callers?" } });
    fireEvent.click(screen.getByRole("button", { name: /ask codex/i }));

    await waitFor(() =>
      expect(api.askQuestion).toHaveBeenCalledWith("How does this affect callers?"),
    );
  });

  it("persists only the cadence preference", async () => {
    const api = installReviewer({
      repository: null,
      currentSnapshot: null,
      cadenceMs: 2_000,
      status: { type: "selecting" },
      entries: [],
    });
    localStorage.setItem("a-spec:cadence-ms", "5000");
    render(<App />);
    await waitFor(() => expect(api.setCadenceMs).toHaveBeenCalledWith(5000));
    expect(localStorage.length).toBe(1);
  });
});
