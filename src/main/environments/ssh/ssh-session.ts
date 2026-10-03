import type { Readable, Writable } from 'node:stream'

import { SEND_MARKER } from '../../hosts/remote-install'
import { attachRelay, RELAY_MARKER, type AttachedRelay } from './relay-client'

// One SSH session as the client drives it (phase 8 spec, 5.2): the script
// goes in, marker lines come out, and nothing more is written until the
// script has said `@@SPRINTENGINE_SEND`. That rule is enforced here, not left
// to each caller: `send` refuses before the marker (spec E4.3a, E5, where an
// envelope written early was run as a shell command and echoed into a log).
//
// Everything before the first marker (a login profile's greeting) is noise,
// kept for diagnostics and never parsed. After an `attach`, `start` or
// `upgrade` decision, the session's stdout turns into the relay's
// multiplexer at the `@@SPRINTENGINE_RELAY` line, and is handed over whole.

/** What spawning a session gives back: ssh, or in tests a plain `sh -s` standing in for it. */
export type SessionProcess = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(): void
  once(event: 'close', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

const MARK = '@@SPRINTENGINE_'
const MAX_NOISE = 32 * 1024

export class SessionClosedError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'SessionClosedError'
  }
}

export class RemoteSession {
  readonly lines: string[] = []
  noise = ''
  stderr = ''
  exit: { code: number | null } | null = null
  private sawMarker = false
  private sendReady = false
  private buffer: Buffer = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private handedOff = false
  private readonly onStdout = (chunk: Buffer) => this.take(chunk)

  constructor(readonly process: SessionProcess) {
    process.stdout.on('data', this.onStdout)
    process.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16_384)
      this.wake()
    })
    process.stdin.on('error', () => undefined)
    process.once('close', (code) => {
      this.exit = { code }
      this.wake()
    })
    process.once('error', (error) => {
      this.stderr += error.message
      this.exit = { code: 127 }
      this.wake()
    })
  }

  /** Start a session: spawn, and write the script, which is all the client says until SEND. */
  static start(spawn: () => SessionProcess, script: string): RemoteSession {
    const session = new RemoteSession(spawn())
    session.process.stdin.write(script.endsWith('\n') ? script : `${script}\n`)
    return session
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  private take(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline === -1) break
      const lineBytes = this.buffer.subarray(0, newline)
      const line = lineBytes.toString('utf8').replace(/\r$/u, '')
      if (line.startsWith(`${RELAY_MARKER} `)) {
        // The rest is the multiplexer's: stop reading lines, keep every byte.
        this.process.stdout.off('data', this.onStdout)
        this.process.stdout.pause()
        this.process.stdout.unshift(this.buffer)
        this.buffer = Buffer.alloc(0)
        this.handedOff = true
        this.wake()
        return
      }
      this.buffer = this.buffer.subarray(newline + 1)
      const at = line.indexOf(MARK)
      if (!this.sawMarker && at === -1) {
        if (this.noise.length < MAX_NOISE) this.noise += `${line}\n`
        continue
      }
      // A marker can follow noise on one line when a profile printed with no newline.
      if (at > 0 && !this.sawMarker) this.noise += line.slice(0, at)
      this.sawMarker = true
      const marked = at >= 0 ? line.slice(at) : line
      if (marked === SEND_MARKER) this.sendReady = true
      this.lines.push(marked)
    }
    if (this.buffer.length > 1024 * 1024 && !this.sawMarker) this.buffer = this.buffer.subarray(-1024)
    this.wake()
  }

  /** Resolves once `pick` matches a line, or rejects when the session ends or `timeoutMs` passes. */
  async waitFor(pick: (line: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.lines.find(pick)
      if (found !== undefined) return found
      if (this.exit || this.handedOff)
        throw new SessionClosedError(`The session ended before ${what}.`, this.exit?.code ?? null, this.stderr)
      const left = deadline - Date.now()
      if (left <= 0) throw new SessionClosedError(`Timed out waiting for ${what}.`, null, this.stderr)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** The script has asked for the client's line: the one moment writing is allowed. */
  waitForSend(timeoutMs: number): Promise<string> {
    return this.waitFor((line) => line === SEND_MARKER, timeoutMs, 'the remote asked for a decision')
  }

  /**
   * Write the decision line, then `body` (an archive), then end stdin when
   * `end`. Throws before `@@SPRINTENGINE_SEND`: nothing may reach a shell that
   * is still reading its script.
   */
  send(decision: string, options: { body?: Buffer | null; end?: boolean } = {}): void {
    if (!this.sendReady) throw new Error('Nothing is written to a session before it says @@SPRINTENGINE_SEND.')
    if (/[\r\n]/u.test(decision)) throw new Error('A decision is one line.')
    this.process.stdin.write(`${decision}\n`)
    if (options.body) this.process.stdin.write(options.body)
    if (options.end) this.process.stdin.end()
  }

  /** The relay, once the remote has become it; rejects with the session's own words when it did not. */
  async relay(timeoutMs: number): Promise<AttachedRelay> {
    const deadline = Date.now() + timeoutMs
    while (!this.handedOff) {
      if (this.exit)
        throw new SessionClosedError('The session ended before the relay started.', this.exit.code, this.stderr)
      const left = deadline - Date.now()
      if (left <= 0) throw new SessionClosedError('The relay did not start in time.', null, this.stderr)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    return attachRelay(this.process.stdout, this.process.stdin, { timeoutMs: Math.max(1_000, deadline - Date.now()) })
  }

  /** Resolves once the process has gone. */
  closed(): Promise<{ code: number | null }> {
    if (this.exit) return Promise.resolve(this.exit)
    return new Promise((resolve) => this.process.once('close', (code) => resolve({ code })))
  }

  kill(): void {
    this.process.kill()
  }
}
