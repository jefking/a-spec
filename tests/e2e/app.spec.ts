import { _electron as electron, expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("selects a Git directory and exposes the read-only question composer", async () => {
  const repository = await mkdtemp(join(tmpdir(), "a-spec-e2e-"));
  await execFileAsync("git", ["-C", repository, "init", "-q"]);
  const {
    ELECTRON_RUN_AS_NODE: _runAsNode,
    ELECTRON_NO_ATTACH_CONSOLE: _noAttachConsole,
    ...environment
  } = process.env;
  const application = await electron.launch({
    args: [process.cwd()],
    env: { ...environment, A_SPEC_SKIP_AUTO_SELECT: "1" },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: /choose directory/i })).toBeVisible();
    await application.evaluate(async ({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, repository);
    await page.getByRole("button", { name: /choose directory/i }).click();

    await expect(page.getByText(repository)).toBeVisible();
    await expect(page.getByRole("slider", { name: /review cadence/i })).toBeVisible();
    await expect(page.getByText(/read only/i).first()).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /question about the current changes/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /ask codex/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^review$/i })).toHaveCount(0);
  } finally {
    await application.close();
    await rm(repository, { recursive: true, force: true });
  }
});
