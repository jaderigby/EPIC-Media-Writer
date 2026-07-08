const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("EpicInspector", {
  openMedia: () => ipcRenderer.invoke("open-media"),
  saveMedia: (payload) => ipcRenderer.invoke("save-media", payload),
  saveMetadata: (payload) => ipcRenderer.invoke("save-metadata", payload),
  parseEpic: (payload) => ipcRenderer.invoke("parse-epic", payload),
  saveTextAs: (payload) => ipcRenderer.invoke("save-text-as", payload),
  saveText: (payload) => ipcRenderer.invoke("save-text", payload),
  storeInAudio: (payload) => ipcRenderer.invoke("store-in-audio", payload),
  addAlbumArt: (payload) => ipcRenderer.invoke("add-album-art", payload),
  updateStudioTimingMenuState: (payload) =>
    ipcRenderer.invoke("studio-timing:update-menu-state", payload),
  getStudioTimingSnapshot: () =>
    ipcRenderer.invoke("studio-timing:get-snapshot"),
  notifyStudioEpicxSaved: (payload) =>
    ipcRenderer.invoke("studio-timing:notify-saved", payload),
  onEditorHistoryAction: (handler) => {
    if (typeof handler !== "function") return;

    ipcRenderer.removeAllListeners("editor-history:action");
    ipcRenderer.on("editor-history:action", (_event, action) => {
      handler(action);
    });
  },
  onStudioTimingMenuAction: (handler) => {
    if (typeof handler !== "function") return;

    ipcRenderer.removeAllListeners("studio-timing:menu-action");
    ipcRenderer.on("studio-timing:menu-action", () => {
      handler();
    });
  }
});
