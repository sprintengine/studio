// A stand-in for one distribution's helper client, for tests of what main does
// with a WSL machine. Each method the helper answers is a handler the test
// supplies; every request is recorded.

import type { WslHelperClient, WslHelperInfo } from '../src/main/hosts/wsl-helper-client'
import type { WslSetupError } from '../src/main/hosts/wsl-setup-error'

export const STUB_HELPER_INFO: WslHelperInfo = {
  uid: 1000,
  profile: 'abc123def456',
  home: '/home/dev',
  arch: 'x64',
  nodePath: '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node',
  appDir: '/home/dev/.local/share/sprintengine-studio/0.4.0',
  agentSocket: '/run/user/1000/sprintengine/abc123def456/agent.sock',
  mcpSocket: '/run/user/1000/sprintengine/abc123def456/mcp.sock',
  userDataDir: '/run/user/1000/sprintengine/abc123def456',
  pidDir: '/run/user/1000/sprintengine/abc123def456/sessions',
  sessionDir: '/home/dev/.local/share/sprintengine-studio/sessions/abc123def456',
}

export type StubWatch = {
  path: string
  recursive: boolean
  listener: (filename: string | null) => void
  onError: () => void
  closed: boolean
}

export type StubHelper = WslHelperClient & {
  requests: Array<{ method: string; params: unknown; timeoutMs: number | null | undefined }>
  retained: Set<string>
  starts: number
  failWith: WslSetupError | null
  /** Tokens issued and not yet revoked. */
  tokens: Set<string>
  watches: StubWatch[]
}

export function stubWslHelper(
  distro: string,
  handlers: Record<string, (params: never) => unknown> = {},
  info: WslHelperInfo = STUB_HELPER_INFO,
): StubHelper {
  let running = false
  let nextToken = 1
  const stub: StubHelper = {
    distro,
    requests: [],
    retained: new Set(),
    starts: 0,
    failWith: null,
    tokens: new Set(),
    watches: [],
    state: () => (running ? 'ready' : 'stopped'),
    info: () => (running ? info : null),
    lastError: () => stub.failWith,
    async start() {
      stub.starts += 1
      if (stub.failWith) throw stub.failWith
      running = true
      return info
    },
    async request<T>(method: string, params?: unknown, options: { timeoutMs?: number | null } = {}): Promise<T> {
      await stub.start()
      stub.requests.push({ method, params, timeoutMs: options.timeoutMs })
      const handler = handlers[method]
      if (!handler) throw new Error(`The stub helper has no ${method}.`)
      return (await handler(params as never)) as T
    },
    async requestIfRunning<T>(method: string, params?: unknown): Promise<T | null> {
      if (!running) return null
      return stub.request<T>(method, params)
    },
    retain(id) {
      stub.retained.add(id)
    },
    release(id) {
      stub.retained.delete(id)
    },
    issueChannelToken() {
      const token = `stub-token-${nextToken}-${'x'.repeat(16)}`
      nextToken += 1
      stub.tokens.add(token)
      return token
    },
    revokeChannelToken(token) {
      stub.tokens.delete(token)
    },
    watch(path, recursive, listener, onError) {
      const entry: StubWatch = { path, recursive, listener, onError, closed: false }
      stub.watches.push(entry)
      return {
        close() {
          entry.closed = true
        },
      }
    },
    async shutdown() {
      running = false
    },
  }
  return stub
}
