import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { cliSpawnTarget, terminateCliChild } from './cli-child-process'

export type RpcMessage = {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string; code?: number }
}
export type CodexRpcTransport = {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  respond(id: string | number, result: unknown): void
  reject(id: string | number, message: string): void
  close(): void
  readonly pid: number | null
}
export type CodexRpcOptions = {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  onMessage(message: RpcMessage): void | Promise<void>
  onClose(error: Error): void
  // A tool Codex could not run, which it reports only on stderr.
  onToolFailure?(message: string): void
  // Passed to `codex app-server` after its own arguments.
  args?: string[]
  timeoutMs?: number
  spawnChild?: typeof spawn
  platform?: NodeJS.Platform
}

/** Codex answered the request with an error, as opposed to the request never
 * being answered (a timeout, or the process closing). */
export class CodexRpcError extends Error {}

const TOOL_FAILURE_CHARS = 500

/**
 * The reason in a stderr line that says Codex's tool router failed a call, or
 * null for any other line. A call that fails before it runs (its sandbox or
 * code-mode host never answered) produces no item on the protocol, so without
 * this the chat shows nothing at all. Only the router's own error text is
 * taken; the rest of stderr can carry request details and stays unread.
 */
export function codexToolFailure(line: string): string | null {
  // oxlint-disable-next-line no-control-regex -- stripping the ANSI colours Codex logs with
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '')
  const match = /\bERROR\s+codex_core::tools::router:\s*error=(.+)$/.exec(plain)
  const reason = match?.[1].trim()
  return reason ? reason.slice(0, TOOL_FAILURE_CHARS) : null
}

/** `SPRINTENGINE_CODEX_APP_SERVER_ARGS` split as a shell would, quotes and all. */
export function codexAppServerArgs(value: string | undefined): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of value?.trim() ?? '') {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/** JSONL framing is confined here; protocol events never share stderr or shell parsing. */
export function createCodexRpcTransport(options: CodexRpcOptions): CodexRpcTransport {
  const target = cliSpawnTarget(options.command, ['app-server', '--listen', 'stdio://', ...(options.args ?? [])], {
    platform: options.platform,
    env: options.env,
  })
  const child = (options.spawnChild ?? spawn)(target.file, target.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }) as ChildProcessWithoutNullStreams
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  const decoder = new StringDecoder('utf8')
  let sequence = 0
  let buffer = ''
  let closed = false
  let delivery = Promise.resolve()
  const finish = (error: Error) => {
    if (closed) return
    closed = true
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    terminateCliChild(child, { platform: options.platform })
    void delivery.then(() => options.onClose(error))
  }
  const write = (message: RpcMessage) => {
    if (closed || child.stdin.destroyed) throw new Error('Codex connection is closed.')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  child.stdin.on('error', (error) => finish(error))
  child.on('error', (error) =>
    finish(
      child.pid === undefined
        ? new Error(`Codex could not be started from ${options.command}: ${error.message}`)
        : error,
    ),
  )
  child.on('close', (code) => finish(new Error(`Codex process exited${code === null ? '' : ` (${code})`}.`)))
  // Drain diagnostics without retaining credentials or dumping them into the
  // transcript: a line is kept only until it is complete, and only a tool
  // router failure's reason leaves this function.
  const stderrDecoder = new StringDecoder('utf8')
  let stderrLine = ''
  child.stderr.on('data', (chunk: Buffer) => {
    if (!options.onToolFailure) return
    stderrLine += stderrDecoder.write(chunk)
    let newline: number
    while ((newline = stderrLine.indexOf('\n')) >= 0) {
      const reason = codexToolFailure(stderrLine.slice(0, newline))
      stderrLine = stderrLine.slice(newline + 1)
      if (reason) options.onToolFailure(reason)
    }
    // A line this long is not a log line worth reading.
    if (stderrLine.length > 64 * 1024) stderrLine = ''
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
      finish(new Error('Codex protocol frame exceeds the size limit.'))
      child.kill()
      return
    }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message: RpcMessage
      try {
        message = JSON.parse(line) as RpcMessage
      } catch {
        continue
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue
      if (typeof message.method !== 'string' && typeof message.id === 'number') {
        const request = pending.get(message.id)
        if (!request) continue
        clearTimeout(request.timer)
        pending.delete(message.id)
        if (message.error) request.reject(new CodexRpcError(message.error.message ?? 'Codex request failed.'))
        else request.resolve(message.result)
      } else if (typeof message.method === 'string') {
        delivery = delivery
          .then(() => options.onMessage(message))
          .catch((error: unknown) => {
            finish(error instanceof Error ? error : new Error('Codex event handling failed.'))
            child.kill()
          })
      }
    }
  })
  return {
    get pid() {
      return closed ? null : (child.pid ?? null)
    },
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Codex ${method} timed out.`))
        }, options.timeoutMs ?? 30_000)
        pending.set(id, { resolve, reject, timer })
        try {
          write({ id, method, params })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    notify: (method, params) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    reject: (id, message) => write({ id, error: { code: -32601, message } }),
    close() {
      finish(new Error('Codex connection closed.'))
    },
  }
}
