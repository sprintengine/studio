import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentCli,
  CliRuntimeSettings,
  ElectronApi,
  TerminalSessionSnapshot,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
} from '../../shared/electron-api'

export const terminalApi = {
  terminalSpawn: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata
  ): Promise<TerminalSpawnResult> => ipcRenderer.invoke('terminal:spawn', {
    sessionId,
    cols,
    rows,
    cwd,
    resume,
    cli,
    initialPrompt,
    cliRuntimes,
    shellOnly,
    ...metadata,
  }),
  terminalWrite: (sessionId: string, data: string) => ipcRenderer.invoke('terminal:write', { sessionId, data }),
  terminalWriteFast: (sessionId: string, data: string): void => ipcRenderer.send('terminal:write-fast', { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  terminalStatus: (sessionId: string): Promise<{ processAlive: boolean; suspended: boolean }> => ipcRenderer.invoke('terminal:status', sessionId),
  terminalList: (): Promise<TerminalSessionSnapshot[]> => ipcRenderer.invoke('terminal:list'),
  terminalSetVisible: (sessionId: string, visible: boolean) => ipcRenderer.invoke('terminal:set-visible', { sessionId, visible }),
  terminalSuspend: (sessionId: string) => ipcRenderer.invoke('terminal:suspend', sessionId),
  terminalResume: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata
  ): Promise<TerminalSpawnResult> => ipcRenderer.invoke('terminal:resume', {
    sessionId,
    cols,
    rows,
    cwd,
    resume,
    cli,
    initialPrompt,
    cliRuntimes,
    shellOnly,
    ...metadata,
  }),
  terminalKill: (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),
  setTerminalIdleSuspendMs: (ms: number): Promise<void> =>
    ipcRenderer.invoke('terminal:set-idle-suspend-ms', ms),
  setTerminalKeepRecentAliveCount: (count: number): Promise<void> =>
    ipcRenderer.invoke('terminal:set-keep-recent-alive-count', count),
  setTerminalReapExempt: (sessionId: string, exempt: boolean): Promise<void> =>
    ipcRenderer.invoke('terminal:set-reap-exempt', { sessionId, exempt }),
  onTerminalReplay: (sessionId: string, cb: (data: string) => void): (() => void) => {
    const ch = `terminal:replay:${sessionId}`
    const handler = (_: IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onTerminalData: (sessionId: string, cb: (data: string) => void): (() => void) => {
    const ch = `terminal:data:${sessionId}`
    const handler = (_: IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onTerminalExit: (sessionId: string, cb: (code: number) => void): (() => void) => {
    const ch = `terminal:exit:${sessionId}`
    const handler = (_: IpcRendererEvent, code: number) => cb(code)
    ipcRenderer.once(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onTerminalError: (sessionId: string, cb: (message: string) => void): (() => void) => {
    const ch = `terminal:error:${sessionId}`
    const handler = (_: IpcRendererEvent, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  onTerminalSessionsChanged: (cb: (sessions: TerminalSessionSnapshot[]) => void): (() => void) => {
    const ch = 'terminal:sessions-changed'
    const handler = (_: IpcRendererEvent, sessions: TerminalSessionSnapshot[]) => cb(sessions)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'terminalSpawn'
  | 'terminalWrite'
  | 'terminalWriteFast'
  | 'terminalResize'
  | 'terminalStatus'
  | 'terminalList'
  | 'terminalSetVisible'
  | 'terminalSuspend'
  | 'terminalResume'
  | 'terminalKill'
  | 'setTerminalIdleSuspendMs'
  | 'setTerminalKeepRecentAliveCount'
  | 'setTerminalReapExempt'
  | 'onTerminalReplay'
  | 'onTerminalData'
  | 'onTerminalExit'
  | 'onTerminalError'
  | 'onTerminalSessionsChanged'
>
