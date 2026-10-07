import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  readConversationMessageOrigin,
  type ConversationEvent,
  type ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import { conversationSummaryPhase } from '../../shared/conversation/phase'
import { isRecord } from '../../shared/records'
import type {
  UsageLimitKind,
  UsageLimitResumeChat,
  UsageLimitResumeNotice,
  UsageLimitResumeState,
  UsageLimitResumeUpdate,
} from '../../shared/usage-limit-resume'
import { USAGE_LIMIT_PROVIDERS, type UsageLimitHit, type UsageLimitProvider } from '../../shared/usage-limits'
import { STUDIO_NOTICE_PREFIX } from '../../shared/studio-notice'
import { writeFileAtomically } from '../config-file-write'
import type { UsageRateLimitAnswer } from './store'

// A chat a usage limit stopped picks up again when the limit resets.
//
// When a chat's turn fails on a usage limit (the store's `onLimitHit`), the
// chat gets a notice: which limit, when it resets, and Resume at reset. With
// the setting on, the resume is scheduled without asking. A scheduled resume
// is one short turn, sent through the chat's normal send path a minute or so
// after the reset, saying the limit has reset and to carry on.
//
// The resumes are kept in a small file in the data directory, so a resume due
// while the app was closed goes out once it is open again. One timer, armed for
// the soonest; never trusted for long, since a timer does not count the time a
// computer sleeps: waking, unlocking and starting all read the wall clock again.
//
// When one comes due it goes out only if it still makes sense:
//
// - the chat still exists and has not been put to rest (Settle): a settled
//   chat is one the person put away, and a resume would bring its agent back.
//   A snoozed chat is resumed: a snooze is "show me this later", and the work
//   being done by the time it wakes is what the person would want. The row
//   stays asleep; only the agent works;
// - the chat is idle: not running a turn, not waiting on a question or an
//   approval. A busy chat is looked at again a minute later, for a while;
// - the person has not sent the chat anything since the limit stopped it.
//   Whatever they said is the chat's next step, and it replaces this one. The
//   chat's own messages count, not its workspace's, and only the person's: a
//   message Studio sent it (a launched agent's notice) carries Studio's origin;
// - the provider is not still limited by a window that resets later (a
//   weekly limit behind the session one): the resume moves to that reset.
//
// A chat has at most one resume, for the latest limit that stopped it, and a
// limit hit is resumed at most once: the hit is remembered, and the send
// carries a command id made from it, which the chat's runtime answers from its
// receipt if it is ever sent again. A send the chat refuses stays on the chat
// as a notice saying so, with Retry, which sends again under a new id.
//
// The resumes follow the limit hits as they happen, not the chats' records:
// a chat whose turn failed records that it failed, but not which window ran
// out or when it resets, which is what the resume waits for.

export const USAGE_LIMIT_RESUMES_FILE = 'usage-limit-resumes.json'
const FORMAT_VERSION = 1

/**
 * After the reset, how long to wait before sending. The provider's clock and
 * this computer's can disagree by seconds, and a turn sent on the stroke of
 * the reset can still be refused.
 */
const RESUME_BUFFER_MS = 60_000
/** Up to this much more, at random, so the chats one limit stopped do not all start in the same second. */
const RESUME_JITTER_MS = 30_000
/** Between two resumes going out, so several due together go one after another. */
const STAGGER_MS = 5_000
/** After start, before the first resume goes out: the app is still finding its chats. */
const STARTUP_GRACE_MS = 20_000
/** A chat busy when its resume came due is looked at again after this. */
const BUSY_RETRY_MS = 60_000
/** And given up on after this long: whatever keeps it busy has taken over the chat. */
const BUSY_GIVE_UP_MS = 30 * 60_000
/** A timer longer than this is armed again rather than trusted (sleep, a changed clock). */
const MAX_TIMER_MS = 15 * 60_000
/** A notice for a limit that never said when it lifts is kept this long. */
const UNKNOWN_RESET_NOTICE_MS = 12 * 60 * 60_000
/** How many resumed hits are remembered, so none is resumed twice. */
const MAX_RESUMED = 100
/** Ids are minted by the app and short; this only keeps a hand-edited file from carrying a strange one. */
const MAX_ID_LENGTH = 200
/** A refusal's words, as the notice keeps them. */
const MAX_FAILURE_LENGTH = 300

