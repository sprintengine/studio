// The agent changelist feed — the wire between a live terminal session and the
// changelist store (`git-changelists.ts`).
//
// The runtime knows three things about an agent and nothing about git: it
// launched, it edited a file, it exited. This module turns those three into
// store writes, and it exists as its own file for one reason: everything that
// makes them SAFE lives here, not in the runtime and not in the store.
//
// WHICH CHECKOUT. The store is keyed per checkout, so getting this wrong files
// an agent's work under a repository it never touched. The answer is the
// session's observed `gitRoot` — the working tree its hooks last reported from —
// and NOT `observedCheckout.repoRoot`, which for a linked worktree is the
// PRIMARY checkout that owns the common git dir. An agent working in
// `…/worktrees/feature` would otherwise have its lines recorded against the main
// repository, where the very paths it edited are not even inside the root. The
// Git panel keys on `git rev-parse --show-toplevel`, which is the worktree, so
// the worktree is what this keys on too. Launch intent (`worktreePath`, then
// `cwd`) is the fallback while nothing has been observed yet, resolved through
// git once per directory because a workspace folder is not always a repo root.
//
// INSIDE THE CHECKOUT, OR NOWHERE. A subagent can run in an isolated worktree of
// its own and its edits ride the parent session's frames (the reporter suppresses
// a subagent's cwd, not its work). A path that is not inside the checkout is
// therefore dropped rather than guessed at: it belongs to a checkout this feed
// cannot name.
//
// ONE WRITE PER BURST. An agent editing a file emits a frame per tool call, and
// a store write is a read-modify-write plus a `git status`. Edits are coalesced
// per checkout for a quarter second and applied as one batch in ARRIVAL order,
// which is the order last-writer-wins ownership needs.
//
// ORDER ACROSS THE THREE. An exit that overtook the edits still queued behind it
// would mark a list exited, watch reconcile delete it for being empty, and then
// see the edits recreate it as a live list belonging to a dead agent. So an exit
// FLUSHES first and marks after. Launch and edit need no such care: both create
// the list if it is missing, and `createOwnedChangelist` is idempotent.
//
// AND IT NEVER THROWS. Every entry point is fire-and-forget from the runtime's
// point of view: a store that will not write, a repository that has moved, a
// disk that is full — all of it is logged and dropped. A changelist is a
// convenience; a terminal is not.

import { isAbsolute } from 'path'

import type { ChangelistEdit, ChangelistOwner } from '../shared/git/changelists'
import {
  ensureOwnedChangelist as ensureOwnedChangelistInStore,
  markOwnerExited as markOwnerExitedInStore,
  recordAgentEdits as recordAgentEditsInStore,
  toStoredPath,
} from './git-changelists'
import { getGitRepoRoot } from './git'
import { normalizeComparablePath } from './git-utils'

/** How long edits pile up before one store write. Long enough that a burst of
 *  tool calls is one write, short enough that the panel feels live. */
export const AGENT_CHANGELIST_COALESCE_MS = 250

/** Directories whose repo root is remembered. Small: a session has one. */
const REPO_ROOT_CACHE_LIMIT = 64

/** What the feed needs to see of a terminal session. Structural rather than
 *  `TerminalSession` so the feed can be tested without a pty. */
export type AgentChangelistSession = {
  agentId?: string
  agentName?: string
  workspaceId?: string
  worktreePath?: string
  cwd?: string
  observedCheckout?: { resolved: boolean; gitRoot: string | null } | null
}

export type AgentChangelistFeedStore = {
  ensureOwnedChangelist: typeof ensureOwnedChangelistInStore
  recordAgentEdits: typeof recordAgentEditsInStore
  markOwnerExited: typeof markOwnerExitedInStore
}

export type AgentChangelistFeedOptions = {
  userDataDir: string
  /** Told which repository's lists just changed, after every write. The app
   *  turns it into one `git:changelists-changed` to every window. */
  broadcast?: (repoRoot: string) => void
  /** `git rev-parse --show-toplevel`, injected so tests need no repository. */
  resolveRepoRoot?: (directory: string) => Promise<string | null>
  store?: AgentChangelistFeedStore
  coalesceMs?: number
  logWarning?: (message: string, error: unknown) => void
}

