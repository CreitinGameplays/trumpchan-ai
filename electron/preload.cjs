/**
 * Preload bridge: renderer talks to main-process Playwright Chromium browser.
 * Screenshots stream as browser:paint for the 3D plane texture.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBrowser', {
  isAvailable: () => true,

  navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  goBack: () => ipcRenderer.invoke('browser:back'),
  goForward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),

  click: (payload) => ipcRenderer.invoke('browser:click', payload),
  check: (payload) => ipcRenderer.invoke('browser:check', payload || {}),
  hover: (payload) => ipcRenderer.invoke('browser:hover', payload || {}),
  move: (payload) => ipcRenderer.invoke('browser:move', payload || {}),
  scroll: (payload) => ipcRenderer.invoke('browser:scroll', payload),
  type: (payload) => ipcRenderer.invoke('browser:type', payload),
  key: (payload) => ipcRenderer.invoke('browser:key', payload),
  select: (payload) => ipcRenderer.invoke('browser:select', payload),
  dismiss: (payload) => ipcRenderer.invoke('browser:dismiss', payload || {}),
  drag: (payload) => ipcRenderer.invoke('browser:drag', payload),

  getState: (opts) => ipcRenderer.invoke('browser:getState', opts || {}),
  axSnapshot: (opts) => ipcRenderer.invoke('browser:axSnapshot', opts || {}),
  executeJs: (code) => ipcRenderer.invoke('browser:executeJs', code),

  /** Subscribe to paint frames: (frame) => void  frame = { data, width, height, mimeType } */
  onPaint: (handler) => {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on('browser:paint', listener);
    return () => ipcRenderer.removeListener('browser:paint', listener);
  },

  onNav: (handler) => {
    const listener = (_event, info) => handler(info);
    ipcRenderer.on('browser:nav', listener);
    return () => ipcRenderer.removeListener('browser:nav', listener);
  },

  /** AI pointer in page content: { x,y normalized, px, phase, ts } */
  onCursor: (handler) => {
    const listener = (_event, info) => handler(info);
    ipcRenderer.on('browser:cursor', listener);
    return () => ipcRenderer.removeListener('browser:cursor', listener);
  },
});
