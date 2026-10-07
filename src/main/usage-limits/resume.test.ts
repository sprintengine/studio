// A chat a usage limit stopped picks up again when the limit resets: the
// notice, the schedule kept in a file, the one timer and its re-arming on wake
// and start, every check made when a resume comes due, and the ways one is
// taken back.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import type {
  ConversationEvent,
  ConversationMessageOrigin,
  ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import type { UsageLimitHit, UsageLimitProvider } from '../../shared/usage-limits'
import {
  createUsageLimitResumer,
  USAGE_LIMIT_RESUME_MESSAGE,
  usageLimitResumeFileStorage,
  type UsageLimitResumeSendResult,
  type UsageLimitResumeStorage,
} from './resume'
import type { UsageRateLimitAnswer } from './store'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.UTC(2026, 9, 7, 21, 0)
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const OTHER = { workspaceId: 'ws-2', agentId: 'agent-2' }

const scratch = mkdtempSync(join(tmpdir(), 'se-usage-resume-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function memoryStorage(initial: string | null = null): UsageLimitResumeStorage & { body: string | null } {
  const storage = {
    body: initial,
    read: async () => storage.body,
    write: async (body: string) => {
      storage.body = body
    },
  }
  return storage
}

type Harness = ReturnType<typeof harness>

function harness(options: { storage?: UsageLimitResumeStorage; now?: number } = {}) {
  let now = options.now ?? T0
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = []
  const hitListeners = new Set<(hit: UsageLimitHit) => void>()
  const eventListeners = new Set<(event: ConversationEvent) => void>()
  const sessions: ConversationSessionSummary[] = []
  const records = new Map<string, { settled: boolean; lastUserMessageAt: number | null }>()
  const sent: Array<{ chat: typeof CHAT; message: string; commandId: string }> = []
  const limits = new Map<UsageLimitProvider, UsageRateLimitAnswer>()
  const storage = options.storage ?? memoryStorage()
  let sendAnswer: (chat: typeof CHAT) => UsageLimitResumeSendResult = () => ({ ok: true })
  const logs: string[] = []

  const resumer = createUsageLimitResumer({
    storage,
    onLimitHit: (listener) => {
      hitListeners.add(listener)
      return () => hitListeners.delete(listener)
    },
    rateLimit: (provider) => limits.get(provider) ?? { limited: false, resetsAt: null, windowId: null },
    limitKind: (_provider, windowId) =>
      windowId === 'five_hour' ? 'session' : windowId === 'seven_day' ? 'weekly' : null,
    listSessions: () => sessions,
    onConversationEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    chat: (chat) => records.get(`${chat.workspaceId}/${chat.agentId}`) ?? null,
    send: async (chat, message, commandId) => {
      sent.push({ chat, message, commandId })
      // The runtime records the message as it goes in, as a real send does:
      // marked as Studio's, which the send asks for.
      for (const listener of eventListeners)
        listener(userMessage(chat, now, { kind: 'studio', reason: 'usage-resume' }))
      return sendAnswer(chat)
    },
    now: () => now,
    random: () => 0.5,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    log: (message) => logs.push(message),
  })

  function addChat(chat = CHAT, session: Partial<ConversationSessionSummary> = {}) {
    records.set(`${chat.workspaceId}/${chat.agentId}`, { settled: false, lastUserMessageAt: null })
    sessions.push({
      sessionId: `s-${chat.agentId}`,
      ...chat,
      providerId: 'claude-agent',
      modelId: 'default',
      status: 'ready',
      createdAt: T0 - HOUR,
      updatedAt: T0,
      phase: 'failed',
      ...session,
    })
  }

  function hit(chat = CHAT, input: Partial<UsageLimitHit> = {}) {
    const event: UsageLimitHit = {
      provider: 'claude',
      sessionId: `s-${chat.agentId}`,
      resetsAt: now + 2 * HOUR,
      windowId: 'five_hour',
      at: now,
      ...input,
    }
    for (const listener of hitListeners) listener(event)
  }

  /** Move the wall clock, running each timer whose time came, as a computer that stays awake would. */
  async function advance(ms: number) {
    const target = now + ms
    for (;;) {
      const next = timers.filter((timer) => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      next.cleared = true
      now = Math.max(now, next.at)
      next.callback()
      await settle()
    }
    now = target
  }

  /** Move the wall clock with no timer running: the computer slept, or the app was closed. */
  function jump(ms: number) {
    now += ms
  }

  function armed(): number[] {
    return timers.filter((timer) => !timer.cleared).map((timer) => timer.at)
  }

  return {
    resumer,
    storage,
    sessions,
    records,
    sent,
    limits,
    logs,
    hitListeners,
    addChat,
    hit,
    advance,
    jump,
    armed,
    emit: (event: ConversationEvent) => eventListeners.forEach((listener) => listener(event)),
    answerSends: (answer: typeof sendAnswer) => {
      sendAnswer = answer
    },
    now: () => now,
  }
}

function userMessage(chat: typeof CHAT, at: number, origin?: ConversationMessageOrigin): ConversationEvent {
  return {
    id: `u-${at}`,
    sessionId: `s-${chat.agentId}`,
    ...chat,
    providerId: 'claude-agent',
    modelId: 'default',
    type: 'user_message',
    createdAt: at,
    payload: { text: 'hello', ...(origin ? { origin } : {}) },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function started(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = harness(options)
  await h.resumer.start()
  return h
}

const notice = (h: Harness) => h.resumer.state().notices.find((entry) => entry.agentId === CHAT.agentId) ?? null

test('a limit hit puts a notice on the chat, with when it resets, and schedules nothing while the setting is off', async () => {
  const h = await started()
  h.addChat()
  h.hit()
  assert.deepEqual(notice(h), {
    ...CHAT,
    provider: 'claude',
    limit: 'session',
    resetsAt: T0 + 2 * HOUR,
    hitAt: T0,
    resumeAt: null,
  })
  assert.deepEqual(h.armed(), [])
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
  // Unscheduled, the notice goes once the limit has reset: it says nothing true then.
  assert.equal(notice(h), null)
})

test('Resume at reset schedules the resume a minute and a bit after the reset, and sends it then', async () => {
  const h = await started()
  h.addChat()
  h.hit()
  h.resumer.update({ kind: 'schedule', ...CHAT })
  const resumeAt = notice(h)!.resumeAt!
  assert.ok(resumeAt >= T0 + 2 * HOUR + MINUTE && resumeAt <= T0 + 2 * HOUR + MINUTE + 30_000, String(resumeAt))
  await h.advance(2 * HOUR)
  assert.equal(h.sent.length, 0)
  await h.advance(2 * MINUTE)
  assert.deepEqual(h.sent, [{ chat: CHAT, message: USAGE_LIMIT_RESUME_MESSAGE, commandId: `usage-limit-resume:${T0}` }])
  assert.match(USAGE_LIMIT_RESUME_MESSAGE, /^\[SprintEngine Studio\] Continue where you left off/)
  // Sent: the notice is gone, and Studio's own message did not count as the person's.
  assert.equal(notice(h), null)
})

test('with the setting on, a hit is scheduled at once, and Cancel keeps the notice without the schedule', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  assert.ok(notice(h)!.resumeAt !== null)
  h.resumer.update({ kind: 'cancel', ...CHAT })
  assert.equal(notice(h)!.resumeAt, null)
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
})

test('Dismiss drops the notice and whatever it had scheduled', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.resumer.update({ kind: 'dismiss', ...CHAT })
  assert.equal(notice(h), null)
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
})

test('the person writing to the chat takes the resume back', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.jump(10 * MINUTE)
  h.emit(userMessage(CHAT, h.now()))
  assert.equal(notice(h), null)
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
})

test('a message Studio sent the chat (a launched agent’s notice) does not take the resume back', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.jump(10 * MINUTE)
  h.emit(userMessage(CHAT, h.now(), { kind: 'studio', reason: 'agent-notice' }))
  assert.notEqual(notice(h), null)
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 1)
})

