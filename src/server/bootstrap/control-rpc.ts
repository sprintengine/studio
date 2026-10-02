// Requests, answers and one-way events between the shell and its server, over
// the control channel. Either end may ask: the shell asks the server to
// prepare workspaces or report its state, the server asks the shell to seal a
// secret or show a notification. The channel underneath is process-private
// (a utility process's parent port, or a child's stdio), so nothing here
// authenticates; whoever holds the channel is the shell.
//
// Values travel as the channel carries them: structured clones on a parent
// port, so a `Uint8Array` arrives as one, and JSON on stdio.

export type ControlRpcFrame =
  | { t: 'req'; id: number; method: string; params: unknown }
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: { code: ControlRpcErrorCode; message: string } }
  | { t: 'event'; name: string; payload: unknown }

/**
 * `unavailable`: the other end is gone, or went while the call was out.
 * `timeout`: no answer in time. `no_handler`: the other end serves no such
 * method. `failed`: the handler threw; the message is its own.
 */
export type ControlRpcErrorCode = 'unavailable' | 'timeout' | 'no_handler' | 'failed'

export class ControlRpcError extends Error {
  constructor(
    readonly code: ControlRpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ControlRpcError'
  }
}

export type ControlRpc = {
  call<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>
  /** Serve `method`. A second handler for the same method replaces the first. */
  handle(method: string, handler: (params: unknown) => unknown): () => void
  emit(name: string, payload?: unknown): void
  on(name: string, listener: (payload: unknown) => void): () => void
  /** Hand over one frame from the other end. False when it is not a control RPC frame, for the caller to read. */
  receive(frame: unknown): boolean
  /** The other end is gone: every call out rejects `unavailable`, and later calls do too until `reopen`. */
  close(reason: string): void
  /** A new channel to the other end (a restarted server): calls go out again. */
  reopen(send: (frame: ControlRpcFrame) => void): void
}

const DEFAULT_TIMEOUT_MS = 30_000

export function createControlRpc(
  send: ((frame: ControlRpcFrame) => void) | null,
  options: { defaultTimeoutMs?: number; log?: (message: string) => void } = {},
): ControlRpc {
  let post = send
  let closedReason = send ? null : 'The other end of the control channel is not connected.'
  let nextId = 1
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: unknown }>()
  const handlers = new Map<string, (params: unknown) => unknown>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  function deliver(frame: ControlRpcFrame): boolean {
    if (!post) return false
    try {
      post(frame)
      return true
    } catch (error) {
      options.log?.(`control channel send failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function settle(id: number): { resolve(value: unknown): void; reject(error: Error): void } | null {
    const entry = pending.get(id)
    if (!entry) return null
    pending.delete(id)
    clearTimeout(entry.timer as ReturnType<typeof setTimeout>)
    return entry
  }

  async function serve(id: number, method: string, params: unknown): Promise<void> {
    const handler = handlers.get(method)
    if (!handler) {
      deliver({ t: 'res', id, ok: false, error: { code: 'no_handler', message: `No handler for ${method}.` } })
      return
    }
    try {
      const value = await handler(params)
      deliver({ t: 'res', id, ok: true, value })
    } catch (error) {
      const code = error instanceof ControlRpcError ? error.code : 'failed'
      deliver({
        t: 'res',
        id,
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  return {
    call<T>(method: string, params?: unknown, callOptions: { timeoutMs?: number } = {}): Promise<T> {
      if (closedReason !== null) return Promise.reject(new ControlRpcError('unavailable', closedReason))
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const timeoutMs = callOptions.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
        const timer = setTimeout(() => {
          if (settle(id)) reject(new ControlRpcError('timeout', `${method} was not answered within ${timeoutMs} ms.`))
        }, timeoutMs)
        // Never what keeps a process alive: a server exiting does not wait on a call out.
        ;(timer as { unref?: () => void }).unref?.()
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
        if (!deliver({ t: 'req', id, method, params })) {
          settle(id)
          reject(new ControlRpcError('unavailable', `${method} could not be sent: the control channel is closed.`))
        }
      })
    },
    handle(method, handler) {
      handlers.set(method, handler)
      return () => {
        if (handlers.get(method) === handler) handlers.delete(method)
      }
    },
    emit(name, payload) {
      deliver({ t: 'event', name, payload })
    },
    on(name, listener) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    receive(frame) {
      if (typeof frame !== 'object' || frame === null) return false
      const message = frame as Partial<ControlRpcFrame>
      if (message.t === 'req' && typeof message.id === 'number' && typeof message.method === 'string') {
        void serve(message.id, message.method, (message as { params?: unknown }).params)
        return true
      }
      if (message.t === 'res' && typeof message.id === 'number') {
        const entry = settle(message.id)
        if (!entry) return true
        const answer = message as Extract<ControlRpcFrame, { t: 'res' }>
        if (answer.ok) entry.resolve(answer.value)
        else entry.reject(new ControlRpcError(answer.error?.code ?? 'failed', answer.error?.message ?? 'Failed.'))
        return true
      }
      if (message.t === 'event' && typeof message.name === 'string') {
        for (const listener of [...(listeners.get(message.name) ?? [])]) {
          try {
            listener((message as { payload?: unknown }).payload)
          } catch (error) {
            options.log?.(`${message.name} listener threw: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return true
      }
      return false
    },
    close(reason) {
      closedReason = reason
      post = null
      for (const id of [...pending.keys()]) settle(id)?.reject(new ControlRpcError('unavailable', reason))
    },
    reopen(nextSend) {
      post = nextSend
      closedReason = null
    },
  }
}
