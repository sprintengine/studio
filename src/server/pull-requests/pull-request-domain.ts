import { dirname } from 'node:path'

import type {
  StudioPullRequest,
  StudioPullRequestOwner,
  StudioPullRequestsMethodMap,
  StudioPullRequestsTarget,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationEvent, ConversationListSessionsResult } from '../../shared/conversation-runtime'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import { resolveCheckoutForCwd } from '../../main/checkout-resolve'
import { runGitCommand } from '../../main/git-utils'
import {
  createPullRequestRecord,
  type PullRequestCheckout,
  type PullRequestConversationKey,
  type PullRequestRecord,
  type PullRequestRecordOptions,
} from './pull-request-record'

// The pull request record as a server domain (owner ruling 2026-10-03):
// features that react to chats live in the server, and every client displays
// the result through the protocol. This is where the record is told when to
// ask GitHub, and what it answers on `pullRequests.*`.
//
// When it asks — and never from reading a command or a tool's output:
//
// - A chat's turn ends: its own checkout, and every other repository its
//   tool calls changed files in during the turn (`fileChanges` on a
//   completed tool call). A lookup made after the turn ended, so a pull
//   request the agent opened in it is found.
// - A client that runs agents the server does not (the desktop's terminals)
//   says where one did work (`noteWork`), with the same rules.
// - A slow poll while a conversation is open: a chat with a live session, or
//   any conversation that worked in the last half hour. It notices a branch
//   that moved under a chat between turns, and a pull request someone opened
//   or merged by hand. The record's own watch re-reads every open pull
//   request every two minutes besides.
// - A client asks (`pullRequests.refresh`): a hover, a window coming back to
//   the front.
//
// What it does not ask about: a repository's default branch. "Is there a pull
// request for main?" is answered by every fork whose author worked on their
// own `main`, and a chat in a project's own folder would wear all of them.
//
// Repositories outside any workspace are looked up when an agent changed files
// in them, bounded: at most `MAX_OTHER_REPOSITORIES_PER_TURN` per turn, from at
// most `MAX_DIRECTORIES_PER_TURN` directories, and a conversation remembers at
// most a dozen checkouts. A path in no repository costs one git call and is
// forgotten.

/** The most directories one turn's changed files are resolved from. */
export const MAX_DIRECTORIES_PER_TURN = 32
/** The most repositories besides its own one turn is looked up in. */
export const MAX_OTHER_REPOSITORIES_PER_TURN = 4
/** The most changed paths remembered for a turn that has not ended yet. */
const MAX_PATHS_PER_TURN = 256
/** The most chat turns in progress tracked at once; an abandoned one is dropped first. */
const MAX_OPEN_TURNS = 200

/** How often the poll looks at open conversations' branches (git only, no GitHub). */
export const POLL_TICK_MS = 60_000
/** Every this many ticks, the poll also looks their branches up on GitHub (held, so once a minute at most each). */
export const POLL_LOOKUP_EVERY_TICKS = 5
/** A conversation that noted work this recently counts as open for the poll. */
export const POLL_RECENT_WORK_MS = 30 * 60_000
/** The most conversations one poll tick visits. */
const MAX_POLLED_CONVERSATIONS = 50
/** How long a repository's default branch is remembered. */
const DEFAULT_BRANCH_TTL_MS = 10 * 60_000
/** Branch names read as the default when git does not say which one is. */
const FALLBACK_DEFAULT_BRANCHES = new Set(['main', 'master'])

export type PullRequestsChanged = { workspaceIds: string[]; conversations: StudioPullRequestOwner[] }

/** What the protocol serves; `StudioRpc` takes this. */
export type StudioPullRequests = {
  list(target: StudioPullRequestsTarget): Promise<StudioPullRequestsMethodMap['pullRequests.list']['result']>
  refresh(target: StudioPullRequestsTarget): Promise<{ asked: boolean }>
  noteWork(input: StudioPullRequestsMethodMap['pullRequests.noteWork']['params']): Promise<void>
  onChanged(listener: (change: PullRequestsChanged) => void): () => void
}

export type PullRequestDomain = StudioPullRequests & {
  readonly record: PullRequestRecord
  /** Settle what is in flight and stop the poll: a quit's leg. */
  flush(): Promise<void>
  dispose(): void
}

