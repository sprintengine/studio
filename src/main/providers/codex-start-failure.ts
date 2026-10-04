// What a Codex chat says when its app-server never answered `initialize`.
//
// "Codex initialize timed out." names the step and nothing a person can do
// about it. The usual cause found in testing was Codex's own log database in
// its home folder grown to gigabytes, which Codex opens before it answers. So
// the message says how long it waited and where to run `codex` to see why,
// and, when that database is large, names its size and the fix.
//
// The size is read, never changed: this lists the folder and stats the files
// that match, through the file system of the machine the chat runs on. Moving
// the files aside is the person's call.

import { readdir, stat } from 'node:fs/promises'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'

import { executionHostLabel, LOCAL_HOST_ID } from '../../shared/execution-host'

/** Above this, the log database is named as a likely reason for the slow start. */
export const CODEX_LOG_DATABASE_WARN_BYTES = 500 * 1024 * 1024

/** The files the size is summed over: `logs_*.sqlite*`, the database and its journal. */
const LOG_DATABASE_FILE = /^logs_.*\.sqlite/u

/** Whether a start failed because Codex never answered `initialize`. */
export function isCodexInitializeTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Codex initialize timed out.'
}

/**
 * The total size of the `logs_*.sqlite*` files in a Codex home folder, or
 * null when the folder cannot be listed. A file that vanishes between the
 * listing and its stat counts as nothing.
 */
export async function codexLogDatabaseBytes(codexHome: string): Promise<number | null> {
  let names: string[]
  try {
    names = await readdir(codexHome)
  } catch {
    return null
  }
  let total = 0
  for (const name of names) {
    if (!LOG_DATABASE_FILE.test(name)) continue
    try {
      const info = await stat(join(codexHome, name))
      if (info.isFile()) total += info.size
    } catch {
      // Gone since the listing.
    }
  }
  return total
}

/** A size as a person reads it: `2.5 GB`, `740 MB`. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${Number(gb.toFixed(1))} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** The failure's words, from what is known. */
export function codexStartTimeoutMessage(input: { seconds: number; machine: string; logBytes: number | null }): string {
  const lead = `Codex didn't answer in ${input.seconds} s. Run \`codex\` in a terminal on ${input.machine} to see why.`
  if (input.logBytes === null || input.logBytes <= CODEX_LOG_DATABASE_WARN_BYTES) return lead
  return `${lead} Codex's own log database is ${formatBytes(input.logBytes)}, which can make it slow to start. Moving \`~/.codex/logs_*.sqlite*\` aside fixes it.`
}

/**
 * The machine a chat's `codex` ran on, as the message names it: the WSL
 * distribution it was started in from Windows, else the distribution this
 * process itself runs in (a Studio server inside WSL), else this desktop,
 * else (a Studio server on another machine) that machine's host name.
 */
export function codexMachineLabel(
  wslDistro: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  isDesktop: boolean = Boolean(process.versions.electron),
): string {
  if (wslDistro) return `WSL: ${wslDistro}`
  if (env.WSL_DISTRO_NAME) return `WSL: ${env.WSL_DISTRO_NAME}`
  if (isDesktop) return executionHostLabel(LOCAL_HOST_ID, platform)
  try {
    return hostname().trim() || 'this machine'
  } catch {
    return 'this machine'
  }
}

/**
 * The Codex home folder on the machine the chat ran on, as this process's file
 * system opens it. For a distribution started from Windows, its home through
 * the WSL host (`\\wsl.localhost\<distro>\home\<user>`), with the
 * distribution's own `CODEX_HOME` when its login shell sets one.
 */
export async function codexHomeFor(wslDistro: string | null, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!wslDistro) return env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  try {
    const { hostRegistry } = await import('../hosts/host-registry')
    const home = await hostRegistry().get(`wsl:${wslDistro}`).homeDir()
    if (!home) return null
    return home.env?.CODEX_HOME ?? join(home.native, '.codex')
  } catch {
    return null
  }
}

/**
 * How long the failure waits for the log database's size. The machine Codex
 * just failed to start on is the one most likely to be stuck, and a listing
 * of a distribution's share that stopped answering never settles: past this,
 * the message goes out without the size.
 */
export const CODEX_LOG_SIZE_DEADLINE_MS = 5_000

/** The error a start that timed out on `initialize` fails with. */
export async function explainCodexInitializeTimeout(input: {
  timeoutMs: number
  wslDistro: string | null
  env: NodeJS.ProcessEnv
  readLogBytes?: (wslDistro: string | null, env: NodeJS.ProcessEnv) => Promise<number | null>
  /** Tests shorten it; {@link CODEX_LOG_SIZE_DEADLINE_MS} otherwise. */
  readDeadlineMs?: number
}): Promise<Error> {
  const readLogBytes =
    input.readLogBytes ??
    (async (distro: string | null, env: NodeJS.ProcessEnv) => {
      const home = await codexHomeFor(distro, env)
      return home ? codexLogDatabaseBytes(home) : null
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.readDeadlineMs ?? CODEX_LOG_SIZE_DEADLINE_MS)
  })
  const logBytes = await Promise.race([readLogBytes(input.wslDistro, input.env).catch(() => null), deadline]).finally(
    () => clearTimeout(timer),
  )
  return new Error(
    codexStartTimeoutMessage({
      seconds: Math.round(input.timeoutMs / 1000),
      machine: codexMachineLabel(input.wslDistro),
      logBytes,
    }),
  )
}
