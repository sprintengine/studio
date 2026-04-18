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

declare interface Window {
  api: {
    platform: string

    // File system
    readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
    readfile:  (path: string) => Promise<string>
    writefile: (path: string, content: string) => Promise<void>
    openDir:   () => Promise<string | null>
    saveFile:  (options?: SaveDialogOptions) => Promise<string | null>
    openFile:  (options?: OpenDialogOptions) => Promise<string | null>

    // Claude Code CLI
    claudeRun:     (agentId: string, prompt: string) => Promise<void>
    claudeCancel:  (agentId: string) => Promise<void>
    onClaudeChunk: (agentId: string, cb: (chunk: string) => void) => () => void
    onClaudeDone:  (agentId: string, cb: () => void) => () => void
    onClaudeError: (agentId: string, cb: (err: string) => void) => () => void
  }
}
