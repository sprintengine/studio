/**
 * MC-2169 — the entitlement IPC channel must reach the SEAM, never the auth
 * bridge. That is the structural rule the seam exists to enforce, so it is
 * pinned here rather than left to review: the bridge below throws on any
 * entitlement call, so a handler that regresses to it fails loudly instead of
 * passing by coincidence. No Electron — `registerAuthIpc` only needs `handle`.
 */
import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import type { EntitlementSnapshot } from '../../shared/electron-api'
import { EntitlementService } from '../entitlement-service'
import { registerAuthIpc } from './auth-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function snapshot(): EntitlementSnapshot {
  return {
    userId: 'user_1',
    organizationId: 'org_1',
    product: 'multicode',
    roles: [],
    features: { 'multicode.x': true },
    limits: {},
    sources: {},
    plan: { code: 'pro', status: 'active' },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    schemaVersion: 1,
  }
}

async function main(): Promise<void> {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as IpcMain

  const entitlements = new EntitlementService(
    {
      read: () => ({
        authenticated: true,
        snapshot: snapshot(),
        cache: null,
        lastRefreshAt: new Date().toISOString(),
      }),
      refresh: async () => {},
    },
    { product: 'multicode' }
  )

  // Serves only the identity half. Anything else is a regression.
  const bridge = new Proxy({}, {
    get: (_target, property) =>
      async () => {
        throw new Error(`bridge.${String(property)} must not serve an entitlement channel`)
      },
  })

  registerAuthIpc(ipcMain, bridge as never, entitlements)

  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    assert.ok(handler, `${channel} is not registered`)
    return Promise.resolve(handler(null, ...args))
  }

  const decision = await invoke('auth:check-premium-access', { featureKey: 'multicode.x' }) as {
    allowed: boolean
    status: string
  }
  assert.equal(decision.allowed, true)
  assert.equal(decision.status, 'fresh')

  console.log('auth ipc tests passed')
}

void main()
