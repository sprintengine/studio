import { afterEach, expect, test } from 'vitest'

import type { UsageLimitResumeState, UsageLimitResumeUpdate } from '../../../shared/usage-limit-resume'
import {
  retainUsageLimitResumes,
  selectUsageLimitResumeNotice,
  updateUsageLimitResume,
  useUsageLimitResumeStore,
} from './usageLimitResumeStore'

const stopped = (agentId: string): UsageLimitResumeState => ({
  autoResume: false,
  notices: [
    {
      workspaceId: 'ws-1',
      agentId,
      provider: 'claude',
      limit: 'session',
      resetsAt: 10,
      hitAt: 1,
      resumeAt: null,
    },
  ],
})

function fakeApi(answer: Promise<UsageLimitResumeState>) {
  const listeners = new Set<(state: UsageLimitResumeState) => void>()
  const updates: UsageLimitResumeUpdate[] = []
  return {
    api: {
      usageLimitResumes: () => answer,
      updateUsageLimitResume: async (update: UsageLimitResumeUpdate) => {
        updates.push(update)
        return { autoResume: true, notices: [] }
      },
      onUsageLimitResumesChanged: (listener: (state: UsageLimitResumeState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    push: (next: UsageLimitResumeState) => listeners.forEach((listener) => listener(next)),
    listeners,
    updates,
  }
}

afterEach(() => useUsageLimitResumeStore.setState({ state: null }))

test('the store follows main while held, a push beats a slower first read, and the last release lets go', async () => {
  let answer!: (state: UsageLimitResumeState) => void
  const fake = fakeApi(new Promise((resolve) => (answer = resolve)))
  const first = retainUsageLimitResumes(fake.api)
  const second = retainUsageLimitResumes(fake.api)
  expect(fake.listeners.size).toBe(1)
  fake.push(stopped('pushed'))
  answer(stopped('read'))
  await Promise.resolve()
  expect(useUsageLimitResumeStore.getState().state?.notices[0].agentId).toBe('pushed')
  first()
  expect(fake.listeners.size).toBe(1)
  second()
  expect(fake.listeners.size).toBe(0)
})

test("an update takes main's answer, and a chat's notice is found by its identity", async () => {
  const fake = fakeApi(Promise.resolve(stopped('a')))
  await updateUsageLimitResume({ kind: 'auto', enabled: true }, fake.api)
  expect(fake.updates).toEqual([{ kind: 'auto', enabled: true }])
  expect(useUsageLimitResumeStore.getState().state).toEqual({ autoResume: true, notices: [] })
  const state = stopped('agent-1')
  expect(selectUsageLimitResumeNotice(state, { workspaceId: 'ws-1', agentId: 'agent-1' })?.agentId).toBe('agent-1')
  expect(selectUsageLimitResumeNotice(state, { workspaceId: 'ws-2', agentId: 'agent-1' })).toBe(null)
  expect(selectUsageLimitResumeNotice(null, { workspaceId: 'ws-1', agentId: 'agent-1' })).toBe(null)
})
