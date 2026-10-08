import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomicSync } from '../server/platform/atomic-file'

import {
  DEFAULT_SERVER_MODE,
  parseServerMode,
  SERVER_MODE_ARGUMENT,
  SERVER_MODE_ENV,
  SERVER_MODE_FILENAME,
  type ServerMode,
} from '../shared/server-mode'

// Where this session's Studio server runs, decided once at boot (phase 6
// spec, 7.3): `SPRINTENGINE_SERVER_MODE` for dev and CI, else the shell-owned
// `server-mode.json` the Advanced toggle writes, else in process. Read
// synchronously, before any service is built, and never changed during the
// session: a store has one writer from the first byte to the last.

export type ServerModeChoice = { mode: ServerMode; source: 'environment' | 'settings' | 'default' | 'fallback' }

/**
 * On the command line of a launch that follows a session whose server could
 * not start at all (decision O9): this session runs the server in process.
 * Never written to the settings file: the next ordinary launch tries again.
 */
export const SERVER_FALLBACK_ARGUMENT = '--studio-server-fallback'
const FALLBACK_NOTE_FILENAME = 'server-fallback.json'

export function readServerMode(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): ServerModeChoice {
  if (argv.includes(SERVER_FALLBACK_ARGUMENT)) return { mode: 'in-process', source: 'fallback' }
  const fromEnv = parseServerMode(env[SERVER_MODE_ENV])
  if (fromEnv) return { mode: fromEnv, source: 'environment' }
  try {
    const stored = JSON.parse(readFileSync(join(userDataDir, SERVER_MODE_FILENAME), 'utf8')) as { mode?: unknown }
    const mode = parseServerMode(stored.mode)
    if (mode) return { mode, source: 'settings' }
  } catch {
    // Absent or unreadable: the default.
  }
  return { mode: DEFAULT_SERVER_MODE, source: 'default' }
}

/** What the next launch runs in. Written whole and renamed into place. */
export function writeServerMode(userDataDir: string, mode: ServerMode): void {
  writeFileAtomicSync(join(userDataDir, SERVER_MODE_FILENAME), `${JSON.stringify({ mode }, null, 2)}\n`, { mode: 0o600 })
}

let sessionMode: ServerMode = DEFAULT_SERVER_MODE

/** Fix this session's mode; called once by the app's entry before any window exists. */
export function setSessionServerMode(mode: ServerMode): void {
  sessionMode = mode
}

export function sessionServerMode(): ServerMode {
  return sessionMode
}

/** The switch every app window's renderer is started with, which its preload's router reads. */
export function serverModeWindowArguments(): string[] {
  return [`${SERVER_MODE_ARGUMENT}${sessionMode}`]
}

/** Leave the next launch a note of why it runs the server in process. */
export function writeServerFallbackNote(userDataDir: string, reason: string): void {
  try {
    writeFileSync(join(userDataDir, FALLBACK_NOTE_FILENAME), `${JSON.stringify({ reason }, null, 2)}\n`, {
      mode: 0o600,
    })
  } catch {
    // The fallback still happens; it is only said less precisely.
  }
}

/** Read and remove that note: it is said once, by the launch it was left for. */
export function takeServerFallbackNote(userDataDir: string): string | null {
  const path = join(userDataDir, FALLBACK_NOTE_FILENAME)
  try {
    const reason = (JSON.parse(readFileSync(path, 'utf8')) as { reason?: unknown }).reason
    unlinkSync(path)
    return typeof reason === 'string' ? reason : null
  } catch {
    return null
  }
}