export type AgentChangelistFeed = {
  onAgentLaunched(session: AgentChangelistSession): void
  onAgentFileEdit(input: { session: AgentChangelistSession; path: string; edits?: ChangelistEdit[]; ts: number }): void
  onAgentSessionExit(session: AgentChangelistSession): void
  /** Settle everything queued or in flight. The tests' only synchronisation
   *  point, and the quit path's if it ever wants one. */
  flush(): Promise<void>
  /** Stop accepting work and forget what is queued: app quit. A write that has
   *  already started still finishes; nothing new is started. */
  dispose(): void
}

type QueuedEdit = { owner: ChangelistOwner; path: string; edits?: ChangelistEdit[] }

type CheckoutQueue = {
  repoRoot: string
  pending: QueuedEdit[]
  timer: ReturnType<typeof setTimeout> | null
}

function ownerOf(session: AgentChangelistSession): ChangelistOwner | null {
  const agentId = session.agentId?.trim()
  if (!agentId) return null
  return {
    kind: 'agent',
    agentId,
    // A session that never carried a display name is still an agent; its id is
    // a worse label than its name and a better one than an empty header.
    name: session.agentName?.trim() || agentId,
    ...(session.workspaceId?.trim() ? { workspaceId: session.workspaceId.trim() } : {}),
  }
}

