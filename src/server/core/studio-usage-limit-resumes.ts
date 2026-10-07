import { join } from 'node:path'

import type {
  ConversationEvent,
  ConversationMessageOrigin,
  ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import { usageLimitKindOf } from '../../shared/usage-limit-resume'
import type { UsageLimitHit, UsageLimitProvider, UsageLimitsState } from '../../shared/usage-limits'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { ConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import {
  createUsageLimitResumer,
  USAGE_LIMIT_RESUMES_FILE,
  usageLimitResumeFileStorage,
  type UsageLimitResumer,
  type UsageLimitResumeStorage,
} from '../../main/usage-limits/resume'
import {
  onUsageLimitHit,
  usageLimitsStore,
  usageRateLimit,
  type UsageRateLimitAnswer,
} from '../../main/usage-limits/store'

// The Studio core's resumes after a usage limit (main/usage-limits/resume.ts),
// wired to what the core holds: the limit hits and windows of this process's
// store, its chats and their events, the registry's records, and a
// conversation host whose sends are Studio's own. Kept apart from the core's
// composition so the wiring is tested as the core builds it.

/** The client a resume after a usage limit is sent as, for the runtime's command receipts. */
export const STUDIO_RESUME_CLIENT_ID = 'studio-usage-limit-resume'

/** How a chat records a resume: Studio's, sent because its usage limit reset. */
export const USAGE_RESUME_ORIGIN: ConversationMessageOrigin = { kind: 'studio', reason: 'usage-resume' }

export type StudioUsageLimitResumesDeps = {
  dataDir: string
  conversations: {
    listSessions(): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
    onEvent(listener: (event: ConversationEvent) => void): () => void
  }
  /** A workspace's record: whether it is settled, and the agents (chats) it holds. */
  workspaceRecord: (workspaceId: string) => { settledAt?: number | null; agents: Record<string, unknown> } | null
  /** A conversation host whose sends carry `origin` and stamp no one's message clock. */
  createHost: (options: {
    origin: ConversationMessageOrigin
  }) => Pick<ConversationGatewayHost, 'resolveKey' | 'command'>
  /** The usage limits; the app's one store unless a test hands its own. */
  usage?: {
    onLimitHit: (listener: (hit: UsageLimitHit) => void) => () => void
    rateLimit: (provider: UsageLimitProvider, now: number) => UsageRateLimitAnswer
    state: () => UsageLimitsState
  }
  storage?: UsageLimitResumeStorage
  now?: () => number
  log?: (message: string) => void
}

export function createStudioUsageLimitResumes(deps: StudioUsageLimitResumesDeps): UsageLimitResumer {
  const usage = deps.usage ?? {
    onLimitHit: onUsageLimitHit,
    rateLimit: (provider: UsageLimitProvider, now: number) => usageRateLimit(provider, now),
    state: () => usageLimitsStore().state(),
  }
  let host: ReturnType<StudioUsageLimitResumesDeps['createHost']> | null = null
  return createUsageLimitResumer({
    storage: deps.storage ?? usageLimitResumeFileStorage(join(deps.dataDir, USAGE_LIMIT_RESUMES_FILE)),
    onLimitHit: usage.onLimitHit,
    rateLimit: usage.rateLimit,
    limitKind: (provider, windowId) => {
      if (!windowId) return null
      const window = usage
        .state()
        .snapshots.find((snapshot) => snapshot.provider === provider)
        ?.windows.find((candidate) => candidate.id === windowId)
      return usageLimitKindOf(windowId, window?.durationMs)
    },
    listSessions: () => {
      const listed = deps.conversations.listSessions()
      return listed.ok ? listed.sessions : []
    },
    onConversationEvent: (listener) => deps.conversations.onEvent(listener),
    // Whether the chat is still there and awake. When the person last wrote to
    // it is read off its own sessions by the resumer: the record's clock is
    // the workspace's, which another chat in it moves.
    chat: ({ workspaceId, agentId }) => {
      const record = deps.workspaceRecord(workspaceId)
      if (!record || !Object.hasOwn(record.agents, agentId)) return null
      return { settled: isSettledWorkspace(record) }
    },
    // Through the same send a paired device's goes, which resumes a chat with
    // no live session from its record, marked as Studio's.
    send: async (chat, message, commandId) => {
      host ??= deps.createHost({ origin: USAGE_RESUME_ORIGIN })
      const key = host.resolveKey(chat.workspaceId, chat.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      return host.command(key, STUDIO_RESUME_CLIENT_ID, commandId, { kind: 'send', message })
    },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
}