test('a message the person sent that the event stream missed still stops the resume when it comes due', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.records.get('ws-1/agent-1')!.lastUserMessageAt = T0 + HOUR
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
  assert.equal(notice(h), null)
  assert.match(h.logs.join('\n'), /written to it since/)
})

test('a chat deleted before its resume is forgotten, and none is sent', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.records.delete('ws-1/agent-1')
  h.resumer.prune()
  assert.equal(notice(h), null)
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
})

test('a chat put to rest is not resumed', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.records.get('ws-1/agent-1')!.settled = true
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
  assert.match(h.logs.join('\n'), /put to rest/)
})

test('a busy chat is looked at again a minute later, and resumed once it is idle', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat(CHAT, { phase: 'running' })
  h.hit()
  await h.advance(2 * HOUR + 2 * MINUTE)
  assert.equal(h.sent.length, 0)
  assert.ok(notice(h)!.resumeAt! > h.now())
  // Waiting on an approval is busy too.
  h.sessions[0].phase = 'waiting_for_approval'
  await h.advance(MINUTE)
  assert.equal(h.sent.length, 0)
  h.sessions[0].phase = 'completed'
  await h.advance(MINUTE)
  assert.equal(h.sent.length, 1)
})

test('a chat that stays busy is given up on', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat(CHAT, { phase: 'running' })
  h.hit()
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 0)
  assert.equal(notice(h), null)
  assert.match(h.logs.join('\n'), /stayed busy/)
})

