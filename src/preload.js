'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the renderer — no raw ipcRenderer.
contextBridge.exposeInMainWorld('companion', {
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  getState: () => ipcRenderer.invoke('get-state'),
  setOpponent: (name) => ipcRenderer.invoke('set-opponent', name),
  setAutoImport: (on) => ipcRenderer.invoke('set-auto-import', on),
  setFlashSide: (flashOnRight) => ipcRenderer.invoke('set-flash-side', flashOnRight),
  setRole: (role) => ipcRenderer.invoke('set-role', role),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  getDataInfo: () => ipcRenderer.invoke('get-data-info'),
  getChampions: () => ipcRenderer.invoke('get-champions'),
  updateData: () => ipcRenderer.invoke('update-data'),
  importNow: (what) => ipcRenderer.invoke('import', what), // 'runes' | 'spells' | 'items' | 'all'
});
