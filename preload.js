const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepLiveCam", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  pickMedia: (kind) => ipcRenderer.invoke("dialog:pick-media", kind),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  windowControl: (action) => ipcRenderer.invoke("window:control", action),
  getKeyStatus: () => ipcRenderer.invoke("fal:get-key-status"),
  getBalance: () => ipcRenderer.invoke("fal:get-balance"),
  saveKey: (key) => ipcRenderer.invoke("fal:save-key", key),
  getToken: (app) => ipcRenderer.invoke("fal:get-token", app),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  obsStart: (port) => ipcRenderer.invoke("obs:start", port),
  obsStop: () => ipcRenderer.invoke("obs:stop"),
  obsStatus: () => ipcRenderer.invoke("obs:status"),
  obsSendFrame: (buffer) => ipcRenderer.send("obs:frame", buffer),
  obsClearFrame: () => ipcRenderer.send("obs:clear-frame")
});
