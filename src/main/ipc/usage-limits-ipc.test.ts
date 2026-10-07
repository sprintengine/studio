import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { USAGE_LIMITS_CHANGED_CHANNEL, USAGE_LIMITS_GET_CHANNEL } from '../../shared/ipc/usage-limits'
import type { UsageLimitsState } from '../../shared/usage-limits'
import { USAGE_LIMITS_CACHE_FILE } from '../usage-limits/disk-cache'
import { createUsageLimitsStore } from '../usage-limits/store'
import { registerUsageLimitsIpc } from './usage-limits-ipc'

type Handler = (event: unknown) => Promise<unknown>

function renderer(id: number, sent: Array<[string, unknown]>) {
  let destroyed = false
  const onDestroyed: Array<() => void> = []
  return {
    id,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => sent.push([channel, payload]),
    once: (_event: 'destroyed', listener: () => void) => onDestroyed.push(listener),
    destroy: () => {
      destroyed = true
      for (const listener of onDestroyed) listener()
    },
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('the read answers with the reading, and each change reaches the windows that asked and no other', async () => {
  const handlers = new Map<string, Handler>()
  const store = createUsageLimitsStore()
  const { stop } = registerUsageLimitsIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    {
      store,
    },
  )
  const asked: Array<[string, unknown]> = []
  const silent: Array<[string, unknown]> = []
  const window = renderer(1, asked)
  renderer(2, silent)
  expect(await handlers.get(USAGE_LIMITS_GET_CHANNEL)!({ sender: window })).toEqual({ snapshots: [] })
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 30, resetsAt: Date.now() + 60_000 }])
  expect(asked).toHaveLength(1)
  expect(asked[0][0]).toBe(USAGE_LIMITS_CHANGED_CHANNEL)
  expect((asked[0][1] as UsageLimitsState).snapshots[0].provider).toBe('claude')
  expect(silent).toEqual([])
  // A window that went is let go.
  window.destroy()
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 60 }])
  expect(asked).toHaveLength(1)
  stop()
})

test("the first read waits for the cache, so a window opened at launch has the last run's bars", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-limits-ipc-'))
  dirs.push(dir)
  const resetsAt = Date.now() + 60 * 60_000
  await writeFile(
    join(dir, USAGE_LIMITS_CACHE_FILE),
    JSON.stringify({
      version: 1,
      snapshots: [
        {
          provider: 'codex',
          billing: 'subscription',
          observedAt: 5,
          windows: [
            { id: 'codex:primary', label: 'Session (5h)', usedPercent: 50, resetsAt, status: 'allowed', observedAt: 5 },
          ],
        },
      ],
    }),
  )
  const handlers = new Map<string, Handler>()
  const { stop } = registerUsageLimitsIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    {
      store: createUsageLimitsStore(),
      userDataDir: dir,
    },
  )
  const state = (await handlers.get(USAGE_LIMITS_GET_CHANNEL)!({ sender: renderer(1, []) })) as UsageLimitsState
  expect(state.snapshots.map((snapshot) => [snapshot.provider, snapshot.observedAt])).toEqual([['codex', 5]])
  stop()
})