test('a provider still limited by a window that resets later moves the resume to that reset', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  const weekly = T0 + 3 * 24 * HOUR
  h.limits.set('claude', { limited: true, resetsAt: weekly, windowId: 'seven_day' })
  await h.advance(2 * HOUR + 2 * MINUTE)
  assert.equal(h.sent.length, 0)
  assert.equal(notice(h)!.resetsAt, weekly)
  assert.equal(notice(h)!.limit, 'weekly')
  assert.ok(notice(h)!.resumeAt! > weekly)
  h.limits.delete('claude')
  await h.advance(3 * 24 * HOUR)
  assert.equal(h.sent.length, 1)
})

test('a chat has one resume: a newer hit replaces the one it had', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.jump(MINUTE)
  h.hit(CHAT, { resetsAt: h.now() + 4 * HOUR, windowId: 'seven_day' })
  const notices = h.resumer.state().notices
  assert.equal(notices.length, 1)
  assert.equal(notices[0].limit, 'weekly')
  await h.advance(5 * HOUR)
  assert.equal(h.sent.length, 1)
})

test('a limit hit is resumed once: the same hit heard again after its resume is ignored', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  await h.advance(3 * HOUR)
  assert.equal(h.sent.length, 1)
  h.hit(CHAT, { at: T0, resetsAt: h.now() + HOUR })
  assert.equal(notice(h), null)
  await h.advance(2 * HOUR)
  assert.equal(h.sent.length, 1)
})

test('a hit with no reset, or one already past, is a notice only: there is nothing to wait for', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit(CHAT, { resetsAt: null, windowId: null })
  assert.deepEqual(
    { ...notice(h)!, hitAt: 0 },
    { ...CHAT, provider: 'claude', limit: null, resetsAt: null, hitAt: 0, resumeAt: null },
  )
  h.resumer.update({ kind: 'schedule', ...CHAT })
  assert.equal(notice(h)!.resumeAt, null)
  h.hit(CHAT, { resetsAt: h.now() - MINUTE })
  assert.equal(notice(h)!.resetsAt, null)
  assert.deepEqual(h.armed(), [])
})

test('several chats due together go one after another, a few seconds apart', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat(CHAT)
  h.addChat(OTHER)
  const reset = T0 + HOUR
  h.hit(CHAT, { resetsAt: reset })
  h.hit(OTHER, { resetsAt: reset })
  // The same jitter here, so both are due at the same moment.
  const fireAt = h.resumer.state().notices[0].resumeAt!
  assert.equal(h.resumer.state().notices[1].resumeAt, fireAt)
  await h.advance(fireAt - h.now())
  assert.equal(h.sent.length, 1)
  await h.advance(4_000)
  assert.equal(h.sent.length, 1)
  await h.advance(1_000)
  assert.deepEqual(
    h.sent.map((entry) => entry.chat.agentId),
    ['agent-1', 'agent-2'],
  )
})

