'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('korbaj', {
  onCursor: (fn) => ipcRenderer.on('korbaj:cursor', (_e, p) => fn(p)),
  onState: (fn) => ipcRenderer.on('korbaj:state', (_e, s) => fn(s)),
  onWarn: (fn) => ipcRenderer.on('korbaj:warn', (_e, m) => fn(m)),
  loadSound: (name) => ipcRenderer.invoke('korbaj:load-sound', name),
  config: () => ipcRenderer.invoke('korbaj:config'),
});
