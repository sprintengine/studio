import { connect, type StudioClient } from '../../packages/agent-sdk/src/client'
import type { StudioTransportFactory } from '../../packages/agent-sdk/src/transport'
import type { StudioPullRequest, StudioPullRequestOwner } from '../../packages/studio-protocol/src/public'
import { STUDIO_PULL_REQUESTS_CAPABILITY } from '../../packages/studio-protocol/src/public'
import type { BranchPullRequest } from '../shared/git/pull-request'

// The pull request marks of the desktop's terminal agents, read from the
// Studio server like every other client reads them (owner ruling 2026-10-03:
// features that react to agents live in the server; clients display the
// result). The terminals are the shell's, so the server cannot see them work:
// this tells it where each agent did (`pullRequests.noteWork` — its checkout
// whenever git answers for it, and the files it changed since the last time),
// and keeps the lists the server answers for the live agents, which the
// terminal snapshot carries to the windows as it always has.
//
// One path in both modes: a Studio client over the shell's own connection,
// whether the server is in this process or in its own.
//
// A list is replaced only by an answer. While the server is away (a restart)
// the marks stay as they were, and the files an agent changed meanwhile are
// kept until a note carrying them is accepted.

/** What this needs of a terminal session. Structural, so it can be tested without a pty. */
export type PullRequestTerminalSession = {
  sessionId: string
  kind?: string
  workspaceId?: string
  agentId?: string
  observedCheckout?: { resolved: boolean; gitRoot: string | null; branch: string | null } | null
}

export type TerminalPullRequests = {
  /** The marks a session wears now. Synchronous: the snapshot is built from it. */
  listForSession(session: PullRequestTerminalSession): BranchPullRequest[]
  /** Git answered for a session's checkout: at a turn end or a start (`fresh`), or a move. */
  noteCheckoutResolved(session: PullRequestTerminalSession, resolution: { fresh: boolean }): void
  /** An agent session changed a file. */
  noteFileEdit(session: PullRequestTerminalSession, path: string): void
  /** A hover: ask again. False when there is nothing to ask about yet. */
  refreshForSession(sessionId: string): boolean
  start(): Promise<void>
  stop(): void
}

/** The most changed paths kept for one agent between notes. */
const MAX_PENDING_PATHS = 256
/** Changes heard in a burst are fetched once. */
const FETCH_COALESCE_MS = 100
const FIRST_CONNECT_RETRY_MS = { initial: 250, max: 10_000 }

