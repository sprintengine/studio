import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { processIsRunning } from '../platform/process-alive'
import { ensurePrivateDirectory } from '../rpc/studio-rpc-listener'
import type { ServerBootstrapEnvelope } from './envelope'
import { readHostId, readServerRecordFile } from './server-record'

// `studio-server start --detach`: how an SSH session starts a managed server
// that outlives it (phase 8 spec, 5.7; decision R32).
//
// The connect session runs this from the installed tree with its stdin on
// /dev/null, so nothing it reads can be a person's secret, and nothing a
// client writes can reach it before the script has asked. It:
//
//   1. takes the run directory's start lock, so two desktops connecting at
//      once start one server, not two that fight over the owner token;
//   2. finds a running server through the data directory's run lock: one on
//      this machine is reported, not replaced, unless `--replace` (an
//      upgrade) asks it to drain and leave first; one whose lock names
//      another machine (a home shared over NFS) is refused in words;
//   3. mints a fresh owner token into `run/owner-token` (0600 in the 0700 run
//      directory). The token never leaves this machine: the relay reads it to
//      prove itself on the server's front door, and the server holds only its
//      hash (decision R22);
//   4. forks the server detached (its own session, so the SSH session ending
//      is not its end; Node's `detached` needs no `setsid` binary, which
//      macOS lacks), its stderr to a log, hands it the envelope over a pipe
//      once it says `boot`, and waits for `ready`;
//   5. prints `@@SPRINTENGINE_READY <record>` and leaves; the server writes
//      `run/server.json` itself and removes it when it stops.
//
// Every failure is one `@@SPRINTENGINE_FAIL <code> <words>` line.

export const READY_MARKER = '@@SPRINTENGINE_READY'
const FAIL_MARKER = '@@SPRINTENGINE_FAIL'

const START_LOCK_STALE_MS = 120_000
const START_LOCK_WAIT_MS = 90_000
const BOOT_TIMEOUT_MS = 30_000
const READY_TIMEOUT_MS = 45_000
/** An upgrade's drain: the turns a person left running get this long, then the old server is made to go. */
const REPLACE_DRAIN_MS = 60_000
const REPLACE_KILL_GRACE_MS = 10_000

export type DetachedStartOptions = {
  dataDir: string
  logsDir: string
  idleMs: number | null
  startedBy: string
  replace: boolean
  channel: 'latest' | 'nightly'
  /** This bundle: the server's entry, the Node it runs on, and the tree it sits in. */
  entry: string
  execPath: string
  appDir: string
  version: string
  print(line: string): void
  isRunning?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

export class DetachedStartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type LockHolder = { pid: number; hostname: string }

function readRunLock(runDir: string): LockHolder | null {
  try {
    const body = JSON.parse(readFileSync(join(runDir, 'studio.lock'), 'utf8')) as Partial<LockHolder>
    return typeof body.pid === 'number' && typeof body.hostname === 'string'
      ? { pid: body.pid, hostname: body.hostname }
      : null
  } catch {
    return null
  }
}

const readRecord = readServerRecordFile

/** The start lock: a directory, so it is atomic on any file system; reclaimed from a dead or stuck starter. */
async function takeStartLock(
  runDir: string,
  isRunning: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<() => void> {
  const path = join(runDir, 'start.lock')
  const deadline = Date.now() + START_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      writeFileSync(join(path, 'pid'), `${process.pid}\n`)
      return () => rmSync(path, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let stale = false
    try {
      const pid = Number.parseInt(readFileSync(join(path, 'pid'), 'utf8'), 10)
      stale = Number.isInteger(pid) ? !isRunning(pid) : Date.now() - statSync(path).mtimeMs > 10_000
      if (Date.now() - statSync(path).mtimeMs > START_LOCK_STALE_MS) stale = true
    } catch {
      stale = true
    }
    if (stale) {
      const aside = `${path}.stale-${process.pid}`
      try {
        renameSync(path, aside)
        rmSync(aside, { recursive: true, force: true })
      } catch {
        // Another starter reclaimed it first.
      }
      continue
    }
    if (Date.now() > deadline)
      throw new DetachedStartError('busy', 'Another start of the Studio server here has not finished.')
    await sleep(250)
  }
}

/** Ask a running server to drain and leave, and wait for it; made to go if it does not. */
async function replaceServer(
  pid: number,
  isRunning: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const until = Date.now() + REPLACE_DRAIN_MS + REPLACE_KILL_GRACE_MS
  while (Date.now() < until) {
    if (!isRunning(pid)) return
    await sleep(250)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone meanwhile.
  }
  for (let waited = 0; waited < 5_000 && isRunning(pid); waited += 250) await sleep(250)
  if (isRunning(pid))
    throw new DetachedStartError('replace', `The old Studio server (pid ${pid}) did not stop, so it was not replaced.`)
}

function envelopeFor(options: DetachedStartOptions, tokenHash: string): ServerBootstrapEnvelope {
  const runDir = join(options.dataDir, 'run')
  return {
    v: 1,
    role: 'headless',
    dataDir: options.dataDir,
    logsDir: options.logsDir,
    runDir,
    tempDir: join(options.dataDir, 'tmp'),
    paths: {
      resourcesDir: join(options.appDir, 'resources'),
      appPath: options.appDir,
      isPackaged: true,
      appExecPath: options.execPath,
    },
    app: { version: options.version, buildStamp: '', channel: options.channel },
    owner: { tokenHash },
    // The front door's bridge socket only: an SSH machine's server listens on
    // no TCP port at all (phase 8 spec, 1.5).
    listeners: { gateway: true, tailnet: 'off', frontDoor: { loopback: false } },
    secrets: { kind: 'key-file' },
    flags: {},
    detached: { idleMs: options.idleMs, origin: 'bootstrap', startedBy: options.startedBy },
  }
}

/** The JSON frames a stream says, line by line, until one `pick` accepts or the deadline passes. */
function nextFrame(
  stream: NodeJS.ReadableStream,
  pick: (frame: Record<string, unknown>) => boolean,
  timeoutMs: number,
  exited: () => boolean,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buffer = ''
    const done = (frame: Record<string, unknown> | null) => {
      clearTimeout(timer)
      clearInterval(poll)
      stream.off('data', onData)
      resolve(frame)
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('{')) {
          try {
            const frame = JSON.parse(line) as Record<string, unknown>
            if (pick(frame)) {
              done(frame)
              return
            }
          } catch {
            // Not a frame.
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    const poll = setInterval(() => exited() && done(null), 100)
    stream.on('data', onData)
  })
}

function logTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-3).join(' ').slice(-600)
  } catch {
    return ''
  }
}

