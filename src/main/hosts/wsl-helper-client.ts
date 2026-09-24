// Main's side of one distribution's helper: starting it, talking to it, and
// letting it go.
//
// The wire is newline-delimited JSON over the stdio of one `wsl.exe` process
// (`resources/wsl-helper/lib/frames.mjs` is the other end). It is app-internal
// and deliberately outside docs/compatibility.md: main always starts the helper
// copy it installed itself, so both ends are one build. A protocol integer that
// does not match is answered by killing the helper and starting it again from
// a fresh install, never by negotiating. Do not add a support window here.
//
// Starting (`start`):
//   1. `wsl.exe -d <distro> --cd ~ --exec sh -s` runs the launch script
//      (`wsl-install.ts`), which either `exec`s the helper or says what has to
//      be installed first. Installs run, and the launch is tried again.
//   2. The helper prints a `boot` line before it reads anything; only then is
//      the `hello` (protocol integer, app version, profile) written to its
//      stdin, so the shell that started it cannot have read part of it.
//   3. Its `hello` reply carries the paths main needs: its sockets, its Node,
//      the Linux home.
//   A transient failure (a VM still booting) is retried after a pre-warm, with
//   a backoff, a few times; a fatal one (no WSL, no network for Node) fails
//   the start at once with the reason, and is answered the same way for a
//   while rather than retried on every call.
//
// Lifetime: the helper is held while any WSL session on this machine lives
// (`retain`/`release`, keyed by session id so a double release is harmless)
// and while any request is in flight. About two minutes after the last of
// both, it is asked to shut down and then killed, so the WSL VM can idle. A
// helper that dies on its own is started again by the next thing that needs
// it, after a backoff that grows with each crash in a row.

import { createHash, randomBytes } from 'node:crypto'
import type { Duplex, Readable, Writable } from 'node:stream'

import { decodeWslOutput } from './wsl-distro'
import { WslSetupError } from './wsl-setup-error'
import { NEEDS_INSTALL_EXIT, parseNeedReport, type NeedReport } from './wsl-install'

/** Must equal `PROTOCOL_VERSION` in `resources/wsl-helper/lib/frames.mjs`. */
export const WSL_HELPER_PROTOCOL = 2

export type WslHelperInfo = {
  uid: number
  /** The app profile this helper serves; its sockets and plugin copy are this profile's own. */
  profile: string
  home: string
  arch: string
  nodePath: string
  appDir: string
  agentSocket: string
  mcpSocket: string
  /** The Linux directory the MCP bridge reads its discovery file from. */
  userDataDir: string
  /** Where each session's startup script records its shell's pid; private to this user. */
  pidDir: string
  /** Where each launch's startup script and host-context file are written; private to this user. */
  sessionDir: string
}

export type HelperProcess = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  pid?: number
  kill(): void
  /** After the process exited and its pipes closed, so all of its output has been read. */
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type WslHelperEvent = { event: 'agentState'; line: string } | { event: 'pathsChanged' }

export type WslHelperClientDeps = {
  distro: string
  appVersion: string
  profile: string
  /** `wsl.exe -d <distro> --cd ~ --exec sh -s`, all three pipes open. */
  spawnShell(): HelperProcess
  launchScript(): Promise<string>
  /** Installs what the launch script said is missing. Throws `WslSetupError`. */
  install(report: NeedReport): Promise<void>
  /** `wsl.exe -d <distro> --exec true`, to boot a cold VM before a retry. */
  prewarm(): Promise<void>
  /** Drops the install markers, so the next start installs again. */
  unready(what: { node: boolean; app: boolean }): Promise<void>
  onEvent(event: WslHelperEvent): void
  /** The automation server's own socket, which is the only thing an MCP channel may reach. */
  connectAutomation(): Duplex
  log?(message: string): void
  idleMs?: number
  bootTimeoutMs?: number
  helloTimeoutMs?: number
  maxAttempts?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type WslHelperState = 'stopped' | 'starting' | 'ready' | 'stopping'

const DEFAULT_IDLE_MS = 120_000
// A cold VM start is several seconds; a first start that also installs has
// its own deadlines inside `install`.
const DEFAULT_BOOT_TIMEOUT_MS = 45_000
const DEFAULT_HELLO_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 4
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
// A fatal answer is given again, without trying, for this long.
const FATAL_HOLD_MS = 30_000
const STOP_GRACE_MS = 3_000
const MAX_CHANNELS = 64
const MAX_HELPER_LINE_BYTES = 64 * 1024 * 1024

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

type Running = {
  process: HelperProcess
  info: WslHelperInfo
  intentional: boolean
  dead: boolean
  startedAt: number
  exited: Promise<void>
}

// A helper that ran this long before it died counts as a fresh first crash,
// not one more in a row.
const HEALTHY_RUN_MS = 5 * 60_000
// A helper that keeps dying as soon as it starts is not restarted on its own
// past this many times in a row; the next launch reports it instead.
const MAX_AUTO_RESTARTS = 5

function backoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
}

