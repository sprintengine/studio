import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// Signing a chat's CLI in on the server's own machine, with no terminal
// (decision R34; phase 8): the CLI's own login runs here as a plain child,
// and what it prints is read for the link to open, the one-time code to type
// there, and whether it waits for a code pasted back. The client shows that
// in a dialog, opens the link in its own browser, sends a pasted code back,
// and hears when the login has finished.
//
// Each flow was read from the CLI's own output with no terminal attached:
//
//   codex login --device-auth   a link and a one-time code; finishes on its own
//   cursor-agent login          a link (NO_OPEN_BROWSER keeps it from opening a
//                               browser here); finishes on its own
//   claude auth login           a link, then "Paste code here if prompted >":
//                               the code the browser shows is pasted back
//
// A CLI with none of these (opencode's provider picker, an API-key CLI) is not
// here: the client tells the person the command to run once over SSH.

export type SignInFlow = {
  /** The command's name on PATH. */
  binary: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
  kind: 'device-code' | 'browser' | 'paste'
}

export const SIGN_IN_FLOWS: Readonly<Record<string, SignInFlow>> = {
  codex: { binary: 'codex', args: ['login', '--device-auth'], kind: 'device-code' },
  cursor: { binary: 'cursor-agent', args: ['login'], env: { NO_OPEN_BROWSER: '1' }, kind: 'browser' },
  'claude-code': { binary: 'claude', args: ['auth', 'login'], kind: 'paste' },
}

export type SignInStarted =
  { ok: true; id: string; url: string; code: string | null; paste: boolean } | { ok: false; message: string }

export type SignInDone = { ok: true } | { ok: false; message: string }

// OSC 8 hyperlinks and colour codes: the link is read from the text between them.
const ESCAPES = /\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;]*[A-Za-z]/gu
const URL = /https:\/\/[^\s"'<>\u001b]+/u
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/u
const PASTE_PROMPT = /paste (the )?code/iu
const START_TIMEOUT_MS = 30_000
const SIGN_IN_TIMEOUT_MS = 15 * 60_000

/** The link, code and paste prompt in what a login has printed so far. */
export function readSignInOutput(text: string): { url: string | null; code: string | null; paste: boolean } {
  const plain = text.replace(ESCAPES, '')
  const url = URL.exec(plain)?.[0]?.replace(/[).,]+$/u, '') ?? null
  const afterUrl = url ? plain.slice(plain.indexOf(url) + url.length) : plain
  return { url, code: DEVICE_CODE.exec(afterUrl)?.[0] ?? null, paste: PASTE_PROMPT.test(plain) }
}

type Running = { child: ChildProcessWithoutNullStreams; done: Promise<SignInDone> }

export type SignInDeps = {
  /** Where a CLI's command is on this machine (the login shell's PATH), or null. */
  resolve(binary: string): Promise<string | null>
  spawn?: typeof spawn
  platform?: NodeJS.Platform
  /** How long a login asked to end has before it is killed. */
  killGraceMs?: number
}

/** How long a login asked to end gets before it is made to. */
const KILL_GRACE_MS = 5_000

