import { constants as osConstants } from 'node:os'

import type { HelperProcess } from '../../main/hosts/wsl-helper-client'
import { classifyWslFailure } from '../../main/hosts/wsl-helper-client'
import { decodeWslOutput } from '../../main/hosts/wsl-distro'
import { NEEDS_INSTALL_EXIT, parseNeedReport, WSL_DATA_REL, type NeedReport } from '../../main/hosts/wsl-install'
import { WslSetupError } from '../../main/hosts/wsl-setup-error'
import type { ServerBoot, ServerBootstrapEnvelope, ServerReady } from '../bootstrap/envelope'

// Starting one Studio server inside a WSL distribution (phase 7 spec, 3.3):
//
//   1. `wsl.exe -d <distro> --cd ~ --exec sh -s` runs the launch script
//      (`wsl-install.ts`, entry `server`), which either execs the server on
//      the pinned Node or says what has to be installed first. Installs run,
//      and the start is tried again, as the helper's are.
//   2. The server says `boot` before it reads anything, naming its home and
//      its own files. Only then is the envelope written, built for those
//      paths, so the `sh` that exec'd the server cannot have read part of it,
//      and the owner token's hash never goes in argv or the environment.
//   3. `ready` names the front door's port and bridge socket, and where the
//      distribution mounts the Windows drives.
//
// The starter's stdin then stays open as the lease: pings every fifteen
// seconds, `shutdown` to drain, and its end is the server's news that the
// Windows side is gone. A transient failure (a VM still booting) is retried
// after a pre-warm with a backoff; a fatal one (no such distribution, Node
// will not run) is reported at once, in words.

