// =============================================================================
// Talking to a WSL distribution from the Windows side
//
// Three rules hold for everything this app asks WSL to run:
//
//   - Name the distribution. `wsl.exe` without `-d` lands in whatever is the
//     default at that moment, so a workspace inside a second distribution was
//     opened in the wrong file system, and a probe could read one distribution
//     while the agent ran in another. The distribution comes from the folder
//     when the folder names one (`\\wsl.localhost\<distro>\…`), and otherwise
//     from `wsl.exe --list --verbose`, read once and cached.
//   - Send scripts on stdin. `wsl.exe` rebuilds the Linux command line from
//     the Windows one and does not keep quoting intact, so `-e sh -c '<script>'`
//     arrives mangled whenever the script holds quotes or `$`. Every script
//     goes to `--exec sh -s` as bytes instead.
//   - Start in the Linux home. A `wsl.exe` started from a Windows process
//     inherits a working directory on the Windows drive, and anything run
//     there goes through the drive mount, which is slow enough to stall a
//     probe for seconds. `--cd ~` keeps every probe on the Linux file system.
// =============================================================================

import { basename } from 'node:path'

import { distroOfUncPath } from '../shared/host-paths'
import { runSpawnDescriptor, type RunOutcome, type SpawnDescriptor } from './process-run'

export type WslDistro = { name: string; isDefault: boolean; state: string; version: number | null }

// Distribution names are letters, digits, `.`, `_` and `-` (WSL refuses others
// at import). Anything else read from the list is not passed to `-d`.
const DISTRO_NAME = /^[A-Za-z0-9._-]+$/u

export function isValidWslDistroName(name: string): boolean {
  return DISTRO_NAME.test(name)
}

/**
 * `wsl.exe`'s own output as text. Its messages and `--list` are UTF-16LE unless
 * `WSL_UTF8=1` is set, and a UTF-8 decode of UTF-16 reads as the right letters
 * with a NUL between each, which no parser matches.
 */
export function decodeWslOutput(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  // Without a byte order mark, ASCII text in UTF-16LE has a zero in every odd
  // byte. Sample the start rather than trusting one byte.
  const sample = bytes.subarray(0, Math.min(bytes.length, 64))
  let zeros = 0
  for (let index = 1; index < sample.length; index += 2) if (sample[index] === 0) zeros += 1
  if (sample.length >= 2 && zeros >= Math.floor(sample.length / 2) * 0.6) return bytes.toString('utf16le')
  return bytes.toString('utf8')
}

/**
 * The rows of `wsl.exe --list --verbose`:
 *
 *     NAME            STATE           VERSION
 *   * Ubuntu          Running         2
 *     Debian          Stopped         2
 *
 * The header is localised, so it is skipped by shape (its last column is not a
 * number) rather than by its words. The same goes for the message printed when
 * no distribution is installed.
 */
export function parseWslListVerbose(text: string): WslDistro[] {
  const distros: WslDistro[] = []
  for (const raw of text.replace(/\0/g, '').split(/\r?\n/u)) {
    const match = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/u.exec(raw)
    if (!match || !isValidWslDistroName(match[2])) continue
    distros.push({ name: match[2], isDefault: match[1] === '*', state: match[3], version: Number(match[4]) })
  }
  return distros
}

// ── The default distribution ─────────────────────────────────────────────────

// Listing is cheap (it does not boot the VM) but it is still a process start
// on Windows, so an answer is kept for a while. A failure is retried sooner:
// it is usually WSL still installing or updating.
const DEFAULT_DISTRO_TTL_MS = 10 * 60_000
const DEFAULT_DISTRO_FAILURE_TTL_MS = 30_000
const LIST_TIMEOUT_MS = 10_000

type DistroCache = { value: string | null; expiresAt: number }
let defaultDistroCache: DistroCache | null = null
let defaultDistroInFlight: Promise<string | null> | null = null

export type WslListRunner = () => Promise<string | null>

async function runWslList(): Promise<string | null> {
  const outcome = await runSpawnDescriptor(
    { file: 'wsl.exe', args: ['--list', '--verbose'] },
    { timeoutMs: LIST_TIMEOUT_MS, decodeStdout: decodeWslOutput },
  )
  return outcome.code === 0 && !outcome.timedOut ? outcome.stdout : null
}

/**
 * The default distribution's name, or null when WSL is missing, has none, or
 * could not be asked. Callers that get null run `wsl.exe` without `-d`, which
 * is the default distribution by definition — the name only makes the choice
 * explicit and stable while the default is changed underneath.
 */
export async function resolveDefaultWslDistro(
  deps: { runList?: WslListRunner; now?: () => number } = {},
): Promise<string | null> {
  const now = deps.now ?? Date.now
  if (defaultDistroCache && defaultDistroCache.expiresAt > now()) return defaultDistroCache.value
  if (defaultDistroInFlight) return defaultDistroInFlight
  const runList = deps.runList ?? runWslList
  const lookup = (async () => {
    const text = await runList().catch(() => null)
    const value = text === null ? null : (parseWslListVerbose(text).find((distro) => distro.isDefault)?.name ?? null)
    defaultDistroCache = {
      value,
      expiresAt: now() + (value ? DEFAULT_DISTRO_TTL_MS : DEFAULT_DISTRO_FAILURE_TTL_MS),
    }
    return value
  })()
  defaultDistroInFlight = lookup
  try {
    return await lookup
  } finally {
    if (defaultDistroInFlight === lookup) defaultDistroInFlight = null
  }
}

