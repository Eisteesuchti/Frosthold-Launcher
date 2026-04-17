const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fh', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  close: () => ipcRenderer.invoke('window-close'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  loadNewsJson: () => ipcRenderer.invoke('load-news-json'),
  serverStatusPing: () => ipcRenderer.invoke('server-status-ping'),
  skyrimStatus: () => ipcRenderer.invoke('skyrim-status'),
  setup: () => ipcRenderer.invoke('setup'),
  forceClientRefresh: () => ipcRenderer.invoke('force-client-refresh'),
  checkLauncherUpdates: () => ipcRenderer.invoke('check-launcher-updates'),
  play: () => ipcRenderer.invoke('play'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  quickHealthCheck: () => ipcRenderer.invoke('quick-health-check'),
  appMeta: () => ipcRenderer.invoke('app-meta'),
  createDesktopShortcut: () => ipcRenderer.invoke('create-desktop-shortcut'),
  discordLogin: () => ipcRenderer.invoke('discord-login'),
  discordLogout: () => ipcRenderer.invoke('discord-logout'),
  discordSession: () => ipcRenderer.invoke('discord-session'),

  /**
   * Abo fuer Live-Install-Progress-Events vom Python-Backend.
   * @param {(evt: { event: 'progress' | 'status', phase: string, label?: string,
   *                 message?: string, percent?: number|null,
   *                 bytesDone?: number, bytesTotal?: number }) => void} cb
   * @returns {() => void} Unsubscribe-Funktion.
   */
  onInstallProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, data) => {
      try { cb(data); } catch (_) {}
    };
    ipcRenderer.on('install-progress', handler);
    return () => ipcRenderer.removeListener('install-progress', handler);
  },
});