export type WslServerStartDeps = {
  distro: string
  spawnShell(): HelperProcess
  launchScript(): Promise<string>
  /** Installs what the launch script said is missing. Throws `WslSetupError`. */
  install(report: NeedReport): Promise<void>
  /** `wsl.exe -d <distro> --exec true`, to boot a cold VM before a retry. */
  prewarm(): Promise<void>
  /** The envelope for a server that booted as `boot` says. */
  envelopeFor(boot: ServerBoot): ServerBootstrapEnvelope
  log?(message: string): void
  bootTimeoutMs?: number
  readyTimeoutMs?: number
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

/** How a server's process ended: its exit code, or the signal that ended it where the platform says so. */
export type WslServerExit = {
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
  intentional: boolean
}

export type RunningWslServer = {
  boot: ServerBoot
  ready: ServerReady
  envelope: ServerBootstrapEnvelope
  /** The lease: a heartbeat, so a sleeping PC's missed beat is noticed. */
  ping(): void
  /** Ask the server to drain and leave; resolves once the process has gone (killed after `budgetMs` and a grace). */
  stop(options: { drain: boolean; budgetMs: number }): Promise<void>
  /** Kill it now, without a drain. */
  kill(): void
  /**
   * Whether the server still answers: a ping, and its pong within
   * `timeoutMs`. False once the process has exited, or when it says nothing.
   */
  alive(timeoutMs: number): Promise<boolean>
  /** Whether the process has exited (its exit listeners may not have run yet). */
  exited(): boolean
  /** Fires once, when the process has exited for any reason. */
  onExit(listener: (exit: WslServerExit) => void): void
  stderrTail(): string
}

// A cold VM start is several seconds; a first start that also installs has
// its own deadlines inside `install`.
const DEFAULT_BOOT_TIMEOUT_MS = 45_000
const DEFAULT_READY_TIMEOUT_MS = 45_000
const DEFAULT_MAX_ATTEMPTS = 3
const BACKOFF_MS = [0, 1_000, 3_000, 8_000]
const STDERR_TAIL_BYTES = 4_096
const STOP_GRACE_MS = 2_000

type Frame = Record<string, unknown> & { t?: unknown }

/** The paths a WSL server keeps under the Linux home, by the profile it serves (decision R68). */
export function wslServerPaths(home: string, profile: { id: string; isDefault: boolean }) {
  if (!home.startsWith('/') || /[\0\n]/u.test(home)) throw new Error('The server reported no usable home directory.')
  const root = `${home.replace(/\/+$/u, '')}`
  const dataName = profile.isDefault ? 'data' : `data-${profile.id}`
  const dataDir = `${root}/${WSL_DATA_REL}/${dataName}`
  return {
    dataDir,
    runDir: `${dataDir}/run`,
    logsDir: `${root}/.local/state/sprintengine-studio/logs/${dataName}`,
    tempDir: `${dataDir}/tmp`,
  }
}

class Attempt {
  readonly frames: Frame[] = []
  private waiters: Array<() => void> = []
  stdoutText = ''
  // Raw: what `wsl.exe` says itself (no such distribution, the VM would not
  // start) is UTF-16LE, and what the server says is UTF-8. Decoded when read.
  private stderrBytes = Buffer.alloc(0)
  private stderrNote = ''
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  constructor(readonly process: HelperProcess) {
    let buffer = ''
    process.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (this.stdoutText.length < 64 * 1024) this.stdoutText += text
      buffer += text
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) {
          try {
            this.frames.push(JSON.parse(line) as Frame)
            // A running server answers a ping every fifteen seconds for as
            // long as it lives; only the newest few are ever looked at.
            if (this.frames.length > 64) this.frames.splice(0, this.frames.length - 64)
          } catch {
            // Not a frame.
          }
        }
        newline = buffer.indexOf('\n')
      }
      this.wake()
    })
    process.stderr.on('data', (chunk: Buffer) => {
      // An even tail, so UTF-16 stays aligned.
      const joined = Buffer.concat([this.stderrBytes, chunk])
      this.stderrBytes = joined.subarray(Math.max(0, joined.length - STDERR_TAIL_BYTES))
    })
    process.once('close', (code, signal) => {
      this.exit = { code, signal: signal ?? null }
      this.wake()
    })
    process.once('error', (error) => {
      this.stderrNote += error.message
      this.exit = { code: 127, signal: null }
      this.wake()
    })
  }
  /** The tail of stderr, as text whichever encoding it came in. */
  get stderr(): string {
    return `${decodeWslOutput(this.stderrBytes).replace(/[\0\r]/gu, '')}${this.stderrNote}`
  }
  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }
  /** The first frame `pick` accepts, or null once the process has exited or the deadline passed. */
  async next(pick: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame | 'exited' | 'timeout'> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.find(pick)
      if (found) {
        this.frames.splice(this.frames.indexOf(found), 1)
        return found
      }
      if (this.exit) return 'exited'
      const left = deadline - Date.now()
      if (left <= 0) return 'timeout'
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
}

function write(process: HelperProcess, frame: unknown): void {
  if (process.stdin.destroyed || !process.stdin.writable) return
  process.stdin.write(`${JSON.stringify(frame)}\n`)
}

/** Why a start that never said `ready` failed, from what it printed. */
function startFailure(attempt: Attempt, distro: string, stage: string): WslSetupError {
  const fatal = attempt.frames.find((frame) => frame.t === 'fatal')
  if (fatal && typeof fatal.message === 'string') {
    // The server's own words; a refused envelope or a busy data directory
    // will not pass on a retry.
    const code = typeof fatal.code === 'number' ? fatal.code : 70
    return new WslSetupError(`The Studio server in ${distro} did not start: ${fatal.message}`, {
      fatal: code !== 70 && code !== 75,
      code: 'start',
    })
  }
  const text = `${attempt.stderr}\n${attempt.stdoutText}`
  const classified = classifyWslFailure(text, attempt.exit?.code ?? null)
  if (classified.code !== 'start') return classified
  return new WslSetupError(
    `The Studio server in ${distro} did not start (${stage}): ${spokenLines(attempt.stderr).slice(-3).join(' ') || `exit ${attempt.exit?.code ?? 'unknown'}`}.`,
    { fatal: false, code: 'start' },
  )
}