export function createAgentChangelistFeed(options: AgentChangelistFeedOptions): AgentChangelistFeed {
  const store: AgentChangelistFeedStore = options.store ?? {
    ensureOwnedChangelist: ensureOwnedChangelistInStore,
    recordAgentEdits: recordAgentEditsInStore,
    markOwnerExited: markOwnerExitedInStore,
  }
  const resolveRepoRoot = options.resolveRepoRoot ?? getGitRepoRoot
  const coalesceMs = options.coalesceMs ?? AGENT_CHANGELIST_COALESCE_MS
  const warn =
    options.logWarning ??
    ((message: string, error: unknown) => console.warn(`[agent-changelist-feed] ${message}`, error))

  const repoRoots = new Map<string, string | null>()
  const queues = new Map<string, CheckoutQueue>()
  // Every checkout an agent has actually written into, so its exit reaches all
  // of them — an agent that moved from the workspace folder into a worktree it
  // made itself owns a list in each.
  const checkoutsByAgent = new Map<string, Set<string>>()
  // ONE CHAIN, IN ARRIVAL ORDER. Every operation is appended to this promise
  // rather than started when it is handed over, which is what makes launch →
  // edit → exit come out in the order the runtime saw them even though each of
  // them awaits git or the disk part-way through. It is also what lets `flush`
  // mean "everything the feed was told about has landed".
  let settled: Promise<void> = Promise.resolve()
  let disposed = false

  const run = (work: () => Promise<void>): Promise<void> => {
    // `then(work, work)` so one failure cannot poison the chain behind it.
    const next = settled.then(work, work)
    settled = next.then(
      () => {},
      () => {},
    )
    return settled
  }

  /** The checkout this session's work belongs to, or null when there is none to
   *  name. See the header: the observed WORKING TREE, then launch intent. */
  async function resolveCheckout(session: AgentChangelistSession): Promise<string | null> {
    const observed = session.observedCheckout
    if (observed?.resolved && observed.gitRoot) return observed.gitRoot
    const directory = session.worktreePath?.trim() || session.cwd?.trim()
    if (!directory) return null
    const key = normalizeComparablePath(directory)
    const cached = repoRoots.get(key)
    if (cached !== undefined) return cached
    let resolved: string | null = null
    try {
      resolved = await resolveRepoRoot(directory)
    } catch (error) {
      warn('could not resolve a repository root', error)
      return null
    }
    if (repoRoots.size >= REPO_ROOT_CACHE_LIMIT) {
      const oldest = repoRoots.keys().next().value
      if (oldest !== undefined) repoRoots.delete(oldest)
    }
    repoRoots.set(key, resolved)
    return resolved
  }

  function rememberCheckout(agentId: string, repoRoot: string): void {
    const known = checkoutsByAgent.get(agentId) ?? new Set<string>()
    known.add(repoRoot)
    checkoutsByAgent.set(agentId, known)
  }

  function publish(repoRoot: string): void {
    if (!options.broadcast) return
    try {
      options.broadcast(repoRoot)
    } catch (error) {
      warn('a changelists broadcast failed', error)
    }
  }

  /**
   * Write one checkout's queued edits. Runs of the SAME owner become one store
   * call and the runs keep their order, so two agents alternating inside one
   * file are applied exactly as they arrived — which is what makes "the latest
   * editor owns the lines" true.
   */
  async function drain(key: string): Promise<void> {
    const queue = queues.get(key)
    if (!queue) return
    if (queue.timer) {
      clearTimeout(queue.timer)
      queue.timer = null
    }
    const pending = queue.pending
    queues.delete(key)
    if (pending.length === 0 || disposed) return
    let index = 0
    let wrote = false
    while (index < pending.length) {
      const owner = pending[index].owner
      const batch: Array<{ path: string; edits?: ChangelistEdit[] }> = []
      while (index < pending.length && pending[index].owner.agentId === owner.agentId) {
        const item = pending[index]
        batch.push({ path: item.path, ...(item.edits ? { edits: item.edits } : {}) })
        index += 1
      }
      try {
        await store.recordAgentEdits(options.userDataDir, queue.repoRoot, owner, batch)
        wrote = true
      } catch (error) {
        warn('could not record an agent edit', error)
      }
    }
    if (wrote) publish(queue.repoRoot)
  }

  function enqueue(repoRoot: string, entry: QueuedEdit): void {
    const key = normalizeComparablePath(repoRoot)
    const queue = queues.get(key) ?? { repoRoot, pending: [], timer: null }
    queue.pending.push(entry)
    queues.set(key, queue)
    if (queue.timer) return
    const timer = setTimeout(() => {
      void run(() => drain(key))
    }, coalesceMs)
    // A quarter-second of pending edits must never be a reason the app stays up.
    timer.unref?.()
    queue.timer = timer
  }

  async function drainAll(): Promise<void> {
    for (const key of [...queues.keys()]) await drain(key)
  }

  return {
    onAgentLaunched(session) {
      if (disposed) return
      const owner = ownerOf(session)
      if (!owner) return
      void run(async () => {
        const repoRoot = await resolveCheckout(session)
        if (!repoRoot || disposed) return
        rememberCheckout(owner.agentId, repoRoot)
        try {
          // Active, by decision of record: an edit that never reaches the hook
          // (a Bash `sed`, a formatter) is adopted by the active list, and the
          // agent that just launched is the one that will make it.
          await store.ensureOwnedChangelist(options.userDataDir, repoRoot, owner, { activate: true })
        } catch (error) {
          warn('could not create an agent changelist', error)
          return
        }
        publish(repoRoot)
      })
    },

    onAgentFileEdit(input) {
      if (disposed) return
      const owner = ownerOf(input.session)
      if (!owner) return
      const path = input.path?.trim()
      if (!path) return
      void run(async () => {
        const repoRoot = await resolveCheckout(input.session)
        if (!repoRoot || disposed) return
        const relative = toStoredPath(repoRoot, path)
        // Not this checkout's file: a subagent's own worktree, or a path the
        // agent edited outside the repository entirely. Dropped, never guessed.
        if (!relative || relative === '..' || relative.startsWith('../') || isAbsolute(relative)) return
        rememberCheckout(owner.agentId, repoRoot)
        enqueue(repoRoot, { owner, path: relative, ...(input.edits ? { edits: input.edits } : {}) })
      })
    },

    onAgentSessionExit(session) {
      if (disposed) return
      const owner = ownerOf(session)
      if (!owner) return
      void run(async () => {
        const current = await resolveCheckout(session)
        if (current) rememberCheckout(owner.agentId, current)
        // Everything this agent wrote must be on disk BEFORE it is marked
        // exited: reconcile deletes an exited list the moment it is empty, and
        // an edit that landed after would rebuild it as a live list owned by a
        // dead agent. The queue this drains is the agent's own by arrival order,
        // so nothing of its is left behind a coalescing timer.
        await drainAll()
        if (disposed) return
        const roots = checkoutsByAgent.get(owner.agentId)
        checkoutsByAgent.delete(owner.agentId)
        for (const repoRoot of roots ?? []) {
          try {
            await store.markOwnerExited(options.userDataDir, repoRoot, owner.agentId)
          } catch (error) {
            warn('could not mark an agent changelist exited', error)
            continue
          }
          publish(repoRoot)
        }
      })
    },

    async flush() {
      // Appended to the chain like everything else, so it settles the work that
      // was handed over before it and drains whatever that work queued.
      await run(() => drainAll())
    },

    dispose() {
      disposed = true
      for (const queue of queues.values()) if (queue.timer) clearTimeout(queue.timer)
      queues.clear()
      checkoutsByAgent.clear()
      repoRoots.clear()
    },
  }
}