/** Start (or find) the server; resolves to the process's exit code once the outcome is printed. */
export async function startDetached(options: DetachedStartOptions): Promise<number> {
  const isRunning = options.isRunning ?? processIsRunning
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const fail = (code: string, message: string): number => {
    options.print(`${FAIL_MARKER} ${code} ${message.replace(/\s+/gu, ' ')}`)
    return 1
  }
  const runDir = join(options.dataDir, 'run')
  let release: (() => void) | null = null
  try {
    ensurePrivateDirectory(options.dataDir)
    ensurePrivateDirectory(runDir)
    mkdirSync(options.logsDir, { recursive: true, mode: 0o700 })
    release = await takeStartLock(runDir, isRunning, sleep)

    const holder = readRunLock(runDir)
    if (holder && holder.pid > 0) {
      // Another machine on a home shared over NFS: its machine id and its
      // host name both differ (a Mac's host name alone moves with the
      // network). Its pid means nothing here, so it is never signalled.
      const record = readRecord(runDir)
      if (record && record.hostId !== readHostId() && holder.hostname !== hostname())
        return fail(
          'other-host',
          `A Studio server is already running for this home on ${holder.hostname}. One server serves one home; give this machine its own data directory to run another.`,
        )
      if (isRunning(holder.pid)) {
        if (!options.replace) {
          options.print(`${READY_MARKER} ${JSON.stringify({ attached: true, record: readRecord(runDir) })}`)
          return 0
        }
        await replaceServer(holder.pid, isRunning, sleep)
      }
    }

    const token = randomBytes(32).toString('base64url')
    const tokenPath = join(runDir, 'owner-token')
    const stagedToken = `${tokenPath}.${process.pid}`
    writeFileSync(stagedToken, `${token}\n`, { mode: 0o600, flag: 'w' })
    renameSync(stagedToken, tokenPath)
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')

    const logPath = join(options.logsDir, `server-${new Date().toISOString().slice(0, 10)}.log`)
    const logFd = openSync(logPath, 'a', 0o600)
    const child = spawn(options.execPath, [options.entry, '--bootstrap', 'stdio'], {
      detached: true,
      cwd: options.dataDir,
      stdio: ['pipe', 'pipe', logFd],
    })
    closeSync(logFd)
    const stdin = child.stdin!
    const stdout = child.stdout!
    let exited = false
    child.once('exit', () => (exited = true))
    stdin.on('error', () => undefined)

    const boot = await nextFrame(
      stdout,
      (frame) => frame.t === 'boot',
      BOOT_TIMEOUT_MS,
      () => exited,
    )
    if (!boot) {
      child.kill('SIGKILL')
      return fail('start', `The Studio server did not start. ${logTail(logPath)}`)
    }
    stdin.write(`${JSON.stringify(envelopeFor(options, tokenHash))}\n`)
    const ready = await nextFrame(
      stdout,
      (frame) => frame.t === 'ready' || frame.t === 'fatal',
      READY_TIMEOUT_MS,
      () => exited,
    )
    if (!ready || ready.t !== 'ready') {
      child.kill('SIGKILL')
      const said = ready && typeof ready.message === 'string' ? ready.message : logTail(logPath)
      return fail('start', `The Studio server did not become ready. ${said}`)
    }
    // Let it go: the server's own session, nothing of ours holding it.
    stdout.destroy()
    stdin.end()
    child.unref()
    options.print(`${READY_MARKER} ${JSON.stringify({ attached: false, record: readRecord(runDir) })}`)
    return 0
  } catch (error) {
    return fail(
      error instanceof DetachedStartError ? error.code : 'start',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    release?.()
  }
}