/** Start the server, installing what is missing first. Throws a `WslSetupError` in words. */
export async function startWslServer(deps: WslServerStartDeps): Promise<RunningWslServer> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let installs = 0
  let lastError: WslSetupError | null = null
  for (let attemptNumber = 0; attemptNumber < maxAttempts + installs; attemptNumber++) {
    const backoff = BACKOFF_MS[Math.min(attemptNumber - installs, BACKOFF_MS.length - 1)] ?? 0
    if (lastError && backoff > 0) {
      await deps.prewarm().catch(() => undefined)
      await sleep(backoff)
    }
    const attempt = new Attempt(deps.spawnShell())
    attempt.process.stdin.write(`${await deps.launchScript()}\n`)
    const boot = await attempt.next((frame) => frame.t === 'boot', deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS)
    if (boot === 'exited' || boot === 'timeout') {
      const report = parseNeedReport(attempt.stdoutText)
      if (report && (report.node || report.app) && (attempt.exit?.code === NEEDS_INSTALL_EXIT || boot === 'exited')) {
        if (installs >= 2)
          throw new WslSetupError(`Couldn't set up WSL: ${deps.distro} still needs an install after two.`, {
            fatal: true,
            code: 'install',
          })
        deps.log?.(`Installing the Studio server into ${deps.distro}${report.node ? ', with Node.js' : ''}.`)
        await deps.install(report)
        installs++
        lastError = null
        continue
      }
      attempt.process.kill()
      lastError =
        boot === 'timeout'
          ? new WslSetupError(
              `The Studio server in ${deps.distro} did not say it had started within ${Math.round((deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS) / 1000)} s.`,
              { fatal: false, code: 'start' },
            )
          : startFailure(attempt, deps.distro, 'before it booted')
      if (lastError.fatal) throw lastError
      continue
    }
    const bootFrame = boot as unknown as ServerBoot
    let envelope: ServerBootstrapEnvelope
    try {
      envelope = deps.envelopeFor(bootFrame)
    } catch (error) {
      attempt.process.kill()
      // A `WslSetupError` says itself whether a retry can pass.
      if (error instanceof WslSetupError) {
        lastError = error
        if (error.fatal) throw error
        continue
      }
      throw new WslSetupError(
        `The Studio server in ${deps.distro} started somewhere it cannot be given a data directory: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true, code: 'start' },
      )
    }
    write(attempt.process, envelope)
    const ready = await attempt.next(
      (frame) => frame.t === 'ready' || frame.t === 'fatal',
      deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    )
    if (ready === 'exited' || ready === 'timeout' || (ready as Frame).t === 'fatal') {
      if (ready !== 'exited' && ready !== 'timeout') attempt.frames.push(ready as Frame)
      attempt.process.kill()
      lastError =
        ready === 'timeout'
          ? new WslSetupError(
              `The Studio server in ${deps.distro} did not become ready within ${Math.round((deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000)} s. ${spokenLines(attempt.stderr).slice(-2).join(' ')}`.trim(),
              { fatal: false, code: 'start' },
            )
          : startFailure(attempt, deps.distro, 'before it was ready')
      if (lastError.fatal) throw lastError
      continue
    }
    return running(attempt, bootFrame, ready as unknown as ServerReady, envelope)
  }
  throw (
    lastError ??
    new WslSetupError(`The Studio server in ${deps.distro} did not start.`, { fatal: false, code: 'start' })
  )
}

function running(
  attempt: Attempt,
  boot: ServerBoot,
  ready: ServerReady,
  envelope: ServerBootstrapEnvelope,
): RunningWslServer {
  let intentional = false
  let seq = 0
  let fired = false
  type ExitListener = (exit: WslServerExit) => void
  const exitListeners: ExitListener[] = []
  const exitOf = (): WslServerExit => ({
    code: attempt.exit?.code ?? null,
    signal: attempt.exit?.signal ?? null,
    stderrTail: attempt.stderr,
    intentional,
  })
  let settle: () => void = () => undefined
  const exited = new Promise<void>((resolve) => (settle = resolve))
  const fire = () => {
    if (fired) return
    fired = true
    settle()
    for (const listener of exitListeners.splice(0)) listener(exitOf())
  }
  if (attempt.exit) queueMicrotask(fire)
  else attempt.process.once('close', () => fire())
  return {
    boot,
    ready,
    envelope,
    ping() {
      write(attempt.process, { t: 'ping', seq: ++seq })
    },
    async alive(timeoutMs) {
      if (attempt.exit) return false
      const probe = ++seq
      write(attempt.process, { t: 'ping', seq: probe })
      const answer = await attempt.next((frame) => frame.t === 'pong' && frame.seq === probe, timeoutMs)
      return answer !== 'exited' && answer !== 'timeout'
    },
    exited: () => attempt.exit !== null,
    async stop({ drain, budgetMs }) {
      intentional = true
      if (attempt.exit) return
      write(attempt.process, { t: 'shutdown', drain, budgetMs })
      const timer = setTimeout(() => attempt.process.kill(), budgetMs + STOP_GRACE_MS)
      timer.unref?.()
      await exited
      clearTimeout(timer)
    },
    kill() {
      intentional = true
      attempt.process.kill()
    },
    onExit(listener) {
      if (fired) listener(exitOf())
      else exitListeners.push(listener)
    },
    stderrTail: () => attempt.stderr,
  }
}

// What a Node process prints that is not about why it ended: a warning or a
// deprecation from Node or a library (`(node:6993) [CODE] Warning: …`), and
// Node's hint after one.
const NODE_NOTICE = /^\(node:\d+\) /u
const NODE_HINT = /^\(Use `node --trace-/u
// A line that says something went wrong, as Node, a shell or the server say it.
const ERROR_LINE =
  /\w*(?:error|exception)\b|\b(?:fatal|panic|uncaught|unhandled|abort(?:ed)?|segmentation fault|out of memory|cannot|failed|killed)\b/iu

/** Stderr's lines, without blank ones and without the notices Node prints beside its work. */
function spokenLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NODE_NOTICE.test(line) && !NODE_HINT.test(line))
}

/** The last line of stderr that says what went wrong, or null when none does. */
export function lastErrorLine(stderr: string): string | null {
  const lines = spokenLines(stderr).filter((line) => ERROR_LINE.test(line))
  const last = lines.at(-1)
  return last ? (last.length > 300 ? `${last.slice(0, 300)}…` : last) : null
}

// The signals a shell (128 + n) or `wsl.exe` (n: WSL passes the number of
// the signal that ended the Linux process on as its own exit code, so a
// `kill -9` reads as exit 9) is read as having ended the server with. Only
// these: a small code is otherwise Node's own failure (1, 7), and the
// server's own codes are 0 and 64 and up.
const ENDING_SIGNALS = new Set(['SIGINT', 'SIGABRT', 'SIGKILL', 'SIGSEGV', 'SIGTERM'])

function endingSignal(number: number): string | null {
  for (const [name, value] of Object.entries(osConstants.signals))
    if (value === number && ENDING_SIGNALS.has(name)) return name
  return null
}

/**
 * How a server that was running ended, in words for its status: killed (by
 * a signal, as Node reports it or as the exit code carries it), or its exit
 * code with the last line that says what went wrong. Never the warnings it
 * printed while it worked.
 */
export function describeServerExit(exit: Pick<WslServerExit, 'code' | 'signal' | 'stderrTail'>): string {
  const code = exit.code
  const signal =
    exit.signal ??
    (code !== null && code > 128 ? endingSignal(code - 128) : null) ??
    (code !== null && code < 32 ? endingSignal(code) : null)
  if (signal) return signal === 'SIGKILL' ? 'killed' : `killed by ${signal}`
  const said = lastErrorLine(exit.stderrTail)
  const spoken = code === null ? 'no exit code' : `exit code ${code}`
  return said ? `${spoken}: ${said}` : spoken
}
