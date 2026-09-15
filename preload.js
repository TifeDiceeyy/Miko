const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepLiveCam", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  logEvent: (level, message) => ipcRenderer.send("app:log", level, message),
  onSystemSuspend: (callback) => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on("app:system-suspend", listener);
    return () => ipcRenderer.removeListener("app:system-suspend", listener);
  },
  getCameraAccess: () => ipcRenderer.invoke("media:camera-access"),
  checkConnection: (supplier) => ipcRenderer.invoke("net:check", supplier),
  openCameraSettings: () => ipcRenderer.invoke("media:open-camera-settings"),
  openLogsFolder: () => ipcRenderer.invoke("log:open-folder"),
  pickMedia: (kind) => ipcRenderer.invoke("dialog:pick-media", kind),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  windowControl: (action) => ipcRenderer.invoke("window:control", action),
  getKeyStatus: () => ipcRenderer.invoke("fal:get-key-status"),
  getBalance: () => ipcRenderer.invoke("fal:get-balance"),
  saveKey: (key) => ipcRenderer.invoke("fal:save-key", key),
  getToken: (app) => ipcRenderer.invoke("fal:get-token", app),
  deleteRequestPayload: (requestId) => ipcRenderer.invoke("fal:delete-request-payload", requestId),
  decartKeyStatus: () => ipcRenderer.invoke("decart:get-key-status"),
  decartSaveKey: (key) => ipcRenderer.invoke("decart:save-key", key),
  decartToken: (model) => ipcRenderer.invoke("decart:get-token", model),
  decartQuota: () => ipcRenderer.invoke("decart:get-quota"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  obsRevealFile: () => ipcRenderer.invoke("obs:reveal-file"),
  setObsEnabled: (enabled) => ipcRenderer.invoke("settings:set-obs-enabled", enabled),
  obsStart: () => ipcRenderer.invoke("obs:start"),
  obsStop: () => ipcRenderer.invoke("obs:stop"),
  obsStatus: () => ipcRenderer.invoke("obs:status"),
  obsSendFrame: (buffer) => ipcRenderer.send("obs:frame", buffer),
  obsClearFrame: () => ipcRenderer.send("obs:clear-frame")
});
