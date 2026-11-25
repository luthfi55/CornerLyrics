'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('cornerLyrics', {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  refreshLyrics: () => ipcRenderer.send('lyrics:refresh'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onMediaUpdate: (callback) => subscribe('media:update', callback),
  onLyricsUpdate: (callback) => subscribe('lyrics:update', callback),
  onSystemUpdate: (callback) => subscribe('system:update', callback),
});
