import { contextBridge, ipcRenderer } from 'electron'

type SaveDialogOptions = Electron.SaveDialogOptions
type OpenDialogOptions = Electron.OpenDialogOptions

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // File system
  readdir:   (path: string)                    => ipcRenderer.invoke('fs:readdir', path),
  readfile:  (path: string)                    => ipcRenderer.invoke('fs:readfile', path),
  writefile: (path: string, content: string)   => ipcRenderer.invoke('fs:writefile', path, content),
  openDir:   ()                                => ipcRenderer.invoke('fs:dialog:opendir'),
  saveFile:  (options?: SaveDialogOptions)     => ipcRenderer.invoke('fs:dialog:savefile', options),
  openFile:  (options?: OpenDialogOptions)     => ipcRenderer.invoke('fs:dialog:openfile', options),

  // Claude Code CLI runner
  claudeRun:    (agentId: string, prompt: string) => ipcRenderer.invoke('claude:run', { agentId, prompt }),
  claudeCancel: (agentId: string)                 => ipcRenderer.invoke('claude:cancel', agentId),

  onClaudeChunk: (agentId: string, cb: (chunk: string) => void): (() => void) => {
    const ch = `claude:chunk:${agentId}`
    const handler = (_: Electron.IpcRendererEvent, chunk: string) => cb(chunk)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onClaudeDone: (agentId: string, cb: () => void): (() => void) => {
    const ch = `claude:done:${agentId}`
    const handler = () => cb()
    ipcRenderer.once(ch, handler)
    return () => ipcRenderer.removeAllListeners(ch)
  },

  onClaudeError: (agentId: string, cb: (err: string) => void): (() => void) => {
    const ch = `claude:error:${agentId}`
    const handler = (_: Electron.IpcRendererEvent, err: string) => cb(err)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
})