test('a refused send while a turn started is tried again; any other refusal is reported', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  h.answerSends(() => ({ ok: false, code: 'busy', message: 'Conversation turn is already in progress.' }))
  await h.advance(2 * HOUR + 2 * MINUTE)
  assert.equal(h.sent.length, 1)
  assert.ok(notice(h)!.resumeAt! > h.now(), 'rescheduled')
  h.answerSends(() => ({ ok: true }))
  await h.advance(2 * MINUTE)
  assert.equal(h.sent.length, 2)
  assert.equal(notice(h), null)
})

test('the schedule and the setting survive a restart, and a resume due while the app was closed goes out after start', async () => {
  const storage = memoryStorage()
  const first = await started({ storage })
  first.resumer.update({ kind: 'auto', enabled: true })
  first.addChat()
  first.hit()
  const saved = notice(first)!
  await first.resumer.dispose()

  // Closed past the reset.
  const second = harness({ storage, now: T0 + 5 * HOUR })
  second.addChat()
  await second.resumer.start()
  assert.equal(second.resumer.state().autoResume, true)
  assert.deepEqual(notice(second), saved)
  // Not at the very start: the app is still finding its chats.
  assert.equal(second.sent.length, 0)
  await second.advance(30_000)
  assert.equal(second.sent.length, 1)
})

test('waking from sleep reads the wall clock again, rather than trusting the timer', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit()
  // The timer armed for the reset never ran: the computer slept through it.
  h.jump(3 * HOUR)
  assert.equal(h.sent.length, 0)
  h.resumer.wake()
  await settle()
  assert.equal(h.sent.length, 1)
})

test('the timer is never armed further ahead than a quarter of an hour', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.addChat()
  h.hit(CHAT, { resetsAt: T0 + 3 * 24 * HOUR })
  assert.deepEqual(h.armed(), [T0 + 15 * MINUTE])
})

test('the file round-trips, and a malformed one is an empty one', async () => {
  const file = join(scratch, 'resumes.json')
  const storage = usageLimitResumeFileStorage(file)
  const first = harness({ storage })
  await first.resumer.start()
  first.resumer.update({ kind: 'auto', enabled: true })
  first.addChat()
  first.hit()
  await first.resumer.dispose()
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.version, 1)
  assert.equal(written.autoResume, true)
  assert.deepEqual(
    written.pending.map((entry: { workspaceId: string; provider: string; resetsAt: number }) => [
      entry.workspaceId,
      entry.provider,
      entry.resetsAt,
    ]),
    [['ws-1', 'claude', T0 + 2 * HOUR]],
  )

  const second = harness({ storage: usageLimitResumeFileStorage(file) })
  second.addChat()
  await second.resumer.start()
  assert.equal(second.resumer.state().notices.length, 1)

  const broken = harness({ storage: memoryStorage('{"version":1,"pending":[{"workspaceId":7}],"autoResume":"yes"}') })
  await broken.resumer.start()
  assert.deepEqual(broken.resumer.state(), { autoResume: false, notices: [] })
  const missing = harness({ storage: usageLimitResumeFileStorage(join(scratch, 'none', 'resumes.json')) })
  await missing.resumer.start()
  assert.deepEqual(missing.resumer.state(), { autoResume: false, notices: [] })
})

test('a hit for a session this process does not run is not its to resume', async () => {
  const h = await started()
  h.resumer.update({ kind: 'auto', enabled: true })
  h.hit(CHAT)
  assert.deepEqual(h.resumer.state().notices, [])
})

test('every change is told to the listeners', async () => {
  const h = await started()
  const told: number[] = []
  h.resumer.onChanged((state) => told.push(state.notices.length))
  h.addChat()
  h.hit()
  h.resumer.update({ kind: 'dismiss', ...CHAT })
  assert.deepEqual(told, [1, 0])
})
