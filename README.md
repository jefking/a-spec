# A-Spec

A-Spec is a compact, read-only local code reviewer for Debian. Choose a Git worktree and it watches staged, unstaged, and non-ignored untracked changes. After the configurable quiet period, it asks Codex for feedback and appends the result to an in-memory Markdown timeline. You can also ask a one-shot question about the current changeset in the context of the surrounding codebase.

Questions do not create a persistent chat or reply flow. Codex runs with `approvalPolicy: "never"`, a read-only sandbox, disabled web search and connectors, and an ephemeral thread for every review or answer.

## Run locally

Requirements: Debian/Linux x86-64, Git, Node.js 22 or newer, internet access, and a Codex/ChatGPT account.

```bash
npm install
npm run dev
```

The app reuses the standard local Codex login cache. If it cannot find an authenticated account after a directory is chosen, it offers the official browser sign-in flow.

## Local checks

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run build` only compiles local development output into `dist/`; it does not create an installer or application package.

## Read-only boundary

- Repository discovery and snapshotting use fixed Git argument arrays with `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff`, and `--no-textconv` where applicable.
- The Electron renderer is sandboxed and receives only a narrow preload API for directory selection, cadence, sign-in, and state updates.
- App-server approvals are disabled; unexpected command, file, permission, MCP, and user-input requests are declined.
- Review threads are ephemeral. Repository paths, diffs, source snippets, and review history are not persisted by A-Spec.
- Raw review HTML and remote Markdown images are not rendered.

See the [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [authentication documentation](https://learn.chatgpt.com/docs/auth) for the underlying integration.