type Timers = {
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export type PullRequestDomainOptions = {
  dataDir: string
  /** The chats: their events, their live sessions, and the folder each session works in. */
  conversations: {
    onEvent(listener: (event: ConversationEvent) => void): () => void
    listSessions(): ConversationListSessionsResult
    sessionWorkspaceRoot?(sessionId: string): string | null
  }
  /** A workspace's folder, for a chat whose session's own folder is not known. */
  workspaceFolder(workspaceId: string): string | null
  /** The record, built here unless given (tests). */
  record?: PullRequestRecord
  /** Passed to the record this builds. */
  recordOptions?: Omit<PullRequestRecordOptions, 'userDataDir' | 'onRecordChanged'>
  /** The checkout a folder is in and the branch it is on; null when it is not a checkout on a branch. */
  resolveCheckout?(path: string): Promise<PullRequestCheckout | null | 'missing'>
  /** The repository's default branch, or null when git does not say. */
  readDefaultBranch?(gitRoot: string): Promise<string | null>
  /** Whether the machine is asleep: the poll skips its ticks then. */
  isSuspended?(): boolean
  /** Null turns the poll off (tests drive `pollOnce`). */
  timers?: Timers | null
  now?: () => number
  log?(message: string, error?: unknown): void
}

export function createPullRequestDomain(options: PullRequestDomainOptions): PullRequestDomain & {
  /** One poll tick, for tests. */
  pollOnce(lookup: boolean): Promise<void>
} {
  const now = options.now ?? (() => Date.now())
  const listeners = new Set<(change: PullRequestsChanged) => void>()
  const log =
    options.log ??
    ((message: string, error?: unknown) => {
      console.warn(`[pull-requests] ${message}`, error ?? '')
    })
  let disposed = false

  const record =
    options.record ??
    createPullRequestRecord({
      loadStoredOnStart: true,
      ...options.recordOptions,
      userDataDir: options.dataDir,
      onRecordChanged: (change) => publish({ workspaceIds: change.workspaceIds, conversations: change.conversations }),
      logWarning: options.recordOptions?.logWarning ?? ((message, error) => log(message, error)),
    })

  function publish(change: PullRequestsChanged): void {
    if (disposed || (change.workspaceIds.length === 0 && change.conversations.length === 0)) return
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        log('a pull request listener failed', error)
      }
    }
  }

  const resolveCheckout = options.resolveCheckout ?? defaultResolveCheckout
  const readDefaultBranch = options.readDefaultBranch ?? defaultReadDefaultBranch
  const defaultBranches = new Map<string, { at: number; read: Promise<string | null> }>()

  /** Whether a branch is its repository's default, which is never looked up (see the header). */
  async function isDefaultBranch(checkout: PullRequestCheckout): Promise<boolean> {
    let known = defaultBranches.get(checkout.gitRoot)
    if (!known || now() - known.at > DEFAULT_BRANCH_TTL_MS) {
      known = { at: now(), read: readDefaultBranch(checkout.gitRoot).catch(() => null) }
      defaultBranches.set(checkout.gitRoot, known)
    }
    const named = await known.read
    return named ? named === checkout.branch : FALLBACK_DEFAULT_BRANCHES.has(checkout.branch)
  }

  /** The checkout a changed file is in, walking up past directories the change removed. */
  async function checkoutOfPath(path: string): Promise<PullRequestCheckout | null> {
    let dir = dirname(path)
    for (let depth = 0; depth < 4; depth += 1) {
      const found = await resolveCheckout(dir).catch(() => null)
      if (found !== 'missing') return found
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  }

  /**
   * One conversation's work, looked up: its own checkout, then the other
   * repositories its changed files are in, each at most once.
   */
  async function noteWork(input: {
    key: PullRequestConversationKey
    home: PullRequestCheckout | null
    changedPaths: readonly string[]
    turnEnded: boolean
    sessionId?: string
  }): Promise<void> {
    if (disposed) return
    const lookups: Promise<void>[] = []
    const seen = new Set<string>()
    const note = async (checkout: PullRequestCheckout, home: boolean): Promise<void> => {
      if (await isDefaultBranch(checkout)) return
      await record.noteCheckout(input.key, checkout, {
        force: input.turnEnded,
        home,
        ...(home && input.sessionId ? { sessionId: input.sessionId } : {}),
      })
    }
    if (input.home) {
      seen.add(input.home.gitRoot)
      lookups.push(note(input.home, true))
    }
    // Absolute paths only: a relative one would resolve against this
    // process's own folder, which is no agent's.
    const directories = [...new Set(input.changedPaths.map((path) => path.trim()).filter(isAbsolutePath))]
    const visited = new Set<string>()
    let others = 0
    for (const path of directories) {
      if (others >= MAX_OTHER_REPOSITORIES_PER_TURN || visited.size >= MAX_DIRECTORIES_PER_TURN) break
      const dir = dirname(path)
      if (visited.has(dir)) continue
      visited.add(dir)
      const checkout = await checkoutOfPath(path)
      if (!checkout || seen.has(checkout.gitRoot)) continue
      seen.add(checkout.gitRoot)
      others += 1
      lookups.push(note(checkout, false))
    }
    await Promise.all(lookups.map((lookup) => lookup.catch((error) => log('could not look a branch up', error))))
  }

  // ── Chats: a turn's changed files, and its end ─────────────────────────────

  /** A chat turn in progress: what it changed so far. Keyed by session. */
  const openTurns = new Map<string, { key: PullRequestConversationKey; paths: Set<string> }>()

  function turnOf(event: ConversationEvent): { key: PullRequestConversationKey; paths: Set<string> } {
    const known = openTurns.get(event.sessionId)
    if (known) return known
    const turn = { key: { workspaceId: event.workspaceId, agentId: event.agentId }, paths: new Set<string>() }
    openTurns.set(event.sessionId, turn)
    while (openTurns.size > MAX_OPEN_TURNS) {
      const oldest = openTurns.keys().next().value
      if (oldest === undefined) break
      openTurns.delete(oldest)
    }
    return turn
  }

  async function chatHome(sessionId: string, workspaceId: string): Promise<PullRequestCheckout | null> {
    const root = options.conversations.sessionWorkspaceRoot?.(sessionId) ?? options.workspaceFolder(workspaceId)
    if (!root) return null
    const found = await resolveCheckout(root).catch(() => null)
    return found && found !== 'missing' ? found : null
  }

  const stopEvents = options.conversations.onEvent((event) => {
    if (disposed || !event.workspaceId || !event.agentId || !event.sessionId) return
    if (event.type === 'tool_output') {
      if (event.payload?.partial === true) return
      const paths = changedPathsOf(event.payload)
      if (paths.length === 0) return
      const turn = turnOf(event)
      for (const path of paths) if (turn.paths.size < MAX_PATHS_PER_TURN) turn.paths.add(path)
      return
    }
    if (event.type === 'turn_completed' || event.type === 'turn_failed') {
      const turn = openTurns.get(event.sessionId)
      openTurns.delete(event.sessionId)
      const key = { workspaceId: event.workspaceId, agentId: event.agentId }
      void chatHome(event.sessionId, event.workspaceId)
        .then((home) => noteWork({ key, home, changedPaths: [...(turn?.paths ?? [])], turnEnded: true }))
        .catch((error) => log('could not note a turn', error))
      return
    }
    if (event.type === 'session_closed') openTurns.delete(event.sessionId)
  })

  // ── The poll ────────────────────────────────────────────────────────────────

  function liveChats(): Array<{ sessionId: string; key: PullRequestConversationKey }> {
    const listed = options.conversations.listSessions()
    if (!listed.ok) return []
    return listed.sessions
      .filter((session) => session.status !== 'stopped' && session.status !== 'failed')
      .map((session) => ({
        sessionId: session.sessionId,
        key: { workspaceId: session.workspaceId, agentId: session.agentId },
      }))
  }

  async function pollOnce(lookup: boolean): Promise<void> {
    if (disposed || options.isSuspended?.()) return
    const visited = new Set<string>()
    // A chat's branch can move between its turns (a checkout in the git
    // panel): its own checkout is read again, which is git only, and a moved
    // branch is noted like a turn's.
    for (const chat of liveChats().slice(0, MAX_POLLED_CONVERSATIONS)) {
      visited.add(`${chat.key.workspaceId}\0${chat.key.agentId}`)
      const home = await chatHome(chat.sessionId, chat.key.workspaceId)
      if (disposed) return
      if (!home) continue
      const known = record.homeOf(chat.key)
      const moved = !known || known.gitRoot !== home.gitRoot || known.branch !== home.branch
      if (moved) await noteWork({ key: chat.key, home, changedPaths: [], turnEnded: false })
      else if (lookup) record.refreshConversation(chat.key)
    }
    if (!lookup) return
    // Conversations that worked recently, the desktop's terminal agents
    // among them: a pull request opened or merged by hand shows without a
    // hover. Held, so each branch costs one `gh` a minute at most.
    for (const key of record.conversationsActiveSince(now() - POLL_RECENT_WORK_MS)) {
      if (visited.size >= MAX_POLLED_CONVERSATIONS) break
      const id = `${key.workspaceId}\0${key.agentId}`
      if (visited.has(id)) continue
      visited.add(id)
      record.refreshConversation(key)
    }
  }

  const timers: Timers | null =
    options.timers === undefined
      ? {
          setInterval: (handler, ms) => {
            const handle = setInterval(handler, ms)
            handle.unref?.()
            return handle
          },
          clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        }
      : options.timers
  let ticks = 0
  let polling = false
  const poll = timers?.setInterval(() => {
    if (polling) return
    polling = true
    ticks += 1
    void pollOnce(ticks % POLL_LOOKUP_EVERY_TICKS === 0)
      .catch((error) => log('the pull request poll failed', error))
      .finally(() => {
        polling = false
      })
  }, POLL_TICK_MS)

  // ── What the protocol serves ───────────────────────────────────────────────

  async function list(
    target: StudioPullRequestsTarget,
  ): Promise<StudioPullRequestsMethodMap['pullRequests.list']['result']> {
    // A list asked for before the stored records are read would be empty, and
    // a client would draw no marks until the next change: wait for them.
    await record.whenLoaded()
    const workspaces: Record<string, StudioPullRequest[]> = {}
    for (const workspaceId of target.workspaceIds ?? []) {
      const found = record.forWorkspace(workspaceId)
      if (found.length > 0) workspaces[workspaceId] = found.map(toWire)
    }
    const conversations: Array<StudioPullRequestOwner & { pullRequests: StudioPullRequest[] }> = []
    for (const key of target.conversations ?? []) {
      const found = record.forConversation(key)
      if (found.length > 0) conversations.push({ ...key, pullRequests: found.map(toWire) })
    }
    return { workspaces, conversations }
  }

  return {
    record,
    list,
    async refresh(target) {
      const workspaceIds = target.workspaceIds ?? []
      const keys = target.conversations ?? []
      if (workspaceIds.length === 0 && keys.length === 0) {
        record.refreshOutstanding()
        return { asked: true }
      }
      await record.whenLoaded()
      let asked = false
      for (const workspaceId of workspaceIds) if (record.refreshWorkspace(workspaceId)) asked = true
      for (const key of keys) if (record.refreshConversation(key)) asked = true
      return { asked }
    },
    async noteWork(input) {
      await noteWork({
        key: input.conversation,
        home: input.checkout ?? null,
        changedPaths: input.changedPaths ?? [],
        turnEnded: input.turnEnded === true,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      })
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pollOnce,
    async flush() {
      if (poll !== undefined) timers?.clearInterval(poll)
      await record.flush()
    },
    dispose() {
      disposed = true
      if (poll !== undefined) timers?.clearInterval(poll)
      stopEvents()
      listeners.clear()
      record.dispose()
    },
  }
}

/** A record entry as the protocol carries it: no ids of who filed it. */
function toWire(entry: BranchPullRequest): StudioPullRequest {
  return {
    url: entry.url,
    repoKey: entry.repoKey,
    repoName: entry.repoName,
    number: entry.number,
    title: entry.title,
    state: entry.state,
    isDraft: entry.isDraft,
    openedAt: entry.openedAt,
    stateAt: entry.stateAt,
    ...(entry.onSessionBranch ? { onConversationBranch: true as const } : {}),
  }
}

/**
 * The files a completed tool call changed, read off `tool_output`'s payload.
 * Read untyped and defensively: the field's protocol type arrives with the
 * change-attribution work, and until then a payload is trusted only as far as
 * this reader checks it. Absolute paths only, at most `MAX_PATHS_PER_TURN`.
 */
export function changedPathsOf(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const changes = (payload as { fileChanges?: unknown }).fileChanges
  if (!Array.isArray(changes)) return []
  const paths: string[] = []
  for (const change of changes.slice(0, MAX_PATHS_PER_TURN)) {
    if (!change || typeof change !== 'object') continue
    const path = (change as { path?: unknown }).path
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0')) continue
    if (isAbsolutePath(path)) paths.push(path)
  }
  return paths
}

/** Absolute in either spelling: a POSIX path, or a Windows drive or share. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

async function defaultResolveCheckout(path: string): Promise<PullRequestCheckout | null | 'missing'> {
  const facts = await resolveCheckoutForCwd(path)
  if (!facts) return null
  if (facts.missing) return 'missing'
  if (!facts.gitRoot || !facts.branch) return null
  return { gitRoot: facts.gitRoot, branch: facts.branch }
}

/** `origin/HEAD`'s branch: what a clone calls its default. Null when the clone never recorded one. */
async function defaultReadDefaultBranch(gitRoot: string): Promise<string | null> {
  const read = await runGitCommand(gitRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (!read.ok) return null
  const ref = read.stdout.trim()
  const slash = ref.indexOf('/')
  return slash > 0 ? ref.slice(slash + 1) || null : null
}
