declare global {
  interface Window {
    api: {
      platform: string
      readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
      readfile:  (path: string) => Promise<string>
      writefile: (path: string, content: string) => Promise<void>
      openDir:   () => Promise<string | null>
      saveFile:  (options?: Electron.SaveDialogOptions) => Promise<string | null>
      openFile:  (options?: Electron.OpenDialogOptions) => Promise<string | null>

      terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string) => Promise<void>
      terminalWrite:  (sessionId: string, data: string) => Promise<void>
      terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
      terminalKill:   (sessionId: string) => Promise<void>

      onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
      onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
      onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
    }
  }
}
