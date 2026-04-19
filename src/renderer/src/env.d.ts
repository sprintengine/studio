/// <reference types="vite/client" />

type SaveDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

type OpenDialogOptions = {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

interface ContextMenuItem {
  id?: string
  label?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
}

interface FileWatchEvent {
  eventType: string
  path: string | null
}

declare interface Window {
  api: {
    platform: string

    // File system
    readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
    readfile:  (path: string) => Promise<string>
    writefile: (path: string, content: string) => Promise<void>
    createFile: (parentDir: string, name: string) => Promise<string>
    createDir: (parentDir: string, name: string) => Promise<string>
    renamePath: (sourcePath: string, nextName: string) => Promise<string>
    copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
    watchPath: (path: string, cb: (event: FileWatchEvent) => void) => Promise<() => Promise<void>>
    openDir:   () => Promise<string | null>
    saveFile:  (options?: SaveDialogOptions) => Promise<string | null>
    openFile:  (options?: OpenDialogOptions) => Promise<string | null>
    showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
    showMenubarMenu: (label: string, position?: { x?: number; y?: number }) => Promise<boolean>

    // Claude Code CLI Terminal
    terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean, swarmStatePath?: string) => Promise<void>
    terminalWrite:  (sessionId: string, data: string) => Promise<void>
    terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
    terminalKill:   (sessionId: string) => Promise<void>

    onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
    onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
    onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
    onAppMenuCommand: (cb: (command: string) => void) => () => void
  }
}
