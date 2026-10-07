// The Studio core's resumes after a usage limit, wired as the core builds
// them: the chat each resume is for is its own agent's record and sessions,
// not its workspace's; the send goes through a host whose sends are Studio's;
// and a window's kind is read off the store's reading.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { UsageLimitHit, UsageLimitsState } from '../../shared/usage-limits'
import type { UsageLimitResumeStorage } from '../../main/usage-limits/resume'
import {
  createStudioUsageLimitResumes,
  STUDIO_RESUME_CLIENT_ID,
  USAGE_RESUME_ORIGIN,
} from './studio-usage-limit-resumes'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 21, 0) })
})
afterEach(() => {
  vi.useRealTimers()
})

function session(agentId: string, overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: `s-${agentId}`,
    workspaceId: 'ws-1',
    agentId,
    providerId: 'claude-agent',
    modelId: 'default',
    status: 'failed',
    createdAt: Date.now() - HOUR,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function wiring() {
  const sessions: ConversationSessionSummary[] = [session('agent-1'), session('agent-2')]
  const records = new Map<string, { settledAt?: number | null; agents: Record<string, unknown> }>([
    ['ws-1', { agents: { 'agent-1': {}, 'agent-2': {} } }],
  ])
  const hitListeners = new Set<(hit: UsageLimitHit) => void>()
  const eventListeners = new Set<(event: ConversationEvent) => void>()
  const hosts: unknown[] = []
  const commands: unknown[][] = []
  let body: string | null = null
  const storage: UsageLimitResumeStorage = {
    read: async () => body,
    write: async (next) => {
      body = next
    },
  }
  const usageState: UsageLimitsState = {
    snapshots: [
      {
        provider: 'claude',
        billing: 'subscription',
        observedAt: Date.now(),
        windows: [
          {
            id: 'seven_day',
            label: 'Weekly',
            usedPercent: 100,
            resetsAt: Date.now() + HOUR,
            durationMs: 7 * DAY,
            status: 'rejected',
            observedAt: Date.now(),
          },
        ],
      },
    ],
  }
  const resumer = createStudioUsageLimitResumes({
    dataDir: '/Users/dev/Library/Application Support/Studio',
    conversations: {
      listSessions: () => ({ ok: true, sessions }),
      onEvent: (listener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
    },
    workspaceRecord: (workspaceId) => records.get(workspaceId) ?? null,
    createHost: (options) => {
      hosts.push(options)
      return {
        resolveKey: (workspaceId: string, agentId: string) => ({
          workspaceRoot: '/Users/dev/app',
          workspaceId,
          agentId,
        }),
        command: async (...args: unknown[]) => {
          commands.push(args)
          return { ok: true }
        },
      } as never
    },
    usage: {
      onLimitHit: (listener) => {
        hitListeners.add(listener)
        return () => hitListeners.delete(listener)
      },
      // The provider has lifted by the time the resume is due.
      rateLimit: () => ({ limited: false, resetsAt: null, windowId: null }),
      state: () => usageState,
    },
    storage,
    now: () => Date.now(),
  })
  const hit = (agentId: string, input: Partial<UsageLimitHit> = {}) => {
    const event: UsageLimitHit = {
      provider: 'claude',
      sessionId: `s-${agentId}`,
      resetsAt: Date.now() + HOUR,
      windowId: 'seven_day',
      at: Date.now(),
      ...input,
    }
    for (const listener of hitListeners) listener(event)
    return event
  }
  return { resumer, sessions, records, hosts, commands, hit }
}

test('a resume goes through a host whose sends are Studio’s, under the resume’s own client and command', async () => {
  const w = wiring()
  await w.resumer.start()
  w.resumer.update({ kind: 'auto', enabled: true })
  const { at } = w.hit('agent-1', { windowId: 'seven_day' })
  // Its kind read off the store's reading of the window.
  assert.equal(w.resumer.state().notices[0]?.limit, 'weekly')

  await vi.advanceTimersByTimeAsync(HOUR + 2 * MINUTE)
  assert.deepEqual(w.hosts, [{ origin: USAGE_RESUME_ORIGIN }])
  assert.deepEqual(USAGE_RESUME_ORIGIN, { kind: 'studio', reason: 'usage-resume' })
  assert.equal(w.commands.length, 1)
  const [key, clientId, commandId, command] = w.commands[0]!
  assert.deepEqual(key, { workspaceRoot: '/Users/dev/app', workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.equal(clientId, STUDIO_RESUME_CLIENT_ID)
  assert.equal(commandId, `usage-limit-resume:${at}`)
  assert.equal((command as { kind: string }).kind, 'send')
  await w.resumer.dispose()
})

test('the person writing to another chat in the workspace does not take this chat’s resume back', async () => {
  const w = wiring()
  await w.resumer.start()
  w.resumer.update({ kind: 'auto', enabled: true })
  w.hit('agent-1')
  // The workspace's own clock moved; this chat's sessions did not.
  w.sessions[1]!.lastUserMessageAt = Date.now() + MINUTE
  await vi.advanceTimersByTimeAsync(HOUR + 2 * MINUTE)
  assert.equal(w.commands.length, 1)

  // This chat's own did: that is the person taking its next step.
  const again = wiring()
  await again.resumer.start()
  again.resumer.update({ kind: 'auto', enabled: true })
  again.hit('agent-1')
  again.sessions[0]!.lastUserMessageAt = Date.now() + MINUTE
  await vi.advanceTimersByTimeAsync(HOUR + 2 * MINUTE)
  assert.equal(again.commands.length, 0)
  await w.resumer.dispose()
  await again.resumer.dispose()
})

test('a chat is the agent in its record: one removed from it, or a settled workspace, is not resumed', async () => {
  const w = wiring()
  await w.resumer.start()
  w.resumer.update({ kind: 'auto', enabled: true })
  w.hit('agent-1')
  w.hit('agent-2')
  w.records.set('ws-1', { agents: { 'agent-2': {} }, settledAt: Date.now() })
  w.resumer.prune()
  assert.deepEqual(
    w.resumer.state().notices.map((notice) => notice.agentId),
    ['agent-2'],
  )
  await vi.advanceTimersByTimeAsync(HOUR + 2 * MINUTE)
  assert.equal(w.commands.length, 0, 'the settled chat is put away, not woken')
  await w.resumer.dispose()
})