/**
 * The turn a resume sends. Studio's own words: the chat records it as Studio's
 * (the send's origin), and the words open with Studio's name for the agent,
 * which reads nothing else.
 */
export const USAGE_LIMIT_RESUME_MESSAGE = `${STUDIO_NOTICE_PREFIX} Continue where you left off — your usage limit has reset.`

type PendingResume = UsageLimitResumeChat & {
  provider: UsageLimitProvider
  limit: UsageLimitKind
  resetsAt: number | null
  hitAt: number
  createdAt: number
  /** When it goes out, or null while it is only a notice. */
  fireAt: number | null
  /** When it first came due, for giving up on a chat that stays busy. */
  dueSince?: number
  /** The chat refused the resume, in its words: kept as a notice until Retry or Dismiss. */
  failure?: string
  /** How many times Retry sent it again; each send needs a command id of its own. */
  attempt?: number
}

type ResumedHit = UsageLimitResumeChat & { hitAt: number; at: number }

export type UsageLimitResumeStorage = {
  /** The file's text, or null when there is none. */
  read(): Promise<string | null>
  write(body: string): Promise<void>
}

export type UsageLimitResumeSendResult = { ok: boolean; code?: string; message?: string; retryAfterMs?: number }

export type UsageLimitResumerDeps = {
  storage: UsageLimitResumeStorage
  onLimitHit: (listener: (hit: UsageLimitHit) => void) => () => void
  rateLimit: (provider: UsageLimitProvider, now: number) => UsageRateLimitAnswer
  /** Which of the plan's limits a window is, for the notice's words. */
  limitKind?: (provider: UsageLimitProvider, windowId: string | null) => UsageLimitKind
  listSessions: () => ConversationSessionSummary[]
  onConversationEvent: (listener: (event: ConversationEvent) => void) => () => void
  /**
   * The chat as its record has it, or null for one deleted. When the person
   * last wrote to it is its sessions' (`lastUserMessageAt`, the chat's own and
   * the person's only), not the record's, which is its workspace's.
   */
  chat: (chat: UsageLimitResumeChat) => { settled: boolean } | null
  /** Send a turn through the chat's normal send path, resuming its session when none is live. */
  send: (chat: UsageLimitResumeChat, message: string, commandId: string) => Promise<UsageLimitResumeSendResult>
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
}

export type UsageLimitResumer = {
  /** Read the file, follow the limit hits and the chats, and arm for what is due. */
  start(): Promise<void>
  /** The computer woke or was unlocked: timers stood still while it slept, so read the clock again. */
  wake(): void
  /** Chats may have been deleted: forget their resumes. */
  prune(): void
  state(): UsageLimitResumeState
  update(update: UsageLimitResumeUpdate): UsageLimitResumeState
  onChanged(listener: (state: UsageLimitResumeState) => void): () => void
  /** Stop the timer and the listeners, and let the last write land. */
  dispose(): Promise<void>
}

const chatKey = (chat: UsageLimitResumeChat): string => `${chat.workspaceId}\0${chat.agentId}`

const BUSY_PHASES = new Set(['starting', 'running', 'waiting_for_approval', 'waiting_for_input'])

