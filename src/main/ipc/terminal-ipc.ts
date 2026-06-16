import type { IpcMain, WebContents } from 'electron'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionMetadata,
  CliRuntimeSettings,
  McpSettings,
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
  agentName?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  cliModel?: string
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
}

type TerminalIpcDependencies = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string): { processAlive: boolean }
  listTerminals(): TerminalSessionSnapshot[]
  setTerminalVisible(sessionId: string, visible: boolean): void
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

  ipcMain.handle('terminal:status', (_, sessionId: string): { processAlive: boolean } => {
    return deps.getTerminalStatus(sessionId)
  })

  ipcMain.handle('terminal:list', (): TerminalSessionSnapshot[] => {
    return deps.listTerminals()
  })

  ipcMain.handle('terminal:set-visible', (_, { sessionId, visible }: { sessionId: string; visible: boolean }): void => {
    deps.setTerminalVisible(sessionId, visible)
  })

  ipcMain.handle('terminal:kill', (_, sessionId: string): void => {
    deps.killTerminal(sessionId)
  })
}