/** What `wsl.exe` printed when it failed, classified. */
export function classifyWslFailure(text: string, code: number | null): WslSetupError {
  const flat = text.replace(/\0/g, '').replace(/\s+/gu, ' ').trim()
  if (/WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name|has no installed distributions/iu.test(flat)) {
    return new WslSetupError(`Couldn't set up WSL: this distribution is not installed. ${flat}`.trim(), {
      fatal: true,
      code: 'distro-missing',
    })
  }
  if (
    /WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|Subsystem for Linux (has not been|is not) (enabled|installed)/iu.test(flat)
  ) {
    return new WslSetupError(
      'Couldn\'t set up WSL: WSL is not installed on this PC. Install it with "wsl --install".',
      {
        fatal: true,
        code: 'wsl-missing',
      },
    )
  }
  // Exec failures from the launch script's final line: the pinned Node could
  // not run (a missing glibc, the wrong architecture).
  if (code === 126 || code === 127 || /GLIBC_|cannot execute|Exec format error/iu.test(flat)) {
    return new WslSetupError(
      `Couldn't set up WSL: Node.js does not run in this distribution (${flat || `exit ${code}`}). ` +
        'The helper needs glibc 2.28 or later.',
      { fatal: true, code: 'node-run' },
    )
  }
  return new WslSetupError(`The WSL helper did not start (${flat || `exit ${code ?? 'unknown'}`}).`, {
    fatal: false,
    code: 'start',
  })
}

/** A directory the helper watches for main; `close` stops it. */
export type WslDirWatch = { close(): void }

export type WslHelperClient = {
  readonly distro: string
  state(): WslHelperState
  /** The running helper's paths, or null when it is not running. */
  info(): WslHelperInfo | null
  /** The last fatal reason, while it still stands. */
  lastError(): WslSetupError | null
  start(): Promise<WslHelperInfo>
  request<T>(method: string, params?: unknown, options?: { timeoutMs?: number | null }): Promise<T>
  /**
   * `request`, but only while the helper runs: a stopped helper is not started
   * for it, and the answer is null. For tidying that can wait.
   */
  requestIfRunning<T>(method: string, params?: unknown): Promise<T | null>
  retain(sessionId: string): void
  release(sessionId: string): void
  /**
   * A new token for one launch's MCP bridge. Only a channel that opens with a
   * token issued here, and not yet revoked, is connected to the automation
   * server. Revoke it when the launch's session ends.
   */
  issueChannelToken(): string
  revokeChannelToken(token: string): void
  /**
   * Watches a Linux directory inside the distribution. Registered with the
   * running helper, and again with each helper started after it; a watch never
   * starts the helper itself. `onError` is called once when the directory
   * cannot be watched, after which the watch is dead.
   */
  watch(path: string, recursive: boolean, listener: (filename: string | null) => void, onError: () => void): WslDirWatch
  /** Stops the helper for good: the app is quitting, so every session it launched there is ended too. */
  shutdown(): Promise<void>
}

