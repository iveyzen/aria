import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

export interface UiMessage {
  channel: string
  payload?: unknown
}

contextBridge.exposeInMainWorld('aria', {
  connect: () => ipcRenderer.send('connect'),
  disconnect: () => ipcRenderer.send('disconnect'),
  sendAudio: (chunk: Uint8Array) => ipcRenderer.send('audio-chunk', chunk),
  getSources: () => ipcRenderer.invoke('get-sources'),
  setTarget: (target: unknown) => ipcRenderer.send('set-target', target),
  setWatch: (on: boolean) => ipcRenderer.send('set-watch', on),
  winMin: () => ipcRenderer.send('win-min'),
  winClose: () => ipcRenderer.send('win-close'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('save-config', cfg),
  onUi: (cb: (msg: UiMessage) => void) =>
    ipcRenderer.on('ui', (_e: IpcRendererEvent, msg: UiMessage) => cb(msg)),
  onAudio: (cb: (chunk: Uint8Array) => void) =>
    ipcRenderer.on('audio', (_e: IpcRendererEvent, chunk: Uint8Array) => cb(chunk)),
  onAudioClear: (cb: () => void) => ipcRenderer.on('audio-clear', () => cb())
})
