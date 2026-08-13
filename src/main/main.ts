import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewController } from "./review-controller";
import type { SelectRepositoryResult, StartLoginResult } from "../shared/types";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const controller = new ReviewController();
let mainWindow: BrowserWindow | null = null;
let quitting = false;

function broadcastState() {
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    window.webContents.send("reviewer:state", controller.getState());
  }
}

async function selectRepository(): Promise<SelectRepositoryResult> {
  if (!mainWindow) {
    return { ok: false, cancelled: false, message: "The application window is unavailable." };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a Git worktree",
    buttonLabel: "Review this repository",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, cancelled: true };
  }
  try {
    await controller.openRepository(result.filePaths[0]);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, cancelled: false, message };
  }
}

function isAllowedAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" ||
        url.hostname.endsWith(".chatgpt.com") ||
        url.hostname === "openai.com" ||
        url.hostname.endsWith(".openai.com"))
    );
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle("reviewer:get-state", () => controller.getState());
  ipcMain.handle("reviewer:select-repository", selectRepository);
  ipcMain.handle("reviewer:change-repository", selectRepository);
  ipcMain.handle("reviewer:set-cadence", (_event, milliseconds: unknown) => {
    if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
      throw new TypeError("Cadence must be a finite number.");
    }
    return controller.setCadence(milliseconds);
  });
  ipcMain.handle("reviewer:start-login", async (): Promise<StartLoginResult> => {
    try {
      const authUrl = await controller.startLogin();
      if (!isAllowedAuthUrl(authUrl)) {
        throw new Error("Codex returned an unexpected sign-in URL.");
      }
      await shell.openExternal(authUrl);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 600,
    minHeight: 520,
    backgroundColor: "#0d0f0e",
    title: "A-Spec",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  controller.on("state", broadcastState);

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"));
  }

  mainWindow.once("closed", () => {
    controller.off("state", broadcastState);
    mainWindow = null;
  });
  if (process.env.A_SPEC_SKIP_AUTO_SELECT !== "1") {
    setTimeout(() => void selectRepository(), 180);
  }
}

registerIpc();

app.whenReady().then(async () => {
  await createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (quitting) return;
  quitting = true;
  void controller.dispose().finally(() => app.quit());
});