export function createSignIns(deps: SignInDeps) {
  const running = new Map<string, Running>()
  const spawnChild = deps.spawn ?? spawn
  // A login runs in a process group of its own, so ending it ends whatever it
  // started too (a CLI's helper, a browser opener), not only the CLI.
  const grouped = (deps.platform ?? process.platform) !== 'win32'
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS

  function signal(child: ChildProcessWithoutNullStreams, name: NodeJS.Signals): void {
    try {
      if (grouped && child.pid) process.kill(-child.pid, name)
      else child.kill(name)
    } catch {
      // Gone already.
    }
  }

  /** Ask a login to end, and make it end after the grace period; its group goes with it. */
  function end(child: ChildProcessWithoutNullStreams): void {
    signal(child, 'SIGTERM')
    const timer = setTimeout(() => signal(child, 'SIGKILL'), killGraceMs)
    timer.unref?.()
    child.once('close', () => {
      clearTimeout(timer)
      // Anything it started that outlived it.
      signal(child, 'SIGKILL')
    })
  }

  async function start(cli: string): Promise<SignInStarted> {
    const flow = SIGN_IN_FLOWS[cli]
    if (!flow) return { ok: false, message: `${cli} has no sign-in Studio can run without a terminal.` }
    const binary = await deps.resolve(flow.binary)
    if (!binary) return { ok: false, message: `${flow.binary} is not installed on this machine.` }
    const child = spawnChild(binary, [...flow.args], {
      env: { ...process.env, ...flow.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: grouped,
    }) as ChildProcessWithoutNullStreams
    child.stdin.on('error', () => undefined)
    let output = ''
    let settleReady: (() => void) | null = null
    const ready = new Promise<void>((resolve) => (settleReady = resolve))
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-16_384)
      const read = readSignInOutput(output)
      // Ready once the link is out, and for a device code once the code is too.
      if (read.url && (flow.kind !== 'device-code' || read.code) && (flow.kind !== 'paste' || read.paste))
        settleReady?.()
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const done = new Promise<SignInDone>((resolve) => {
      child.once('error', (error) =>
        resolve({ ok: false, message: `${flow.binary} could not start: ${error.message}` }),
      )
      child.once('close', (code) => {
        settleReady?.()
        const tail = output.replace(ESCAPES, '').trim().split('\n').slice(-2).join(' ')
        resolve(
          code === 0
            ? { ok: true }
            : { ok: false, message: `${flow.binary} did not sign in${tail ? `: ${tail}` : '.'}` },
        )
      })
    })
    const id = randomBytes(8).toString('hex')
    const timer = setTimeout(() => end(child), SIGN_IN_TIMEOUT_MS)
    timer.unref?.()
    running.set(id, { child, done })
    void done.finally(() => {
      clearTimeout(timer)
      running.delete(id)
    })
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, START_TIMEOUT_MS).unref?.())])
    const read = readSignInOutput(output)
    if (!read.url) {
      end(child)
      const finished = await done
      return { ok: false, message: finished.ok ? `${flow.binary} printed no sign-in link.` : finished.message }
    }
    return {
      ok: true,
      id,
      url: read.url,
      code: flow.kind === 'device-code' ? read.code : null,
      paste: flow.kind === 'paste',
    }
  }

  return {
    start,
    /** A code the browser showed, typed back to a login that asked for one. */
    paste(id: string, code: string): { ok: boolean } {
      const entry = running.get(id)
      if (!entry || !/^[\x20-\x7e]{1,4096}$/u.test(code)) return { ok: false }
      entry.child.stdin.write(`${code.trim()}\n`)
      return { ok: true }
    },
    wait(id: string): Promise<SignInDone> {
      return running.get(id)?.done ?? Promise.resolve({ ok: false, message: 'That sign-in has already ended.' })
    },
    cancel(id: string): void {
      const entry = running.get(id)
      if (entry) end(entry.child)
    },
    /**
     * End every login still waiting: the server is stopping, and may be gone
     * before a grace period would run out. A login waiting on a person has
     * nothing to save, so its group is killed outright.
     */
    stopAll(): void {
      for (const entry of running.values()) {
        signal(entry.child, 'SIGTERM')
        signal(entry.child, 'SIGKILL')
      }
    },
  }
}

export type SignIns = ReturnType<typeof createSignIns>

/** Where a command is on this process's PATH (a detached server's is its login shell's), or null. */
export function resolveOnPath(binary: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/u.test(binary)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'command -v "$1"', 'sh', binary], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.once('error', () => resolve(null))
    child.once('close', (code) => {
      const path = out.trim().split('\n')[0] ?? ''
      resolve(code === 0 && path.startsWith('/') ? path : null)
    })
  })
}
