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
  // The agent's session id within its CLI/harness, used as the resume token
  // (`claude --resume <id>` / `codex resume <id>`). Distinct from `sessionId`
  // (our terminal-tracking key). For Claude it equals the minted id; for Codex
  // it is the harness id learned from the hook, persisted and passed on resume.
  cliSessionId?: string
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  agentName?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: SprintEngineCliPermissionPreset
  debugMode?: boolean
  cliModel?: string
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
  // True when `mcpSettings` is a connector launch's isolated single-server
  // config — the spawn prunes unlisted MCP servers from the worktree config and
  // git-excludes it, with or without a driving skill. Unset for ordinary spawns.
  connectorLaunch?: boolean
  // Connector launches with a driving skill (e.g. Railway) install this builtin
  // skill into the worktree at spawn so the seeded skill invocation resolves to
  // a present skill. Generalizes the debug-skill install (which hardcodes
  // 'debug'); best-effort, non-blocking. Unset for skill-less connector
  // launches and ordinary spawns.
  connectorSkillId?: string
  // Skill-at-spawn for ordinary agents (the composer's "+ Skill" attachment):
  // same ensure-install, none of the connector MCP coupling.
  spawnSkillId?: string
  // The payload is flat. Renderer callers hand `metadata` to preload, which
  // spreads it in; in-process callers (the sprint runtime) must flatten it
  // themselves. Typed `never` so handing over a still-nested TerminalSpawnArgs
  // fails to compile instead of silently dropping every field in the bag.
  metadata?: never
}

type TerminalIpcDependencies = {
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(
    sessionId: string,
    sender?: WebContents
  ): Promise<{ processAlive: boolean; suspended: boolean }>
  listTerminals(): TerminalSessionSnapshot[]
  setTerminalVisible(sessionId: string, visible: boolean, sender?: WebContents): void
  suspendTerminal(sessionId: string): void
  resumeTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  killTerminal(sessionId: string): void
  setIdleSuspendThresholdMs(value: unknown): void
  setKeepRecentTerminalsAlive(value: unknown): void
  setTerminalReapExempt(sessionId: string, exempt: boolean): void
  setActiveSprintRunStatePaths(value: unknown): void
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

  // The sender matters: a status lookup can rehydrate a suspended placeholder
  // from its snapshot sidecar, and the placeholder must target the window that
  // is about to reveal it.
  ipcMain.handle('terminal:status', (event, sessionId: string): Promise<{ processAlive: boolean; suspended: boolean }> => {
    return deps.getTerminalStatus(sessionId, event.sender)
  })

  ipcMain.handle('terminal:list', (): TerminalSessionSnapshot[] => {
    return deps.listTerminals()
  })

  ipcMain.handle('terminal:set-visible', (event, { sessionId, visible }: { sessionId: string; visible: boolean }): void => {
    deps.setTerminalVisible(sessionId, visible, event.sender)
  })

  ipcMain.handle('terminal:suspend', (_, sessionId: string): void => {
    deps.suspendTerminal(sessionId)
  })

  ipcMain.handle('terminal:resume', async (event, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult> => {
    return deps.resumeTerminal(event.sender, payload)
  })

  ipcMain.handle('terminal:kill', (_, sessionId: string): void => {
    deps.killTerminal(sessionId)
  })

  // Renderer pushes the user's "Pause idle terminals after" setting (ms). The
  // reap policy clamps it; an out-of-range or non-numeric value falls back to the
  // default. Fire-and-forget — the next reap sweep reads the latest value.
  ipcMain.handle('terminal:set-idle-suspend-ms', (_, value: unknown): void => {
    deps.setIdleSuspendThresholdMs(value)
  })

  // Per-terminal user lock: while set, the reaper never suspends or disposes
  // this session. Validated here — it arrives straight off a renderer click.
  ipcMain.handle('terminal:set-reap-exempt', (_, payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return
    const { sessionId, exempt } = payload as { sessionId?: unknown; exempt?: unknown }
    if (typeof sessionId !== 'string' || typeof exempt !== 'boolean') return
    deps.setTerminalReapExempt(sessionId, exempt)
  })

  // Renderer pushes the user's "Always keep running" count — the recency floor
  // below which the idle reaper never suspends live agent terminals. The reap
  // policy clamps it; out-of-range or non-numeric falls back to the default.
  ipcMain.handle('terminal:set-keep-recent-alive-count', (_, value: unknown): void => {
    deps.setKeepRecentTerminalsAlive(value)
  })

  // Renderer pushes the set of SprintEngine run statePaths whose dispatch loop is
  // actively running, so the idle reaper protects those runs' agents (the
  // claim-aware 5-min retirement owns them) and only reclaims inactive-run agents.
  ipcMain.handle('terminal:set-active-sprint-runs', (_, value: unknown): void => {
    deps.setActiveSprintRunStatePaths(value)
  })
}