export function createWslHelperClient(deps: WslHelperClientDeps): WslHelperClient {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS
  const bootTimeoutMs = deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  const helloTimeoutMs = deps.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const log = deps.log ?? (() => undefined)

  let state: WslHelperState = 'stopped'
  let running: Running | null = null
  let starting: Promise<WslHelperInfo> | null = null
  let crashes = 0
  let lastCrashAt = 0
  let fatal: { error: WslSetupError; at: number } | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()
  const sessions = new Set<string>()
  const channels = new Map<number, Duplex>()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // Held as digests, so a lookup never compares a guess with a real token.
  const channelTokens = new Set<string>()
  // Whether this client has had a helper up before: the first one is told to
  // end what an earlier main left running in the distribution.
  let startedBefore = false
  type WatchEntry = {
    path: string
    recursive: boolean
    listener: (filename: string | null) => void
    onError: () => void
    remote: number | null
    closed: boolean
  }
  const watches = new Set<WatchEntry>()
  const watchesByRemote = new Map<number, WatchEntry>()

  function write(frame: unknown): void {
    const target = running?.process.stdin
    if (!target || target.destroyed || !target.writable) return
    target.write(`${JSON.stringify(frame)}\n`)
  }

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  function armIdle(): void {
    clearIdle()
    if (state !== 'ready' || sessions.size > 0 || pending.size > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (state === 'ready' && sessions.size === 0 && pending.size === 0) {
        log(`Stopping the WSL helper for ${deps.distro}: nothing has used it for ${Math.round(idleMs / 1000)} s.`)
        void stop()
      }
    }, idleMs)
    idleTimer.unref?.()
  }

  function closeChannel(id: number, notifyHelper: boolean): void {
    const socket = channels.get(id)
    if (!socket) return
    channels.delete(id)
    if (notifyHelper) write({ t: 'ch', ch: id, op: 'close' })
    socket.destroy()
  }

  function handleChannel(frame: { ch?: unknown; op?: unknown; b64?: unknown; token?: unknown }): void {
    const id = frame.ch
    if (typeof id !== 'number' || !Number.isInteger(id)) return
    if (frame.op === 'open') {
      // The automation server can start a shell on this PC; only a bridge
      // started by one of this app's own live launches is connected to it.
      const authorised = typeof frame.token === 'string' && channelTokens.has(tokenDigest(frame.token))
      if (!authorised || channels.has(id) || channels.size >= MAX_CHANNELS) {
        if (!authorised) log(`Refused an MCP channel from the WSL helper for ${deps.distro}: no valid launch token.`)
        write({ t: 'ch', ch: id, op: 'close' })
        return
      }
      let socket: Duplex
      try {
        socket = deps.connectAutomation()
      } catch {
        write({ t: 'ch', ch: id, op: 'close' })
        return
      }
      channels.set(id, socket)
      socket.on('data', (chunk: Buffer) => write({ t: 'ch', ch: id, op: 'data', b64: chunk.toString('base64') }))
      // Half-closes cross in both directions, so replies already in flight
      // still arrive after one side has finished writing.
      socket.on('end', () => {
        if (channels.get(id) === socket) write({ t: 'ch', ch: id, op: 'end' })
      })
      socket.on('close', () => closeChannel(id, true))
      socket.on('error', () => closeChannel(id, true))
      return
    }
    const socket = channels.get(id)
    if (!socket) return
    if (frame.op === 'data' && typeof frame.b64 === 'string') socket.write(Buffer.from(frame.b64, 'base64'))
    else if (frame.op === 'end') socket.end()
    else if (frame.op === 'close') {
      channels.delete(id)
      socket.end()
    }
  }

  function handleFrame(frame: Record<string, unknown>): void {
    if (frame.t === 'res' && typeof frame.id === 'number') {
      const entry = pending.get(frame.id)
      if (!entry) return
      pending.delete(frame.id)
      if (entry.timer) clearTimeout(entry.timer)
      const error = frame.error as { message?: unknown } | undefined
      if (error) entry.reject(new Error(typeof error.message === 'string' ? error.message : 'The WSL helper failed.'))
      else entry.resolve(frame.result)
      armIdle()
    } else if (frame.t === 'ev') {
      if (frame.event === 'agentState' && typeof frame.line === 'string') {
        deps.onEvent({ event: 'agentState', line: frame.line })
      } else if (frame.event === 'pathsChanged') {
        deps.onEvent({ event: 'pathsChanged' })
      } else if (frame.event === 'watch' && typeof frame.id === 'number') {
        const entry = watchesByRemote.get(frame.id)
        if (entry && !entry.closed) entry.listener(typeof frame.filename === 'string' ? frame.filename : null)
      } else if (frame.event === 'watchError' && typeof frame.id === 'number') {
        const entry = watchesByRemote.get(frame.id)
        if (entry) failWatch(entry)
      }
    } else if (frame.t === 'ch') {
      handleChannel(frame)
    }
  }

  function onExit(entry: Running): void {
    if (running !== entry) return
    running = null
    const wasIntentional = entry.intentional
    // A start already waiting on this exit keeps its own state.
    if (state !== 'starting') state = 'stopped'
    clearIdle()
    for (const [id, item] of pending) {
      if (item.timer) clearTimeout(item.timer)
      item.reject(new WslSetupError(`The WSL helper for ${deps.distro} stopped.`, { fatal: false, code: 'stopped' }))
      pending.delete(id)
    }
    for (const id of [...channels.keys()]) closeChannel(id, false)
    // The helper's watches went with it; each is registered again with the
    // next helper that starts.
    watchesByRemote.clear()
    for (const entry of watches) entry.remote = null
    if (!wasIntentional) {
      crashes = now() - entry.startedAt > HEALTHY_RUN_MS ? 1 : crashes + 1
      lastCrashAt = now()
      log(`The WSL helper for ${deps.distro} exited on its own (${crashes} in a row).`)
      // Sessions still run there, and their hooks and MCP bridges need the
      // helper's sockets: start it again, after the backoff, rather than
      // waiting for something to ask.
      if (crashes >= MAX_AUTO_RESTARTS) {
        fatal = {
          error: new WslSetupError(
            `Couldn't set up WSL: the helper for ${deps.distro} stopped ${crashes} times in a row.`,
            { fatal: true, code: 'start' },
          ),
          at: now(),
        }
      } else if (sessions.size > 0) {
        const retry = setTimeout(() => {
          if (sessions.size > 0 && state === 'stopped') void start().catch(() => undefined)
        }, backoffMs(crashes))
        retry.unref?.()
      }
    }
  }

  // One launch of the script and the helper behind it. Resolves once the
  // helper answered its hello; rejects with a classified `WslSetupError`, or
  // with `{ needs }` when the script asked for an install first.
  function launchOnce(script: string): Promise<{ running: Running } | { needs: NeedReport }> {
    return new Promise((resolve, reject) => {
      let child: HelperProcess
      try {
        child = deps.spawnShell()
      } catch (error) {
        reject(
          new WslSetupError(
            `Couldn't set up WSL: wsl.exe could not be started (${error instanceof Error ? error.message : String(error)}).`,
            { fatal: true, code: 'wsl-missing' },
          ),
        )
        return
      }
      let settled = false
      let booted = false
      let helloSent = false
      let helloTimer: ReturnType<typeof setTimeout> | null = null
      const stdoutText: Buffer[] = []
      const stderrText: Buffer[] = []
      let lineBuffer: Buffer = Buffer.alloc(0)
      let resolveExited: () => void = () => undefined
      const exited = new Promise<void>((done) => {
        resolveExited = done
      })
      const entry: Running = {
        process: child,
        info: null as unknown as WslHelperInfo,
        intentional: false,
        dead: false,
        startedAt: now(),
        exited,
      }
      const fail = (error: WslSetupError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.intentional = true
        try {
          child.kill()
        } catch {
          // Already gone.
        }
        reject(error)
      }
      const timer = setTimeout(() => {
        fail(
          new WslSetupError(
            booted
              ? `The WSL helper for ${deps.distro} did not answer its handshake.`
              : `WSL did not start the helper for ${deps.distro} in time.`,
            { fatal: false, code: 'start' },
          ),
        )
      }, bootTimeoutMs)
      timer.unref?.()

      const onLine = (line: string) => {
        let frame: Record<string, unknown> | null = null
        try {
          const parsed: unknown = JSON.parse(line)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>
        } catch {
          frame = null
        }
        if (!frame) return
        if (settled) {
          handleFrame(frame)
          return
        }
        if (frame.t === 'boot' && !booted) {
          booted = true
          if (frame.protocol !== WSL_HELPER_PROTOCOL) {
            fail(
              new WslSetupError(
                `The WSL helper speaks protocol ${String(frame.protocol)}, not ${WSL_HELPER_PROTOCOL}.`,
                {
                  fatal: false,
                  code: 'protocol',
                },
              ),
            )
            return
          }
          helloSent = true
          clearTimeout(timer)
          helloTimer = setTimeout(() => {
            fail(
              new WslSetupError(`The WSL helper for ${deps.distro} did not answer its handshake.`, {
                fatal: false,
                code: 'start',
              }),
            )
          }, helloTimeoutMs)
          helloTimer.unref?.()
          child.stdin.write(
            `${JSON.stringify({
              t: 'hello',
              protocol: WSL_HELPER_PROTOCOL,
              appVersion: deps.appVersion,
              profile: deps.profile,
              endOrphans: !startedBefore,
            })}\n`,
          )
          return
        }
        if (frame.t === 'hello' && helloSent) {
          if (helloTimer) clearTimeout(helloTimer)
          if (frame.protocol !== WSL_HELPER_PROTOCOL) {
            fail(
              new WslSetupError(
                `The WSL helper speaks protocol ${String(frame.protocol)}, not ${WSL_HELPER_PROTOCOL}.`,
                {
                  fatal: false,
                  code: 'protocol',
                },
              ),
            )
            return
          }
          if (frame.ok !== true || !frame.info || typeof frame.info !== 'object') {
            fail(
              new WslSetupError(
                `Couldn't set up WSL: the helper could not start (${String(frame.error ?? 'no reason')}).`,
                {
                  fatal: true,
                  code: 'start',
                },
              ),
            )
            return
          }
          settled = true
          entry.info = frame.info as WslHelperInfo
          resolve({ running: entry })
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        if (!booted && stdoutText.length < 64) stdoutText.push(chunk)
        lineBuffer = lineBuffer.length ? Buffer.concat([lineBuffer, chunk]) : chunk
        let newline = lineBuffer.indexOf(0x0a)
        while (newline !== -1) {
          const line = lineBuffer.subarray(0, newline).toString('utf8').replace(/\r$/u, '')
          lineBuffer = lineBuffer.subarray(newline + 1)
          if (line.trim()) onLine(line)
          newline = lineBuffer.indexOf(0x0a)
        }
        if (lineBuffer.length > MAX_HELPER_LINE_BYTES) {
          log(`The WSL helper for ${deps.distro} sent an over-long line; stopping it.`)
          entry.intentional = false
          child.kill()
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrText.length < 64) stderrText.push(chunk)
      })
      child.once('error', (error: Error) => {
        fail(
          new WslSetupError(`Couldn't set up WSL: wsl.exe could not be started (${error.message}).`, {
            fatal: true,
            code: 'wsl-missing',
          }),
        )
      })
      child.once('close', (code) => {
        entry.dead = true
        resolveExited()
        if (helloTimer) clearTimeout(helloTimer)
        if (settled) {
          onExit(entry)
          return
        }
        settled = true
        clearTimeout(timer)
        const stdout = decodeWslOutput(Buffer.concat(stdoutText))
        const stderr = decodeWslOutput(Buffer.concat(stderrText))
        const needs = code === NEEDS_INSTALL_EXIT ? parseNeedReport(stdout) : null
        if (needs) {
          resolve({ needs })
          return
        }
        reject(classifyWslFailure(`${stderr}\n${booted ? '' : stdout}`, code))
      })
      // The script, and nothing after it until the helper says `boot`.
      child.stdin.write(script.endsWith('\n') ? script : `${script}\n`)
    })
  }

  async function attemptStart(): Promise<Running> {
    let installed = false
    let relaunchedForProtocol = false
    for (;;) {
      const script = await deps.launchScript()
      let outcome: { running: Running } | { needs: NeedReport }
      try {
        outcome = await launchOnce(script)
      } catch (error) {
        if (error instanceof WslSetupError && error.code === 'protocol' && !relaunchedForProtocol) {
          // The installed copy is not the one this build expects: kill it (done
          // above), drop its markers, install again, and relaunch once.
          relaunchedForProtocol = true
          log(`Reinstalling the WSL helper for ${deps.distro}: ${error.message}`)
          await deps.unready({ node: false, app: true }).catch(() => undefined)
          continue
        }
        if (error instanceof WslSetupError && error.code === 'node-run') {
          // A Node that is marked ready but will not run is installed again
          // next time rather than trusted forever.
          await deps.unready({ node: true, app: false }).catch(() => undefined)
        }
        throw error
      }
      if ('running' in outcome) return outcome.running
      if (installed) {
        throw new WslSetupError(
          `Couldn't set up WSL: the helper was installed into ${deps.distro} but is still reported missing.`,
          { fatal: true, code: 'install' },
        )
      }
      await deps.install(outcome.needs)
      installed = true
    }
  }

  async function startFresh(): Promise<WslHelperInfo> {
    if (fatal && now() - fatal.at < FATAL_HOLD_MS) throw fatal.error
    const wait = backoffMs(crashes) - (now() - lastCrashAt)
    if (crashes > 0 && wait > 0) await sleep(wait)
    let lastError: WslSetupError | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const entry = await attemptStart()
        if (entry.dead) {
          throw new WslSetupError(`The WSL helper for ${deps.distro} exited as it started.`, {
            fatal: false,
            code: 'start',
          })
        }
        running = entry
        state = 'ready'
        fatal = null
        startedBefore = true
        // Deliberately not reset: `crashes` counts exits in a row, and a helper
        // that starts and then dies again at once should back off further.
        armIdle()
        for (const watch of watches) registerWatch(watch)
        return entry.info
      } catch (error) {
        const setupError =
          error instanceof WslSetupError
            ? error
            : new WslSetupError(`Couldn't set up WSL: ${error instanceof Error ? error.message : String(error)}`, {
                fatal: true,
                code: 'install',
              })
        lastError = setupError
        if (setupError.fatal) break
        log(`Starting the WSL helper for ${deps.distro} failed (attempt ${attempt}): ${setupError.message}`)
        if (attempt < maxAttempts) {
          await deps.prewarm().catch(() => undefined)
          await sleep(backoffMs(attempt))
        }
      }
    }
    const final =
      lastError && lastError.fatal
        ? lastError
        : new WslSetupError(
            `Couldn't set up WSL: ${deps.distro} did not start the helper after ${maxAttempts} tries. ${lastError?.message ?? ''}`.trim(),
            { fatal: true, code: 'start' },
          )
    fatal = { error: final, at: now() }
    throw final
  }

  function start(): Promise<WslHelperInfo> {
    clearIdle()
    if (state === 'ready' && running) {
      armIdle()
      return Promise.resolve(running.info)
    }
    if (starting) return starting
    // A helper still shutting down is let go first: the new one listens on
    // the same socket paths.
    const leaving = state === 'stopping' ? running : null
    state = 'starting'
    const attempt = leaving ? leaving.exited.then(() => startFresh()) : startFresh()
    starting = attempt
    void attempt
      .catch(() => {
        state = 'stopped'
      })
      .finally(() => {
        if (starting === attempt) starting = null
      })
    return attempt
  }

  async function request<T>(method: string, params?: unknown, options: { timeoutMs?: number | null } = {}): Promise<T> {
    await start()
    const current = running
    if (!current)
      throw new WslSetupError(`The WSL helper for ${deps.distro} is not running.`, { fatal: false, code: 'stopped' })
    clearIdle()
    const id = nextId
    nextId += 1
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              if (!pending.delete(id)) return
              reject(new Error(`The WSL helper did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`))
              armIdle()
            }, timeoutMs)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      write({ t: 'req', id, method, params: params ?? {} })
    })
  }

  async function requestIfRunning<T>(method: string, params?: unknown): Promise<T | null> {
    if (state !== 'ready' || !running) return null
    return request<T>(method, params)
  }

  function failWatch(entry: WatchEntry): void {
    if (entry.closed) return
    entry.closed = true
    watches.delete(entry)
    if (entry.remote !== null) watchesByRemote.delete(entry.remote)
    entry.remote = null
    entry.onError()
  }

  // Registers a watch with the helper that runs now, if one does. A helper
  // that stops takes its watches with it, and the next one to start is given
  // them again (`startFresh`).
  function registerWatch(entry: WatchEntry): void {
    const at = running
    if (state !== 'ready' || !at || entry.closed || entry.remote !== null) return
    void request<{ id: number }>('watch.add', { path: entry.path, recursive: entry.recursive }).then(
      (answer) => {
        if (running !== at) return
        if (entry.closed) {
          void requestIfRunning('watch.remove', { id: answer.id }).catch(() => undefined)
          return
        }
        entry.remote = answer.id
        watchesByRemote.set(answer.id, entry)
      },
      () => {
        // Only a refusal from the helper that registered it is the watch's
        // failure; a helper that stopped meanwhile is registered with again.
        if (running === at) failWatch(entry)
      },
    )
  }

  // `endSessions` is for the app quitting: the helper then also ends every
  // session the app launched in the distribution. An idle stop leaves them.
  async function stop(options: { endSessions: boolean } = { endSessions: false }): Promise<void> {
    const entry = running
    if (!entry) return
    state = 'stopping'
    entry.intentional = true
    clearIdle()
    try {
      entry.process.stdin.write(`${JSON.stringify({ t: 'shutdown', endSessions: options.endSessions })}\n`)
      entry.process.stdin.end()
    } catch {
      // The pipe is already gone, which ends the helper too.
    }
    const timer = new Promise<'timeout'>((resolve) => {
      const handle = setTimeout(() => resolve('timeout'), STOP_GRACE_MS)
      handle.unref?.()
    })
    if ((await Promise.race([entry.exited.then(() => 'exited' as const), timer])) === 'timeout') {
      try {
        entry.process.kill()
      } catch {
        // Gone.
      }
    }
  }

  return {
    distro: deps.distro,
    state: () => state,
    info: () => (state === 'ready' && running ? running.info : null),
    lastError: () => (fatal && now() - fatal.at < FATAL_HOLD_MS ? fatal.error : null),
    start,
    request,
    retain(sessionId) {
      sessions.add(sessionId)
      clearIdle()
    },
    release(sessionId) {
      if (!sessions.delete(sessionId)) return
      armIdle()
    },
    requestIfRunning,
    issueChannelToken() {
      const token = randomBytes(32).toString('base64url')
      channelTokens.add(tokenDigest(token))
      return token
    },
    revokeChannelToken(token) {
      channelTokens.delete(tokenDigest(token))
    },
    watch(path, recursive, listener, onError) {
      const entry: WatchEntry = { path, recursive, listener, onError, remote: null, closed: false }
      watches.add(entry)
      registerWatch(entry)
      return {
        close() {
          if (entry.closed) return
          entry.closed = true
          watches.delete(entry)
          const remote = entry.remote
          entry.remote = null
          if (remote !== null) {
            watchesByRemote.delete(remote)
            void requestIfRunning('watch.remove', { id: remote }).catch(() => undefined)
          }
        },
      }
    },
    async shutdown() {
      sessions.clear()
      channelTokens.clear()
      await starting?.catch(() => undefined)
      await stop({ endSessions: true })
    },
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A short random id for a staging directory. */
export function stageId(): string {
  return randomBytes(6).toString('hex')
}
