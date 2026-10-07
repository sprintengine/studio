import { expect, test } from 'vitest'

import {
  USAGE_LIMIT_RESUMES_CHANGED_CHANNEL,
  USAGE_LIMIT_RESUMES_GET_CHANNEL,
  USAGE_LIMIT_RESUMES_UPDATE_CHANNEL,
} from '../../shared/ipc/usage-limit-resume'
import type { UsageLimitResumeState, UsageLimitResumeUpdate } from '../../shared/usage-limit-resume'
import type { UsageLimitResumer } from '../usage-limits/resume'
import { parseUsageLimitResumeUpdate, registerUsageLimitResumeIpc } from './usage-limit-resume-ipc'

type Handler = (event: unknown, input?: unknown) => unknown

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

function fakeResumer() {
  let current: UsageLimitResumeState = { autoResume: false, notices: [] }
  const listeners = new Set<(state: UsageLimitResumeState) => void>()
  const updates: UsageLimitResumeUpdate[] = []
  const resumer = {
    state: () => current,
    update: (update: UsageLimitResumeUpdate) => {
      updates.push(update)
      if (update.kind === 'auto') current = { ...current, autoResume: update.enabled }
      for (const listener of listeners) listener(current)
      return current
    },
    onChanged: (listener: (state: UsageLimitResumeState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as UsageLimitResumer
  return { resumer, updates }
}

test('the read answers with the state, and each change reaches the windows that asked and no other', async () => {
  const handlers = new Map<string, Handler>()
  const { resumer, updates } = fakeResumer()
  const { stop } = registerUsageLimitResumeIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    resumer,
  )
  const asked: Array<[string, unknown]> = []
  const silent: Array<[string, unknown]> = []
  const window = renderer(1, asked)
  renderer(2, silent)
  expect(await handlers.get(USAGE_LIMIT_RESUMES_GET_CHANNEL)!({ sender: window })).toEqual({
    autoResume: false,
    notices: [],
  })
  const answer = await handlers.get(USAGE_LIMIT_RESUMES_UPDATE_CHANNEL)!({}, { kind: 'auto', enabled: true })
  expect(answer).toEqual({ autoResume: true, notices: [] })
  expect(updates).toEqual([{ kind: 'auto', enabled: true }])
  expect(asked).toEqual([[USAGE_LIMIT_RESUMES_CHANGED_CHANNEL, { autoResume: true, notices: [] }]])
  expect(silent).toEqual([])
  // Anything else is answered with the state as it stands, and changes nothing.
  await handlers.get(USAGE_LIMIT_RESUMES_UPDATE_CHANNEL)!({}, { kind: 'resume-everything' })
  expect(updates).toHaveLength(1)
  window.destroy()
  await handlers.get(USAGE_LIMIT_RESUMES_UPDATE_CHANNEL)!({}, { kind: 'auto', enabled: false })
  expect(asked).toHaveLength(1)
  stop()
})

test('an update is read field by field', () => {
  expect(parseUsageLimitResumeUpdate({ kind: 'schedule', workspaceId: 'ws-1', agentId: 'a-1', extra: 1 })).toEqual({
    kind: 'schedule',
    workspaceId: 'ws-1',
    agentId: 'a-1',
  })
  expect(parseUsageLimitResumeUpdate({ kind: 'retry', workspaceId: 'ws-1', agentId: 'a-1' })).toEqual({
    kind: 'retry',
    workspaceId: 'ws-1',
    agentId: 'a-1',
  })
  expect(parseUsageLimitResumeUpdate({ kind: 'resend', workspaceId: 'ws-1', agentId: 'a-1' })).toBeNull()
  expect(parseUsageLimitResumeUpdate({ kind: 'dismiss', workspaceId: 'ws-1' })).toBeNull()
  expect(parseUsageLimitResumeUpdate({ kind: 'cancel', workspaceId: '', agentId: 'a-1' })).toBeNull()
  expect(parseUsageLimitResumeUpdate({ kind: 'auto', enabled: 'yes' })).toBeNull()
  expect(parseUsageLimitResumeUpdate(null)).toBeNull()
})
