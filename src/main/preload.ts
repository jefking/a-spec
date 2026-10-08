import { contextBridge, ipcRenderer } from "electron";
import type {
  AskQuestionResult,
  ReviewerApi,
  ReviewerState,
  SelectRepositoryResult,
  StartLoginResult,
} from "../shared/types";

const api: ReviewerApi = {
  selectRepository: () =>
    ipcRenderer.invoke("reviewer:select-repository") as Promise<SelectRepositoryResult>,
  changeRepository: () =>
    ipcRenderer.invoke("reviewer:change-repository") as Promise<SelectRepositoryResult>,
  setCadenceMs: (milliseconds) =>
    ipcRenderer.invoke("reviewer:set-cadence", milliseconds) as Promise<number>,
  startLogin: () =>
    ipcRenderer.invoke("reviewer:start-login") as Promise<StartLoginResult>,
  askQuestion: (question) =>
    ipcRenderer.invoke(
      "reviewer:ask-question",
      question,
    ) as Promise<AskQuestionResult>,
  subscribeReviewerState: (listener) => {
    let active = true;
    const receive = (_event: Electron.IpcRendererEvent, state: ReviewerState) => {
      if (active) listener(state);
    };
    ipcRenderer.on("reviewer:state", receive);
    void ipcRenderer
      .invoke("reviewer:get-state")
      .then((state: ReviewerState) => active && listener(state));
    return () => {
      active = false;
      ipcRenderer.removeListener("reviewer:state", receive);
    };
  },
};

contextBridge.exposeInMainWorld("reviewer", api);
