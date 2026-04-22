declare global {
  interface ContextMenuItem {
    id?: string
    label?: string
    enabled?: boolean
    type?: 'normal' | 'separator'
  }

  type AgentCli = 'codex' | 'claude'
  type CliRuntimeSettings = {
    command: string
    useWsl: boolean
  }

  interface Window {
    api: {
      platform: string
      readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
      readfile:  (path: string) => Promise<string>
      writefile: (path: string, content: string) => Promise<void>
      createFile: (parentDir: string, name: string) => Promise<string>
      createDir: (parentDir: string, name: string) => Promise<string>
      ensureDir: (parentDir: string, name: string) => Promise<string>
      renamePath: (sourcePath: string, nextName: string) => Promise<string>
      copyPath: (sourcePath: string, destinationDir: string) => Promise<string>
      deletePath: (targetPath: string) => Promise<void>
      openDir:   () => Promise<string | null>
      saveFile:  (options?: Electron.SaveDialogOptions) => Promise<string | null>
      openFile:  (options?: Electron.OpenDialogOptions) => Promise<string | null>
      showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>

      terminalSpawn:  (sessionId: string, cols: number, rows: number, cwd?: string, resume?: boolean, swarmStatePath?: string, cli?: AgentCli, initialPrompt?: string, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>) => Promise<void>
      terminalWrite:  (sessionId: string, data: string) => Promise<void>
      terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>
      terminalKill:   (sessionId: string) => Promise<void>

      onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
      onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
      onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
      onAppMenuCommand: (cb: (command: string) => void) => () => void
    }
  }
}
