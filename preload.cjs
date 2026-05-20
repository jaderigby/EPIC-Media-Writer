const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("EpicInspector", {
  openMedia: () => ipcRenderer.invoke("open-media"),
  saveMedia: (payload) => ipcRenderer.invoke("save-media", payload),
  saveMetadata: (payload) => ipcRenderer.invoke("save-metadata", payload),
  parseEpic: (payload) => ipcRenderer.invoke("parse-epic", payload),
  saveTextAs: (payload) => ipcRenderer.invoke("save-text-as", payload),
  saveText: (payload) => ipcRenderer.invoke("save-text", payload),
  storeInAudio: (payload) => ipcRenderer.invoke("store-in-audio", payload)
});