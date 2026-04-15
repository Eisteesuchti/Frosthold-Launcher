const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fh', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  close: () => ipcRenderer.invoke('window-close'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  loadNewsJson: () => ipcRenderer.invoke('load-news-json'),
  skyrimStatus: () => ipcRenderer.invoke('skyrim-status'),
  setup: () => ipcRenderer.invoke('setup'),
  play: () => ipcRenderer.invoke('play'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
