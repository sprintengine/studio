import type { IpcStatsSnapshot } from '../shared/electron-api'

// Preload-side IPC accounting. The whole `window.api` surface is assembled in one
// place (index.ts), so wrapping it once — only when diagnostics is enabled — gives
// per-method call counts and an approximate byte volume for both outbound
// invokes and inbound event callbacks (e.g. terminal data), with zero overhead
// when diagnostics is off (the raw api is exposed unwrapped).

type Counter = { calls: number; outBytes: number; inEvents: number; inBytes: number }

const counters = new Map<string, Counter>()

function ensure(name: string): Counter {
  let counter = counters.get(name)
  if (!counter) {
    counter = { calls: 0, outBytes: 0, inEvents: 0, inBytes: 0 }
    counters.set(name, counter)
  }
  return counter
}

// Cheap, allocation-light byte estimate: count string args and a top-level
// `data` string field (the common terminal-payload shape) without a deep
// JSON.stringify on the hot path.
function approxBytes(args: readonly unknown[]): number {
  let total = 0
  for (const arg of args) {
    if (typeof arg === 'string') {
      total += arg.length
    } else if (arg && typeof arg === 'object') {
      const data = (arg as { data?: unknown }).data
      if (typeof data === 'string') total += data.length
    }
  }
  return total
}

export function instrumentApi<T extends Record<string, unknown>>(api: T): T {
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(api)) {
    if (typeof value !== 'function') {
      wrapped[name] = value
      continue
    }
    const isSubscribe = /^on[A-Z]/.test(name)
    const original = value as (...args: unknown[]) => unknown
    wrapped[name] = (...args: unknown[]) => {
      const counter = ensure(name)
      counter.calls += 1
      counter.outBytes += approxBytes(args)
      if (isSubscribe) {
        // Wrap the last function argument (the listener) so inbound event volume
        // is counted each time the main process pushes to this channel.
        for (let index = args.length - 1; index >= 0; index -= 1) {
          if (typeof args[index] === 'function') {
            const listener = args[index] as (...cbArgs: unknown[]) => unknown
            args[index] = (...cbArgs: unknown[]) => {
              counter.inEvents += 1
              counter.inBytes += approxBytes(cbArgs)
              return listener(...cbArgs)
            }
            break
          }
        }
      }
      return original(...args)
    }
  }
  return wrapped as T
}

export function snapshotIpcStats(): IpcStatsSnapshot {
  return {
    sampledAt: Date.now(),
    channels: [...counters.entries()].map(([name, counter]) => ({ name, ...counter })),
  }
}
