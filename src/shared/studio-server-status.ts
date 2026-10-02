import type { ServerMode } from './server-mode'

// What a window is told about the Studio server, for the words it shows (a
// banner while the server starts, reconnects or has stopped; the Settings
// section that turns the separate process on and off). Never a status dot: a
// state is said in a sentence.

export const STUDIO_SERVER_CHANNELS = {
  status: 'studio-server:status',
  changed: 'studio-server:status-changed',
  retry: 'studio-server:retry',
  restart: 'studio-server:restart',
  openLog: 'studio-server:open-log',
  setMode: 'studio-server:set-mode',
  relaunch: 'studio-server:relaunch',
  info: 'studio-server:info',
} as const

/** Where the server is in its life, in the words the window uses. */
export type StudioServerPhase =
  /** The server runs inside the app this session: nothing to say. */
  | 'in-process'
  | 'starting'
  | 'running'
  /** It stopped and is being started again. */
  | 'reconnecting'
  /** It kept failing, or refused to start: a person has to act. */
  | 'stopped'
  | 'stopping'

export type StudioServerStatus = {
  /** The mode this session runs in. */
  mode: ServerMode
  /** The mode the next launch runs in (the Advanced toggle). */
  savedMode: ServerMode
  /** The mode is set by `SPRINTENGINE_SERVER_MODE`, which the toggle cannot change. */
  fromEnvironment: boolean
  phase: StudioServerPhase
  /** Why it stopped, in the server's own words where it gave some. */
  reason: string | null
  pid: number | null
  restarts: number
  startedAt: number | null
  /**
   * The server could not start at all this session's last launch, so this
   * session runs it inside the app (decision O9). Said once, in words.
   */
  fellBack: string | null
}

export type StudioServerInfo = {
  pid: number
  uptimeMs: number
  version: string
  gatewaySocket: string | null
  cipher: string
  rssMb: number
  loopLagMs: number | null
}