export function createTerminalPullRequests(options: {
  transport: StudioTransportFactory
  /** The live sessions, and one by id. */
  sessions: {
    list(): readonly PullRequestTerminalSession[]
    get(sessionId: string): PullRequestTerminalSession | null
  }
  /** Some sessions' lists moved: re-send their snapshots. */
  onListsChanged(affects: (session: PullRequestTerminalSession) => boolean): void
  version?: string
  log?: (message: string) => void
  retry?: { initialMs?: number; maxMs?: number }
}): TerminalPullRequests {
  let client: StudioClient | null = null
  let starting: Promise<void> | null = null
  let stopped = false
  let stopPush: (() => void) | null = null
  /** Conversation → its list, as the server last answered it. */
  const lists = new Map<string, BranchPullRequest[]>()
  /** Conversation → the files its agent changed since its last accepted note. */
  const pendingPaths = new Map<string, Set<string>>()
  const wanted = new Set<string>()
  let fetchTimer: ReturnType<typeof setTimeout> | null = null
  let fetching = false

  function keyOf(session: PullRequestTerminalSession): StudioPullRequestOwner | null {
    if (session.kind !== 'agent' || !session.workspaceId || !session.agentId) return null
    return { workspaceId: session.workspaceId, agentId: session.agentId }
  }
  const idOf = (key: StudioPullRequestOwner) => `${key.workspaceId}\0${key.agentId}`
  const usable = () =>
    client && client.state === 'open' && client.supports(STUDIO_PULL_REQUESTS_CAPABILITY) ? client : null

  function want(ids: Iterable<string>): void {
    for (const id of ids) wanted.add(id)
    if (fetchTimer || wanted.size === 0) return
    fetchTimer = setTimeout(() => {
      fetchTimer = null
      void fetchWanted()
    }, FETCH_COALESCE_MS)
    fetchTimer.unref?.()
  }

  /** The live agents' conversations, by id. */
  function liveKeys(): Map<string, StudioPullRequestOwner> {
    const keys = new Map<string, StudioPullRequestOwner>()
    for (const session of options.sessions.list()) {
      const key = keyOf(session)
      if (key) keys.set(idOf(key), key)
    }
    return keys
  }

  async function fetchWanted(): Promise<void> {
    const connected = usable()
    if (fetching || !connected || wanted.size === 0) return
    fetching = true
    const live = liveKeys()
    const asked = [...wanted].filter((id) => live.has(id))
    wanted.clear()
    try {
      if (asked.length === 0) return
      const answer = await connected.request('pullRequests.list', {
        conversations: asked.map((id) => live.get(id)!),
      })
      const answered = new Map<string, BranchPullRequest[]>()
      for (const entry of answer.conversations) answered.set(idOf(entry), entry.pullRequests.map(fromWire))
      const moved = new Set<string>()
      for (const id of asked) {
        const next = answered.get(id) ?? []
        if (sameList(lists.get(id) ?? [], next)) continue
        if (next.length > 0) lists.set(id, next)
        else lists.delete(id)
        moved.add(id)
      }
      // Lists of agents that are gone are not kept.
      for (const id of lists.keys()) if (!live.has(id)) lists.delete(id)
      if (moved.size > 0) {
        options.onListsChanged((session) => {
          const key = keyOf(session)
          return key !== null && moved.has(idOf(key))
        })
      }
    } catch {
      // Unanswered: what is shown stays, and a reconnect asks for every list again.
    } finally {
      fetching = false
      if (wanted.size > 0 && usable()) want([])
    }
  }

  /** A connection (the first, or one after a restart): every live agent's list again. */
  function resync(): void {
    want(liveKeys().keys())
  }

  async function run(): Promise<void> {
    const connected = await connect({
      transport: options.transport,
      client: {
        name: 'SprintEngine Studio terminals',
        kind: 'desktop',
        ...(options.version ? { version: options.version } : {}),
      },
      heartbeat: false,
      reconnect: { initialDelayMs: 50, maxDelayMs: 2_000 },
      onStateChange: (state) => {
        if (state === 'open') resync()
      },
    })
    if (stopped) {
      connected.close()
      return
    }
    client = connected
    if (!connected.supports(STUDIO_PULL_REQUESTS_CAPABILITY)) return
    stopPush = connected.subscribe(
      'pullRequests.changed',
      {},
      {
        onPayload: (payload) => {
          const change = payload as { workspaceIds?: unknown; conversations?: unknown } | null
          const workspaces = new Set(
            Array.isArray(change?.workspaceIds) ? change.workspaceIds.filter((id) => typeof id === 'string') : [],
          )
          const ids = new Set<string>()
          if (Array.isArray(change?.conversations)) {
            for (const entry of change.conversations as StudioPullRequestOwner[]) {
              if (entry && typeof entry.workspaceId === 'string' && typeof entry.agentId === 'string')
                ids.add(idOf(entry))
            }
          }
          for (const [id, key] of liveKeys()) if (workspaces.has(key.workspaceId)) ids.add(id)
          want(ids)
        },
      },
    )
    resync()
  }

  async function runUntilConnected(): Promise<void> {
    let delay = options.retry?.initialMs ?? FIRST_CONNECT_RETRY_MS.initial
    const maxDelay = options.retry?.maxMs ?? FIRST_CONNECT_RETRY_MS.max
    let reported = false
    while (!stopped) {
      try {
        await run()
        return
      } catch (error) {
        if (!reported)
          options.log?.(
            `The terminals' pull request client did not connect yet, and keeps trying: ${error instanceof Error ? error.message : String(error)}`,
          )
        reported = true
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        timer.unref?.()
      })
      delay = Math.min(delay * 2, maxDelay)
    }
  }

  function checkoutOf(session: PullRequestTerminalSession): { gitRoot: string; branch: string } | null {
    const observed = session.observedCheckout
    if (!observed?.resolved) return null
    const gitRoot = observed.gitRoot?.trim()
    const branch = observed.branch?.trim()
    // A detached HEAD has no branch to look a pull request up by.
    return gitRoot && branch ? { gitRoot, branch } : null
  }

  function sendNote(session: PullRequestTerminalSession, turnEnded: boolean): boolean {
    const key = keyOf(session)
    const connected = usable()
    if (!key || !connected) return false
    const id = idOf(key)
    const checkout = checkoutOf(session)
    const pending = pendingPaths.get(id)
    const changedPaths = pending ? [...pending] : []
    if (!checkout && changedPaths.length === 0) return false
    pendingPaths.delete(id)
    void connected
      .request('pullRequests.noteWork', {
        conversation: key,
        sessionId: session.sessionId,
        ...(checkout ? { checkout } : {}),
        ...(changedPaths.length > 0 ? { changedPaths } : {}),
        turnEnded,
      })
      .then(
        // A conversation this window has no list for yet may already have one
        // on the server (a resumed agent): ask, rather than wait for a change.
        () => {
          if (!lists.has(id)) want([id])
        },
        () => {
          // Not accepted: the files are kept for the next note.
          const kept = pendingPaths.get(id) ?? new Set<string>()
          for (const path of changedPaths) if (kept.size < MAX_PENDING_PATHS) kept.add(path)
          pendingPaths.set(id, kept)
        },
      )
    return true
  }

  return {
    listForSession(session) {
      const key = keyOf(session)
      return key ? (lists.get(idOf(key)) ?? []) : []
    },

    noteCheckoutResolved(session, resolution) {
      sendNote(session, resolution.fresh)
    },

    noteFileEdit(session, path) {
      const key = keyOf(session)
      if (!key || !path) return
      const id = idOf(key)
      const paths = pendingPaths.get(id) ?? new Set<string>()
      if (paths.size < MAX_PENDING_PATHS) paths.add(path)
      pendingPaths.set(id, paths)
    },

    refreshForSession(sessionId) {
      const session = options.sessions.get(sessionId)
      const key = session ? keyOf(session) : null
      const connected = usable()
      if (!session || !key || !connected) return false
      const id = idOf(key)
      const noted = sendNote(session, false)
      if (!noted && !lists.has(id)) return false
      void connected.request('pullRequests.refresh', { conversations: [key] }).catch(() => undefined)
      return true
    },

    start() {
      starting ??= runUntilConnected()
      return starting
    },

    stop() {
      stopped = true
      if (fetchTimer) clearTimeout(fetchTimer)
      fetchTimer = null
      stopPush?.()
      stopPush = null
      client?.close()
      client = null
    },
  }
}

function fromWire(entry: StudioPullRequest): BranchPullRequest {
  const { onConversationBranch, ...rest } = entry
  return { ...rest, ...(onConversationBranch ? { onSessionBranch: true } : {}) }
}

function sameList(a: readonly BranchPullRequest[], b: readonly BranchPullRequest[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (entry, index) =>
      entry.url === b[index].url &&
      entry.state === b[index].state &&
      entry.isDraft === b[index].isDraft &&
      entry.title === b[index].title &&
      entry.number === b[index].number &&
      entry.openedAt === b[index].openedAt &&
      entry.onSessionBranch === b[index].onSessionBranch,
  )
}
