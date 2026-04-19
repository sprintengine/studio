import { contextBridge, ipcRenderer } from 'electron'

type SaveDialogOptions = Electron.SaveDialogOptions
type OpenDialogOptions = Electron.OpenDialogOptions
type ContextMenuItem = {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  // File system
  readdir:   (path: string)                    => ipcRenderer.invoke('fs:readdir', path),
  readfile:  (path: string)                    => ipcRenderer.invoke('fs:readfile', path),
  writefile: (path: string, content: string)   => ipcRenderer.invoke('fs:writefile', path, content),
  createFile: (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-file', parentDir, name),
  createDir:  (parentDir: string, name: string) => ipcRenderer.invoke('fs:create-dir', parentDir, name),
  renamePath: (sourcePath: string, nextName: string) => ipcRenderer.invoke('fs:rename', sourcePath, nextName),
  copyPath:   (sourcePath: string, destinationDir: string) => ipcRenderer.invoke('fs:copy', sourcePath, destinationDir),
  openDir:   ()                                => ipcRenderer.invoke('fs:dialog:opendir'),
  saveFile:  (options?: SaveDialogOptions)     => ipcRenderer.invoke('fs:dialog:savefile', options),
  openFile:  (options?: OpenDialogOptions)     => ipcRenderer.invoke('fs:dialog:openfile', options),
  showContextMenu: (items: ContextMenuItem[])  => ipcRenderer.invoke('app:show-context-menu', items),

  // Claude Code CLI Terminal
  terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean) => ipcRenderer.invoke('terminal:spawn', { sessionId, cols, rows, cwd, resume }),
  terminalWrite:  (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  terminalKill:   (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),

  onTerminalData: (sessionId: string, cb: (data: string) => void): (() => void) => {
    const ch = `terminal:data:${sessionId}`
    const handler = (_: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onTerminalExit: (sessionId: string, cb: (code: number) => void): (() => void) => {
    const ch = `terminal:exit:${sessionId}`
    const handler = (_: Electron.IpcRendererEvent, code: number) => cb(code)
    ipcRenderer.once(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onTerminalError: (sessionId: string, cb: (message: string) => void): (() => void) => {
    const ch = `terminal:error:${sessionId}`
    const handler = (_: Electron.IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  onAppMenuCommand: (cb: (command: string) => void): (() => void) => {
    const ch = 'app-menu:command'
    const handler = (_: Electron.IpcRendererEvent, command: string) => cb(command)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
})