export function createUsageLimitResumer(deps: UsageLimitResumerDeps): UsageLimitResumer {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return timer
    })
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => undefined)

  let autoResume = false
  const pending = new Map<string, PendingResume>()
  let resumed: ResumedHit[] = []
  const listeners = new Set<(state: UsageLimitResumeState) => void>()
  const unsubscribers: Array<() => void> = []
  let timer: unknown = null
  let running = false
  // No resume goes out before this: the start's grace, then the stagger.
  let quietUntil = 0
  let writing: Promise<void> = Promise.resolve()

  const fireTimeFor = (resetsAt: number): number =>
    resetsAt + RESUME_BUFFER_MS + Math.floor(random() * RESUME_JITTER_MS)

  // ── Keeping ──────────────────────────────────────────────────────────────

  function persist(): void {
    const body = JSON.stringify({
      version: FORMAT_VERSION,
      autoResume,
      pending: [...pending.values()],
      resumed,
    })
    writing = writing
      .then(() => deps.storage.write(body))
      .catch((error: unknown) => {
        log(`Could not save the usage-limit resumes: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  function state(): UsageLimitResumeState {
    return {
      autoResume,
      notices: [...pending.values()].map((entry): UsageLimitResumeNotice => ({
        workspaceId: entry.workspaceId,
        agentId: entry.agentId,
        provider: entry.provider,
        limit: entry.limit,
        resetsAt: entry.resetsAt,
        hitAt: entry.hitAt,
        resumeAt: entry.fireAt,
        ...(entry.failure ? { failure: entry.failure } : {}),
      })),
    }
  }

  function changed(): void {
    persist()
    const next = state()
    for (const listener of [...listeners]) listener(next)
    arm()
  }

  /** Drop what says nothing true any more. True when something went. */
  function dropStale(at: number): boolean {
    let dropped = false
    for (const [key, entry] of pending) {
      const gone = deps.chat(entry) === null
      // A notice nobody scheduled is about a limit that has reset. One that
      // says a resume failed stays until the person has read it.
      const lapsed =
        entry.fireAt === null &&
        entry.failure === undefined &&
        (entry.resetsAt !== null ? entry.resetsAt <= at : at - entry.hitAt > UNKNOWN_RESET_NOTICE_MS)
      if (gone || lapsed) {
        pending.delete(key)
        dropped = true
      }
    }
    return dropped
  }

  function rememberResumed(entry: PendingResume, at: number): void {
    if (wasResumed(entry, entry.hitAt)) return
    resumed = [...resumed, { workspaceId: entry.workspaceId, agentId: entry.agentId, hitAt: entry.hitAt, at }].slice(
      -MAX_RESUMED,
    )
  }

  const wasResumed = (chat: UsageLimitResumeChat, hitAt: number): boolean =>
    resumed.some((hit) => hit.hitAt === hitAt && hit.workspaceId === chat.workspaceId && hit.agentId === chat.agentId)

  // ── What the chats say ───────────────────────────────────────────────────

  function onLimitHit(hit: UsageLimitHit): void {
    const session = deps.listSessions().find((candidate) => candidate.sessionId === hit.sessionId)
    // A chat this process does not run (a WSL or SSH server's) is that server's to resume.
    if (!session) return
    const chat = { workspaceId: session.workspaceId, agentId: session.agentId }
    if (wasResumed(chat, hit.at)) return
    const at = now()
    const limit = deps.rateLimit(hit.provider, at)
    let resetsAt = hit.resetsAt ?? limit.resetsAt
    // A reset already behind us is not one to wait for: whatever said it was
    // wrong, or the limit is one this does not know the end of.
    if (resetsAt !== null && resetsAt <= at) resetsAt = null
    const windowId = hit.windowId ?? limit.windowId
    const entry: PendingResume = {
      ...chat,
      provider: hit.provider,
      limit: deps.limitKind?.(hit.provider, windowId) ?? null,
      resetsAt,
      hitAt: hit.at,
      createdAt: at,
      fireAt: autoResume && resetsAt !== null ? fireTimeFor(resetsAt) : null,
    }
    // One per chat: the latest limit that stopped it is the one to wait for.
    pending.set(chatKey(chat), entry)
    changed()
  }

  function onConversationEvent(event: ConversationEvent): void {
    if (event.type !== 'user_message') return
    // Studio's own message (this resume going in, a launched agent's notice)
    // is not the person taking the chat's next step.
    if (readConversationMessageOrigin(event.payload?.origin)) return
    // The person said something: that is the chat's next step, not this.
    if (pending.delete(chatKey(event))) changed()
  }

  // ── When one comes due ───────────────────────────────────────────────────

  function arm(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!running) return
    let soonest: number | null = null
    for (const entry of pending.values())
      if (entry.fireAt !== null && (soonest === null || entry.fireAt < soonest)) soonest = entry.fireAt
    if (soonest === null) return
    const delay = Math.max(0, Math.min(Math.max(soonest, quietUntil) - now(), MAX_TIMER_MS))
    timer = setTimer(tick, delay)
  }

  function tick(): void {
    timer = null
    if (!running) return
    const at = now()
    const dropped = dropStale(at)
    if (at >= quietUntil) {
      let due: PendingResume | null = null
      for (const entry of pending.values())
        if (entry.fireAt !== null && entry.fireAt <= at && (due === null || entry.fireAt < due.fireAt!)) due = entry
      if (due) {
        quietUntil = at + STAGGER_MS
        // Every way out of `fire` says what changed, and arms again.
        fire(due, at)
        return
      }
    }
    if (dropped) changed()
    else arm()
  }

  function fire(entry: PendingResume, at: number): void {
    const key = chatKey(entry)
    const drop = (why: string): void => {
      pending.delete(key)
      log(`A chat's resume after its usage limit was not sent: ${why}.`)
      changed()
    }
    const record = deps.chat(entry)
    if (!record) return drop('the chat was deleted')
    if (record.settled) return drop('the chat was put to rest')
    // This chat's own sessions: another chat in its workspace being written to
    // is not this one's next step.
    const sessions = deps
      .listSessions()
      .filter((session) => session.workspaceId === entry.workspaceId && session.agentId === entry.agentId)
    const lastSent = Math.max(0, ...sessions.map((session) => session.lastUserMessageAt ?? 0))
    if (lastSent > entry.hitAt) return drop('the person has written to it since')
    // Still held back by a window that resets later: wait for that one.
    const limit = deps.rateLimit(entry.provider, at)
    if (limit.limited && limit.resetsAt !== null && limit.resetsAt > at) {
      entry.resetsAt = limit.resetsAt
      entry.limit = deps.limitKind?.(entry.provider, limit.windowId) ?? entry.limit
      entry.fireAt = fireTimeFor(limit.resetsAt)
      entry.dueSince = undefined
      return changed()
    }
    const live = sessions.filter((session) => session.status !== 'stopped' && session.status !== 'failed')
    if (live.some((session) => BUSY_PHASES.has(conversationSummaryPhase(session)))) {
      entry.dueSince ??= at
      if (at - entry.dueSince > BUSY_GIVE_UP_MS) return drop('the chat stayed busy')
      entry.fireAt = at + BUSY_RETRY_MS
      return changed()
    }
    pending.delete(key)
    rememberResumed(entry, at)
    changed()
    void send(entry)
  }

  async function send(entry: PendingResume): Promise<void> {
    const key = chatKey(entry)
    let result: UsageLimitResumeSendResult
    try {
      result = await deps.send(
        { workspaceId: entry.workspaceId, agentId: entry.agentId },
        USAGE_LIMIT_RESUME_MESSAGE,
        // A retry is a new command: the first one's receipt answers its own id
        // with its refusal.
        `usage-limit-resume:${entry.hitAt}${entry.attempt ? `:${entry.attempt}` : ''}`,
      )
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok || !running) return
    // Something newer has taken the chat's place meanwhile: that one stands.
    if (pending.has(key)) return
    // A turn that started between the look and the send: the same wait as a
    // busy chat.
    if (result.code === 'busy') {
      const at = now()
      entry.dueSince ??= at
      if (at - entry.dueSince <= BUSY_GIVE_UP_MS) {
        entry.fireAt = at + Math.max(BUSY_RETRY_MS, result.retryAfterMs ?? 0)
        pending.set(key, entry)
        changed()
        return
      }
    }
    // Refused: the chat says so, with Retry, rather than a line in a log
    // nobody reads.
    const reason = failureWords(result.message)
    log(`A chat's resume after its usage limit was not sent: ${reason}.`)
    entry.failure = reason
    entry.fireAt = null
    entry.dueSince = undefined
    pending.set(key, entry)
    changed()
  }

  // ── What a window asks ───────────────────────────────────────────────────

  function update(input: UsageLimitResumeUpdate): UsageLimitResumeState {
    if (input.kind === 'auto') {
      if (autoResume !== input.enabled) {
        autoResume = input.enabled
        // On, it schedules every chat already waiting on a reset still ahead,
        // as it would have had it been on when the limit stopped them. A
        // resume that failed waits for its Retry; one cancelled is
        // scheduled again, which is what turning this on asks for.
        if (autoResume) {
          const at = now()
          for (const entry of pending.values())
            if (entry.fireAt === null && entry.failure === undefined && entry.resetsAt !== null && entry.resetsAt > at)
              entry.fireAt = fireTimeFor(entry.resetsAt)
        }
        changed()
      }
      return state()
    }
    const key = chatKey(input)
    const entry = pending.get(key)
    if (!entry) return state()
    if (input.kind === 'dismiss') pending.delete(key)
    else if (input.kind === 'cancel') {
      entry.fireAt = null
      entry.dueSince = undefined
    } else if (input.kind === 'retry') {
      if (entry.failure === undefined) return state()
      entry.failure = undefined
      entry.attempt = (entry.attempt ?? 0) + 1
      entry.dueSince = undefined
      entry.fireAt = now()
    } else {
      if (entry.resetsAt === null) return state()
      entry.failure = undefined
      entry.fireAt = entry.resetsAt > now() ? fireTimeFor(entry.resetsAt) : now()
    }
    changed()
    return state()
  }

  // ── Life ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (running) return
    running = true
    quietUntil = now() + STARTUP_GRACE_MS
    unsubscribers.push(deps.onLimitHit(onLimitHit), deps.onConversationEvent(onConversationEvent))
    const saved = readSaved(await deps.storage.read().catch(() => null))
    if (!running) return
    autoResume = saved.autoResume
    resumed = saved.resumed
    // A hit heard while the file was being read is newer than the file.
    for (const entry of saved.pending) if (!pending.has(chatKey(entry))) pending.set(chatKey(entry), entry)
    if (dropStale(now())) persist()
    const next = state()
    for (const listener of [...listeners]) listener(next)
    arm()
  }

  return {
    start,
    wake() {
      if (!running) return
      if (timer !== null) clearTimer(timer)
      timer = null
      tick()
    },
    prune() {
      if (pending.size === 0) return
      if (dropStale(now())) changed()
    },
    state() {
      if (dropStale(now())) changed()
      return state()
    },
    update,
    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      running = false
      if (timer !== null) clearTimer(timer)
      timer = null
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      listeners.clear()
      await writing
    },
  }
}

