import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

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
  timeoutMs?: number
  spawnChild?: typeof spawn
}

/** Codex answered the request with an error, as opposed to the request never
 * being answered (a timeout, or the process closing). */
export class CodexRpcError extends Error {}

/** JSONL framing is confined here; protocol events never share stderr or shell parsing. */
export function createCodexRpcTransport(options: CodexRpcOptions): CodexRpcTransport {
  const child = (options.spawnChild ?? spawn)(options.command, ['app-server', '--listen', 'stdio://'], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
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
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 2_000)
      timer.unref()
    }
    void delivery.then(() => options.onClose(error))
  }
  const write = (message: RpcMessage) => {
    if (closed || child.stdin.destroyed) throw new Error('Codex connection is closed.')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  child.stdin.on('error', (error) => finish(error))
  child.on('error', (error) => finish(error))
  child.on('close', (code) => finish(new Error(`Codex process exited${code === null ? '' : ` (${code})`}.`)))
  // Drain diagnostics without retaining credentials or dumping them into the transcript.
  child.stderr.on('data', () => undefined)
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
