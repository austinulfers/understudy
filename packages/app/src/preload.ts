import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("understudy", {
  // onboarding
  prefill: () => ipcRenderer.invoke("prefill"),
  pickFolders: () => ipcRenderer.invoke("pick-folders"),
  enroll: (payload: { broker: string; token: string; roots: string[] }) =>
    ipcRenderer.invoke("enroll", payload),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  closeWindow: () => ipcRenderer.invoke("close-onboarding"),
  onPrefill: (cb: (data: unknown) => void) =>
    ipcRenderer.on("prefill", (_event, data) => cb(data)),
  // owner panel (people / conversations / budget)
  panelOverview: () => ipcRenderer.invoke("panel-overview"),
  panelSearchUsers: (query: string) => ipcRenderer.invoke("panel-search-users", query),
  panelAcl: (action: "add" | "remove", slackUserId: string) =>
    ipcRenderer.invoke("panel-acl", { action, slackUserId }),
  panelLimit: (dailyLimit: number | null) => ipcRenderer.invoke("panel-limit", dailyLimit),
  panelPeers: (acceptPeerAsks: boolean) => ipcRenderer.invoke("panel-peers", acceptPeerAsks),
  panelTranscript: (threadKey: string) => ipcRenderer.invoke("panel-transcript", threadKey),
});
