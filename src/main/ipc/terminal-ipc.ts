import type { IpcMain, WebContents } from 'electron'
import type {
  AgentCli,
  AgentExecutionMode,
  CliRuntimeSettings,
  SprintEngineCliPermissionPreset,
  TerminalKind,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../../shared/electron-api'

export type TerminalSpawnPayload = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  resume?: boolean
  sprintEngineStatePath?: string
  cli?: AgentCli
  initialPrompt?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  shellOnly?: boolean
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  memoryRootPath?: string
  memoryRelativeRoot?: string
  watchtowerRunId?: string
  watchtowerWorkspaceRoot?: string
}

type TerminalIpcDependencies = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string): { running: boolean }
  listTerminals(): TerminalSessionSnapshot[]
  killTerminal(sessionId: string): void
}

export function registerTerminalIpc(ipcMain: IpcMain, deps: TerminalIpcDependencies): void {
  ipcMain.handle('terminal:spawn', async (event, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult> => {
    return deps.spawnTerminal(event.sender, payload)
  })

  ipcMain.handle('terminal:write', (_, { sessionId, data }: { sessionId: string; data: string }): void => {
    deps.writeTerminal(sessionId, data)
  })

  ipcMain.on('terminal:write-fast', (_, payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return
    const { sessionId, data } = payload as { sessionId?: unknown; data?: unknown }
    if (typeof sessionId !== 'string' || typeof data !== 'string') return

    deps.writeTerminal(sessionId, data)
  })

  ipcMain.handle('terminal:resize', (_, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }): void => {
    deps.resizeTerminal(sessionId, cols, rows)
  })

  ipcMain.handle('terminal:status', (_, sessionId: string): { running: boolean } => {
    return deps.getTerminalStatus(sessionId)
  })

  ipcMain.handle('terminal:list', (): TerminalSessionSnapshot[] => {
    return deps.listTerminals()
  })

  ipcMain.handle('terminal:kill', (_, sessionId: string): void => {
    deps.killTerminal(sessionId)
  })
}
