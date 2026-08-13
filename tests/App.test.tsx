import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import type { ReviewerApi, ReviewerState } from "../src/shared/types";

function installReviewer(state: ReviewerState) {
  const api: ReviewerApi = {
    selectRepository: vi.fn(async () => ({ ok: false, cancelled: true })),
    changeRepository: vi.fn(async () => ({ ok: false, cancelled: true })),
    setCadenceMs: vi.fn(async (milliseconds) => milliseconds),
    startLogin: vi.fn(async () => ({ ok: true as const })),
    subscribeReviewerState: vi.fn((listener) => {
      listener(state);
      return () => undefined;
    }),
  };
  window.reviewer = api;
  return api;
}

beforeEach(() => localStorage.clear());

describe("A-Spec renderer", () => {
  it("starts with directory selection and no chat controls", () => {
    installReviewer({
      repository: null,
      cadenceMs: 2_000,
      status: { type: "selecting" },
      entries: [],
    });
    render(<App />);
    expect(screen.getByRole("button", { name: /choose directory/i })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders review Markdown but not raw HTML or remote images", async () => {
    installReviewer({
      repository: {
        root: "/work/example",
        name: "example",
        branch: "main",
        head: "abc123",
      },
      cadenceMs: 2_000,
      status: { type: "watching", message: "Watching" },
      entries: [
        {
          id: "review-1",
          startedAt: "2026-01-01T12:00:00.000Z",
          completedAt: "2026-01-01T12:00:01.000Z",
          markdown:
            "## Finding\n\n`safe()` needs a guard.\n\n<img src=x onerror=alert(1)>\n\n![remote](https://example.com/x.png)",
          snapshot: {
            id: "0123456789",
            branch: "main",
            head: "abc123",
            files: [{ path: "src/example.ts", status: ".M" }],
            fileCount: 1,
            additions: 2,
            deletions: 1,
            capturedAt: "2026-01-01T12:00:00.000Z",
          },
        },
      ],
    });
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Finding" })).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^review$/i })).not.toBeInTheDocument();
  });

  it("persists only the cadence preference", async () => {
    const api = installReviewer({
      repository: null,
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