/** The resumes kept in `file`: a missing or unreadable one is an empty one. */
export function usageLimitResumeFileStorage(file: string): UsageLimitResumeStorage {
  return {
    async read() {
      try {
        return await readFile(file, 'utf8')
      } catch {
        return null
      }
    },
    async write(body) {
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomically(file, body)
    },
  }
}

// ── The file ──────────────────────────────────────────────────────────────

type Saved = { autoResume: boolean; pending: PendingResume[]; resumed: ResumedHit[] }

function readSaved(text: string | null): Saved {
  const empty: Saved = { autoResume: false, pending: [], resumed: [] }
  if (!text) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION) return empty
  const pendingEntries = Array.isArray(parsed.pending) ? parsed.pending.flatMap(readPending) : []
  const resumedHits = Array.isArray(parsed.resumed) ? parsed.resumed.flatMap(readResumed).slice(-MAX_RESUMED) : []
  return { autoResume: parsed.autoResume === true, pending: pendingEntries, resumed: resumedHits }
}

function readPending(raw: unknown): PendingResume[] {
  if (!isRecord(raw) || !id(raw.workspaceId) || !id(raw.agentId)) return []
  if (!USAGE_LIMIT_PROVIDERS.includes(raw.provider as UsageLimitProvider)) return []
  if (!time(raw.hitAt) || !time(raw.createdAt)) return []
  const limit: UsageLimitKind = raw.limit === 'session' || raw.limit === 'weekly' ? raw.limit : null
  return [
    {
      workspaceId: raw.workspaceId,
      agentId: raw.agentId,
      provider: raw.provider as UsageLimitProvider,
      limit,
      resetsAt: time(raw.resetsAt) ? raw.resetsAt : null,
      hitAt: raw.hitAt,
      createdAt: raw.createdAt,
      fireAt: time(raw.fireAt) ? raw.fireAt : null,
      ...(time(raw.dueSince) ? { dueSince: raw.dueSince } : {}),
      ...(typeof raw.failure === 'string' && raw.failure ? { failure: failureWords(raw.failure) } : {}),
      ...(typeof raw.attempt === 'number' && Number.isInteger(raw.attempt) && raw.attempt > 0
        ? { attempt: raw.attempt }
        : {}),
    },
  ]
}

/** A refusal in a few words, one line, as the notice shows it. */
function failureWords(message: string | undefined): string {
  const flat = (message ?? '').replace(/\s+/gu, ' ').trim().replace(/\.$/u, '')
  if (!flat) return 'the chat refused it'
  return flat.length > MAX_FAILURE_LENGTH ? `${flat.slice(0, MAX_FAILURE_LENGTH - 1).trimEnd()}…` : flat
}

function readResumed(raw: unknown): ResumedHit[] {
  if (!isRecord(raw) || !id(raw.workspaceId) || !id(raw.agentId) || !time(raw.hitAt) || !time(raw.at)) return []
  return [{ workspaceId: raw.workspaceId, agentId: raw.agentId, hitAt: raw.hitAt, at: raw.at }]
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