/**
 * The last default distribution read, without asking again. For the launch,
 * which builds its command synchronously; `primeDefaultWslDistro` fills it at
 * startup on Windows. Null until then, which launches without `-d`.
 */
export function knownDefaultWslDistro(): string | null {
  return defaultDistroCache?.value ?? null
}

/** Starts the default-distribution lookup in the background (Windows only). */
export function primeDefaultWslDistro(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  void resolveDefaultWslDistro().catch(() => null)
}

/** The distribution a WSL process for `cwd` runs in, as far as is known now. */
export function wslDistroForPath(cwd: string | undefined): string | null {
  const fromPath = cwd ? distroOfUncPath(cwd) : null
  if (fromPath && isValidWslDistroName(fromPath)) return fromPath
  return knownDefaultWslDistro()
}

/** `wslDistroForPath`, asking WSL for the default when it is not known yet. */
export async function resolveWslDistroForPath(
  cwd: string | undefined,
  deps: { runList?: WslListRunner } = {},
): Promise<string | null> {
  const fromPath = cwd ? distroOfUncPath(cwd) : null
  if (fromPath && isValidWslDistroName(fromPath)) return fromPath
  return resolveDefaultWslDistro(deps)
}

/** `-d <distro>`, or nothing when the distribution is not known. */
export function wslDistroArgs(distro: string | null | undefined): string[] {
  return distro && isValidWslDistroName(distro) ? ['-d', distro] : []
}

// Test seams.
export function __setDefaultWslDistroForTest(value: string | null, ttlMs = DEFAULT_DISTRO_TTL_MS): void {
  defaultDistroCache = { value, expiresAt: Date.now() + ttlMs }
  defaultDistroInFlight = null
}

export function __resetWslHostForTest(): void {
  defaultDistroCache = null
  defaultDistroInFlight = null
}

// ── Scripts ─────────────────────────────────────────────────────────────────

/**
 * Runs `script` with `sh` inside `distro`, fed on stdin, starting in the Linux
 * home.
 */
export function wslScriptDescriptor(distro: string | null | undefined, script: string): SpawnDescriptor {
  return {
    file: 'wsl.exe',
    args: [...wslDistroArgs(distro), '--cd', '~', '--exec', 'sh', '-s'],
    stdin: script.endsWith('\n') ? script : `${script}\n`,
  }
}

const LOGIN_SCRIPT_END = '__SPRINTENGINE_LOGIN_SCRIPT_END__'

/**
 * `body` run by a login `bash`, for scripts that need what the person's profile
 * sets up: the `PATH` their CLIs are installed on, a `CLAUDE_CONFIG_DIR`. The
 * body reaches bash as a quoted here-document, so nothing in it is expanded by
 * the `sh` that starts bash. Anything the body runs that could read stdin must
 * redirect it (`</dev/null`), or it would read the rest of the script.
 */
export function wslLoginScript(body: string): string {
  return `exec bash -l <<'${LOGIN_SCRIPT_END}'\n${body}\n${LOGIN_SCRIPT_END}\n`
}

export type WslScriptRunner = (
  distro: string | null,
  script: string,
  options: { timeoutMs: number },
) => Promise<RunOutcome>

/** Runs a script in a distribution through `wsl.exe`, with a deadline. */
export const runWslScript: WslScriptRunner = (distro, script, options) =>
  runSpawnDescriptor(wslScriptDescriptor(distro, script), { timeoutMs: options.timeoutMs })

// ── Session root pids ───────────────────────────────────────────────────────
//
// For a WSL terminal the pty's pid is the Windows `wsl.exe`, which means
// nothing inside the distribution. The startup script therefore records the
// Linux pid of the shell it runs in (`$$`), which stays the same through the
// script's final `exec bash -li`, and every CLI the script starts is its
// child. A probe reads that file to find the subtree to inspect.
//
// The file is named after the startup script, which is unique per launch, so
// a relaunch never reads a pid from the session it replaced.

/** The per-user directory the pid files live in, as a `sh` word. */
export const WSL_SESSION_PID_DIR = '/tmp/sprintengine-studio-$(id -u)/sessions'

/** The pid-file key for a launch, from its startup script's file name. */
export function wslSessionPidKey(startupScriptPath: string | undefined): string | null {
  if (!startupScriptPath) return null
  const name = basename(startupScriptPath.replace(/\\/g, '/')).replace(/\.[^.]+$/u, '')
  return /^[A-Za-z0-9._-]+$/u.test(name) ? name : null
}

/**
 * The startup-script line that records the shell's pid. One line, so it can be
 * joined into the `; `-separated script, and silent on failure: a session that
 * could not write its pid is held by the reaper, never broken.
 */
export function wslSessionPidFileCommand(key: string): string {
  const dir = WSL_SESSION_PID_DIR
  return `(umask 077 && mkdir -p "${dir}" && printf '%s\\n' "$$" > "${dir}/${key}.pid") 2>/dev/null`
}
