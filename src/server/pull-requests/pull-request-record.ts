// The pull request record: which pull requests a conversation opened, and what
// state each is in (epic `pull-request-marks`, decisions 3, 5, 9, 10). This is
// the OWNER of that fact — the sidebar mark, the peek's split control and the
// tooltip all read what is written here, through the Studio protocol, and
// nothing else may decide it. It is a server domain: the Studio server builds
// it with its core, in process and out of process alike, and every client
// displays what it answers (owner ruling 2026-10-03).
//
// A CONVERSATION OWNS A PULL REQUEST WHEN ITS AGENT OPENED IT (owner ruling
// 2026-10-04). Two things say so, and nothing else does:
//
// - its agent ran a create command or tool, and the call's output named the
//   pull request (`src/shared/git/pull-request-opened.ts`, the one reader of
//   that, for chats and terminal agents alike);
// - its agent called the Studio gateway's `pull_request.link` with the URL,
//   which is how an agent says so for a forge or a way of opening one the
//   reader does not know.
//
// The conversation (a workspace and one agent in it) is stamped on the entry
// at that moment, and the first conversation to claim a pull request keeps it.
// A branch is never asked who owns anything. The rule this replaces looked up
// every branch a conversation worked on and wore whatever pull requests were
// there, so a chat started in a checkout that happened to be on someone
// else's branch wore that branch's merged pull requests, and two agents on one
// branch both wore its pull request.
//
// STATE COMES ONLY FROM THE HOST, AND ONLY FOR GITHUB. A pull request's state
// is read by its URL (`gh pr view`, `github/branch-pull-request.ts`): once when
// it is recorded, on the watch below, and when a client asks. A pull request on
// another forge is recorded with `forge` set and is shown as opened; nothing
// is guessed about it. There is no ancestry inference anywhere in this file,
// because a squash merge or a rebase would make it lie for ever (decision 8c).
//
// WHAT MAY BE WRITTEN DOWN. Only a SETTLED read. "I could not ask" changes
// nothing at all — a mark must never blink out because a laptop was offline
// for one probe, or because a server has no `gh`.
//
// THE WATCH IS BOUNDED (decision 9's schedule, not its scope). Only a GitHub
// pull request still open, and opened inside `PR_WATCH_BOOT_SCAN_MAX_AGE_MS` —
// a 30-day window — holds a timer.
//
// ONE FILE. Every pull request on the record is in `pull-requests/opened.json`
// in the server's data directory. The files written before this rule — one per
// repository, holding every branch lookup's rows, and the conversations'
// `conversations.json` — are read once: the rows a capture filed under a
// conversation are kept (a capture from before the agent was known names the
// workspace alone, and is worn by every conversation in it), the rows a branch
// lookup found are dropped, and the old files are removed.

import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { classifyPullRequestUrl } from '../../shared/git/pr-url'
import {
  canonicalPullRequestUrlOf,
  pullRequestRepository,
  type BranchPullRequest,
  type PullRequestState,
} from '../../shared/git/pull-request'
import { isRecord } from '../../shared/records'
import { writeFileAtomically } from '../../main/config-file-write'
import { readPullRequestState as readPullRequestStateDefault } from '../../main/github/branch-pull-request'
import {
  createPullRequestWatchPoller,
  PR_WATCH_BOOT_SCAN_MAX_AGE_MS,
  type WatchPollerFocus,
  type WatchPollerTimers,
} from '../../main/github/pull-request-watch-poller'

const STORE_DIR = 'pull-requests'
const STORE_FILE = 'opened.json'
const STORE_VERSION = 2
/** The version of the per-repository files this replaces, read once to migrate. */
const LEGACY_STORE_VERSION = 1
/** The file the replaced rule kept its conversations' checkouts in; removed by the migration. */
const LEGACY_CONVERSATIONS_FILE = 'conversations.json'

/**
 * How long every read is skipped once `gh` turned out not to be installed. A
 * server on a machine with no `gh` (a fresh remote box) shows its pull
 * requests as last read, and says nothing about it; this keeps it from
 * spawning a doomed process for every pull request to learn that again.
 */
export const GH_MISSING_HOLD_MS = 5 * 60_000

/** How long an unsettled read holds before the same pull request is asked about again. */
export const READ_RETRY_AFTER_FAILURE_MS = 10_000

/**
 * How old a state reading may be before a refresh re-reads it (decision 9).
 * Coalesced by the per-URL in-flight map, so a burst of refreshes buys one
 * `gh` call per pull request.
 */
export const HOVER_REFRESH_STALE_MS = 60_000

/** How old an OPEN pull request may be and still hold a watch timer — see the header. */
export const WATCH_MAX_AGE_MS = PR_WATCH_BOOT_SCAN_MAX_AGE_MS

/**
 * How many `gh` reads may be in flight at once. Each is a subprocess — plus,
 * on a GUI-launched macOS app whose `gh` is not on the inherited PATH, a whole
 * `$SHELL -ilc` login shell.
 */
export const MAX_CONCURRENT_GITHUB_READS = 3

/** The most pull requests on the record; the longest-opened go first. */
export const MAX_PULL_REQUESTS = 5_000

/** The most conversations whose own checkout is remembered; the least recently active go first. */
export const MAX_CONVERSATIONS = 2_000

/** How long after a write of the record fails it is tried again. */
const WRITE_RETRY_MS = 5_000

/** A `<name>.<uuid>.tmp` left by a write that died must be older than this before it is swept. */
const TEMP_FILE_SWEEP_MIN_AGE_MS = 60 * 60 * 1000

/** A conversation: a workspace and one agent in it. */
export type PullRequestConversationKey = { workspaceId: string; agentId: string }

/** A checkout and the branch it is on. */
export type PullRequestCheckout = { gitRoot: string; branch: string }

/** Some conversations' lists changed: the readers it reaches, which is how a client knows what to ask again. */
export type PullRequestRecordChange = {
  workspaceIds: string[]
  conversations: PullRequestConversationKey[]
}

export type PullRequestRecordOptions = {
  userDataDir: string
  /** The GitHub read, injected so tests never spawn `gh`. */
  reads?: { readPullRequestState?: typeof readPullRequestStateDefault }
  /** A list changed; see `PullRequestRecordChange`. */
  onRecordChanged?: (change: PullRequestRecordChange) => void
  /** Read what is stored at start rather than on first use. */
  loadStoredOnStart?: boolean
  now?: () => number
  timers?: WatchPollerTimers
  /** Whether an app window has focus: the watch slows while none does. Absent, it never slows. */
  focus?: WatchPollerFocus
  random?: () => number
  logWarning?: (message: string, error: unknown) => void
}

/** What recording an opened pull request came to. */
export type NoteOpenedOutcome =
  | { ok: true; pullRequest: BranchPullRequest; recorded: boolean }
  | { ok: false; code: 'not_a_pull_request' | 'opened_by_another_conversation'; message: string }

export type PullRequestRecord = {
  /**
   * This conversation's agent opened this pull request. Recorded under the
   * conversation unless another one claimed it first; `recorded` is false when
   * it was already this conversation's. A GitHub pull request's state is read
   * at once.
   */
  noteOpened(key: PullRequestConversationKey, input: { url: string; title?: string }): Promise<NoteOpenedOutcome>
  /**
   * What a conversation wears: the pull requests it opened, newest first, the
   * ones from its own checkout's branch stamped `onSessionBranch`.
   * Synchronous; the stored entries are never mutated.
   */
  forConversation(key: PullRequestConversationKey): BranchPullRequest[]
  /**
   * What a sidebar row wears: every pull request any conversation in the
   * workspace opened. Nothing is filtered by state: a merged pull request
   * stays on its row as merged.
   */
  forWorkspace(workspaceId: string): BranchPullRequest[]
  /**
   * The checkout the conversation is in now, which decides `onSessionBranch`.
   * Git only; never a lookup.
   */
  noteCheckout(key: PullRequestConversationKey, checkout: PullRequestCheckout): void
  /** The conversation's own checkout, as last noted. */
  homeOf(key: PullRequestConversationKey): PullRequestCheckout | null
  /** Re-read one pull request's state by URL. Unsettled leaves the last reading standing. */
  refresh(url: string): Promise<void>
  /** Re-read a conversation's stale readings. Returns whether there was anything to ask about. */
  refreshConversation(key: PullRequestConversationKey): boolean
  /** The same, for every pull request opened in a workspace. */
  refreshWorkspace(workspaceId: string): boolean
  /** Every stale open pull request on the record, re-read: what a window coming back to the front asks. */
  refreshOutstanding(): void
  /** The conversations that noted a checkout or opened a pull request at or after `since`, most recent first. */
  conversationsActiveSince(since: number): PullRequestConversationKey[]
  /** Resolves once what was stored has been read: a list asked for before then would be empty. */
  whenLoaded(): Promise<void>
  /** URLs holding a live watch timer. Introspection for diagnostics and tests. */
  watchedUrls(): string[]
  /** Settle every load, write and read in flight. The tests' synchronisation point, and the quit's. */
  flush(): Promise<void>
  dispose(): void
}

/** The file the record lives in. */
export function pullRequestStorePath(userDataDir: string): string {
  return join(userDataDir, STORE_DIR, STORE_FILE)
}

type Home = { checkout: PullRequestCheckout; at: number }

export function createPullRequestRecord(options: PullRequestRecordOptions): PullRequestRecord {
  const now = options.now ?? (() => Date.now())
  const readState = options.reads?.readPullRequestState ?? readPullRequestStateDefault
  const timers: WatchPollerTimers = options.timers ?? {
    setTimeout: (handler, ms) => {
      const handle = setTimeout(handler, ms)
      handle.unref?.()
      return handle
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const warn =
    options.logWarning ?? ((message: string, error: unknown) => console.warn(`[pull-request-record] ${message}`, error))

  /** Every pull request on the record, by canonical URL. */
  const entries = new Map<string, BranchPullRequest>()
  /** Conversation → the URLs it opened. */
  const byConversation = new Map<string, Set<string>>()
  /** Workspace → every URL opened in it, by any conversation, and by a capture that named no agent. */
  const byWorkspace = new Map<string, Set<string>>()
  /** Conversation → its own checkout, as last noted. In order of last activity: the first key is the oldest. */
  const homes = new Map<string, Home>()
  /** Conversation → when it last opened a pull request. */
  const openedAt = new Map<string, number>()
  /** Per-URL hold on a state read, so an unsettled one is not re-spawned on every focus. */
  const refreshHolds = new Map<string, { at: number; settled: boolean }>()
  const refreshesInFlight = new Map<string, Promise<void>>()
  let ghMissingUntil = 0
  let load: Promise<void> | null = null
  let writes: Promise<unknown> = Promise.resolve()
  let dirty = false
  let writeRetry: unknown = null
  let disposed = false
  // The file is there but could not be read (locked by a scanner, a
  // permission): nothing is written over it this run, or the next change
  // would replace every stored pull request with what this run knows.
  let unreadable = false

  // Every `gh` read passes through here. See MAX_CONCURRENT_GITHUB_READS.
  let activeReads = 0
  const waitingReads: (() => void)[] = []
  async function withReadSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeReads >= MAX_CONCURRENT_GITHUB_READS) {
      await new Promise<void>((resolve) => waitingReads.push(resolve))
    }
    activeReads += 1
    try {
      return await run()
    } finally {
      activeReads -= 1
      waitingReads.shift()?.()
    }
  }

  function mayAsk(): boolean {
    return !disposed && now() >= ghMissingUntil
  }

  // Every GitHub pull request still OPEN is watched, each stopping on its own
  // when it lands, so a menu never shows a stale open one (decision 9).
  const watch = createPullRequestWatchPoller({
    isWatchable: (url) => {
      const entry = entries.get(url)
      return entry ? isWatchable(entry) : false
    },
    probe: (url) => refresh(url),
    timers,
    ...(options.focus ? { focus: options.focus } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.random ? { random: options.random } : {}),
  })
  watch.begin()

  function isWatchable(entry: BranchPullRequest): boolean {
    if (entry.forge || entry.state !== 'open') return false
    // An old capture recorded no moment of opening; its first read says when.
    if (!(entry.openedAt > 0)) return true
    return now() - entry.openedAt <= WATCH_MAX_AGE_MS
  }

  // ── The index ─────────────────────────────────────────────────────────────

  function put(entry: BranchPullRequest): void {
    const previous = entries.get(entry.url)
    if (previous) unindex(previous)
    entries.set(entry.url, entry)
    if (entry.openedByWorkspaceId) {
      addTo(byWorkspace, entry.openedByWorkspaceId, entry.url)
      if (entry.openedByAgentId) {
        addTo(byConversation, conversationId(ownerOf(entry)!), entry.url)
      }
    }
  }

  function unindex(entry: BranchPullRequest): void {
    if (entry.openedByWorkspaceId) byWorkspace.get(entry.openedByWorkspaceId)?.delete(entry.url)
    const owner = ownerOf(entry)
    if (owner) byConversation.get(conversationId(owner))?.delete(entry.url)
  }

  /** At most `MAX_PULL_REQUESTS`; the ones opened longest ago go first. */
  function trim(): void {
    if (entries.size <= MAX_PULL_REQUESTS) return
    const oldest = [...entries.values()].sort((a, b) => a.openedAt - b.openedAt)
    for (const entry of oldest.slice(0, entries.size - MAX_PULL_REQUESTS)) {
      unindex(entry)
      entries.delete(entry.url)
      watch.disarm(entry.url)
    }
  }

  /** The readers one entry reaches: its workspace, and its conversation or every one known in that workspace. */
  function emitFor(entry: BranchPullRequest): void {
    if (!options.onRecordChanged || disposed || !entry.openedByWorkspaceId) return
    const owner = ownerOf(entry)
    const conversations: PullRequestConversationKey[] = owner ? [owner] : []
    if (!owner) {
      for (const id of new Set([...homes.keys(), ...openedAt.keys()])) {
        const key = keyOfId(id)
        if (key.workspaceId === entry.openedByWorkspaceId) conversations.push(key)
      }
    }
    emit({ workspaceIds: [entry.openedByWorkspaceId], conversations })
  }

  function emit(change: PullRequestRecordChange): void {
    if (!options.onRecordChanged || disposed) return
    if (change.workspaceIds.length === 0 && change.conversations.length === 0) return
    try {
      options.onRecordChanged(change)
    } catch (error) {
      warn('a pull request record listener failed', error)
    }
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  function whenLoaded(): Promise<void> {
    load ??= (async () => {
      await sweepStaleTempFiles(options.userDataDir)
      const path = pullRequestStorePath(options.userDataDir)
      let raw: string | null = null
      try {
        raw = await readFile(path, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          unreadable = true
          warn('could not read the pull request record; keeping what is recorded this run in memory only', error)
        }
      }
      let stored: BranchPullRequest[] | null
      let migrated: string[] = []
      if (unreadable) stored = []
      else if (raw === null) {
        const legacy = await readLegacyStores(options.userDataDir, warn)
        stored = legacy.entries
        migrated = legacy.files
      } else {
        stored = parseStoreFile(raw)
        if (stored === null) {
          // Truncated, hand-edited, or written by a version this build does
          // not know: kept aside rather than overwritten by the next write.
          warn('the pull request record could not be understood; keeping it aside as .corrupt', new Error(path))
          await rename(path, `${path}.corrupt`).catch((error) => {
            warn('could not keep an unreadable pull request record aside', error)
          })
          stored = []
        }
      }
      if (disposed) return
      // Anything recorded while the file was being read is newer.
      for (const entry of stored) if (!entries.has(entry.url)) put(entry)
      trim()
      for (const entry of entries.values()) if (isWatchable(entry)) watch.arm(entry.url)
      if (migrated.length > 0) {
        persist()
        // The old files go once the new one is written: a migration that died
        // half way runs again at the next start.
        await writes
        for (const file of migrated) await unlink(file).catch(() => undefined)
      }
    })().catch((error) => warn('could not load the pull request record', error))
    return load
  }

  function persist(): void {
    dirty = true
    writes = writes.then(
      async () => {
        if (!dirty || disposed || unreadable) return
        dirty = false
        const snapshot = { version: STORE_VERSION, pullRequests: [...entries.values()] }
        try {
          await mkdir(join(options.userDataDir, STORE_DIR), { recursive: true })
          await writeFileAtomically(pullRequestStorePath(options.userDataDir), `${JSON.stringify(snapshot, null, 2)}\n`)
        } catch (error) {
          warn('could not write the pull request record', error)
          // Still to write: tried again, or what changed is lost until something else does.
          dirty = true
          if (writeRetry === null && !disposed)
            writeRetry = timers.setTimeout(() => {
              writeRetry = null
              if (dirty) persist()
            }, WRITE_RETRY_MS)
        }
      },
      () => undefined,
    )
  }

  // ── Opening ───────────────────────────────────────────────────────────────

  async function noteOpened(
    key: PullRequestConversationKey,
    input: { url: string; title?: string },
  ): Promise<NoteOpenedOutcome> {
    const classified = typeof input?.url === 'string' ? classifyPullRequestUrl(input.url) : null
    const repository = classified ? pullRequestRepository(classified.url) : null
    if (!classified || !repository) {
      return {
        ok: false,
        code: 'not_a_pull_request',
        message: 'That is not a pull request or merge request URL this app can read.',
      }
    }
    if (!validKey(key)) {
      return { ok: false, code: 'not_a_pull_request', message: 'A pull request is recorded for a conversation.' }
    }
    await whenLoaded()
    if (disposed) return { ok: false, code: 'not_a_pull_request', message: 'The pull request record is closed.' }
    const id = conversationId(key)
    touchActivity(openedAt, id)
    const existing = entries.get(classified.url)
    if (existing?.openedByWorkspaceId) {
      const owner = ownerOf(existing)
      const ours = owner ? conversationId(owner) === id : existing.openedByWorkspaceId === key.workspaceId
      if (!ours) {
        return {
          ok: false,
          code: 'opened_by_another_conversation',
          message: 'Another conversation opened that pull request, and it stays on that conversation.',
        }
      }
      // A capture from before the agent was known names the workspace alone:
      // this conversation is in it, and now says which agent it was.
      if (owner) return { ok: true, pullRequest: existing, recorded: false }
      const claimed: BranchPullRequest = { ...existing, openedByAgentId: key.agentId }
      put(claimed)
      persist()
      emitFor(claimed)
      return { ok: true, pullRequest: claimed, recorded: false }
    }
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 300) : ''
    const entry: BranchPullRequest = {
      url: classified.url,
      repoKey: repository.repoKey,
      repoName: repository.repoName,
      number: classified.number,
      title,
      state: 'open',
      isDraft: false,
      openedAt: now(),
      stateAt: 0,
      ...(classified.forge !== 'github' ? { forge: classified.forge } : {}),
      openedByWorkspaceId: key.workspaceId,
      openedByAgentId: key.agentId,
    }
    put(entry)
    trim()
    persist()
    emitFor(entry)
    if (isWatchable(entry)) {
      watch.arm(entry.url)
      void refresh(entry.url)
    }
    return { ok: true, pullRequest: entry, recorded: true }
  }

  // ── State ─────────────────────────────────────────────────────────────────

  function applyState(
    url: string,
    next: {
      state: PullRequestState
      isDraft: boolean
      stateAt: number
      headRefName: string | null
      title?: string | null
      openedAt?: number | null
      number?: number | null
      endedAt?: number
    },
  ): void {
    const entry = entries.get(url)
    if (!entry) return
    // The host's word wins where it gave one; a read that said nothing never
    // blanks what we have. One that is open again (reopened) has no end.
    const { endedAt: _endedAt, ...unended } = entry
    const updated: BranchPullRequest = {
      ...(next.state === 'open' ? unended : entry),
      ...(next.state !== 'open' && typeof next.endedAt === 'number' ? { endedAt: next.endedAt } : {}),
      ...(next.title ? { title: next.title } : {}),
      ...(typeof next.openedAt === 'number' && next.openedAt > 0 ? { openedAt: next.openedAt } : {}),
      ...(typeof next.number === 'number' && next.number > 0 ? { number: next.number } : {}),
      ...(next.headRefName ? { headRefName: next.headRefName } : {}),
      state: next.state,
      isDraft: next.isDraft,
      stateAt: next.stateAt,
    }
    const learned = !sameReading(entry, updated)
    put(updated)
    // A read that learned nothing is not worth a write: only its time moved.
    if (!learned) return
    persist()
    watch.noteChanged(url)
    if (!isWatchable(updated)) watch.disarm(url)
    emitFor(updated)
  }

  async function refresh(url: string): Promise<void> {
    if (disposed) return
    const entry = entries.get(url)
    if (!entry || entry.forge) return
    const inFlight = refreshesInFlight.get(url)
    if (inFlight) return inFlight
    // A read that could not settle is HELD: with `gh` unauthenticated or rate
    // limited every read fails instantly, and each focus would otherwise spawn
    // `gh` once per open pull request, for ever, learning nothing.
    const hold = refreshHolds.get(url)
    if (hold && !hold.settled && now() - hold.at < READ_RETRY_AFTER_FAILURE_MS) return
    if (!mayAsk()) return
    const read = (async () => {
      const outcome = await withReadSlot(() =>
        mayAsk() ? readState(url, { now }) : Promise.resolve({ settled: false, reason: 'bad-request' } as const),
      )
      if (disposed) return
      if (!outcome.settled) {
        if (outcome.reason === 'gh-missing') ghMissingUntil = now() + GH_MISSING_HOLD_MS
        refreshHolds.set(url, { at: now(), settled: false })
        return
      }
      refreshHolds.delete(url)
      applyState(url, outcome)
    })().catch((error) => {
      warn('could not refresh a pull request state', error)
    })
    refreshesInFlight.set(url, read)
    try {
      await read
    } finally {
      if (refreshesInFlight.get(url) === read) refreshesInFlight.delete(url)
    }
  }

  /** The stale open readings in a list, re-read. Each URL's refresh coalesces itself. */
  function refreshStale(list: readonly BranchPullRequest[]): void {
    const cutoff = now() - HOVER_REFRESH_STALE_MS
    for (const entry of list) {
      if (entry.forge || entry.state !== 'open' || entry.stateAt > cutoff) continue
      void refresh(entry.url)
    }
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  function entriesAt(urls: Iterable<string> | undefined): BranchPullRequest[] {
    const found: BranchPullRequest[] = []
    for (const url of urls ?? []) {
      const entry = entries.get(url)
      if (entry) found.push(entry)
    }
    return found
  }

  function forConversation(key: PullRequestConversationKey): BranchPullRequest[] {
    if (!validKey(key)) return []
    const own = entriesAt(byConversation.get(conversationId(key)))
    // A capture from before the agent was known: every conversation in its workspace wears it.
    const unclaimed = entriesAt(byWorkspace.get(key.workspaceId)).filter((entry) => !entry.openedByAgentId)
    const home = homes.get(conversationId(key))?.checkout.branch
    return [...own, ...unclaimed]
      .sort(newestFirst)
      .map((entry) => (home && entry.headRefName === home ? { ...entry, onSessionBranch: true } : entry))
  }

  function forWorkspace(workspaceId: string): BranchPullRequest[] {
    return entriesAt(byWorkspace.get(workspaceId)).sort(newestFirst)
  }

  function noteCheckout(key: PullRequestConversationKey, input: PullRequestCheckout): void {
    if (disposed || !validKey(key)) return
    const gitRoot = input?.gitRoot?.trim()
    const branch = input?.branch?.trim()
    if (!gitRoot || !branch) return
    const id = conversationId(key)
    const before = homes.get(id)?.checkout.branch
    homes.delete(id)
    homes.set(id, { checkout: { gitRoot, branch }, at: now() })
    while (homes.size > MAX_CONVERSATIONS) {
      const oldest = homes.keys().next().value
      if (oldest === undefined) break
      homes.delete(oldest)
    }
    // The branch decides which of its pull requests may say the branch landed.
    if (before !== branch && forConversation(key).some((entry) => entry.headRefName)) {
      emit({ workspaceIds: [key.workspaceId], conversations: [{ ...key }] })
    }
  }

  function touchActivity(map: Map<string, number>, id: string): void {
    map.delete(id)
    map.set(id, now())
    while (map.size > MAX_CONVERSATIONS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  if (options.loadStoredOnStart) void whenLoaded()

  return {
    noteOpened,
    forConversation,
    forWorkspace,
    noteCheckout,
    homeOf(key) {
      const home = homes.get(conversationId(key))
      return home ? { ...home.checkout } : null
    },
    refresh,
    refreshConversation(key) {
      if (disposed) return false
      const own = forConversation(key)
      refreshStale(own)
      return own.length > 0
    },
    refreshWorkspace(workspaceId) {
      if (disposed || !workspaceId) return false
      const opened = forWorkspace(workspaceId)
      refreshStale(opened)
      return opened.length > 0
    },
    refreshOutstanding() {
      if (disposed) return
      void whenLoaded().then(() => {
        if (!disposed) refreshStale([...entries.values()].filter(isWatchable))
      })
    },
    conversationsActiveSince(since) {
      const latest = new Map<string, number>()
      for (const [id, home] of homes) latest.set(id, home.at)
      for (const [id, at] of openedAt) latest.set(id, Math.max(at, latest.get(id) ?? 0))
      return [...latest.entries()]
        .filter(([, at]) => at >= since)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => keyOfId(id))
    },
    whenLoaded,
    watchedUrls() {
      return watch.watchedKeys()
    },
    async flush() {
      for (let pass = 0; pass < 8; pass += 1) {
        await Promise.allSettled([load ?? Promise.resolve(), writes, ...refreshesInFlight.values()])
        if (refreshesInFlight.size === 0) {
          // One more pass over the write chain, which the last read extended.
          await writes
          return
        }
      }
    },
    dispose() {
      disposed = true
      if (writeRetry !== null) timers.clearTimeout(writeRetry)
      writeRetry = null
      watch.dispose()
      while (waitingReads.length > 0) waitingReads.shift()?.()
      refreshHolds.clear()
      refreshesInFlight.clear()
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function newestFirst(a: BranchPullRequest, b: BranchPullRequest): number {
  return b.openedAt - a.openedAt || b.number - a.number
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>()
  values.add(value)
  index.set(key, values)
}

function conversationId(key: PullRequestConversationKey): string {
  return `${key.workspaceId}\0${key.agentId}`
}

function keyOfId(id: string): PullRequestConversationKey {
  const split = id.indexOf('\0')
  return { workspaceId: id.slice(0, split), agentId: id.slice(split + 1) }
}

function ownerOf(entry: BranchPullRequest): PullRequestConversationKey | null {
  return entry.openedByWorkspaceId && entry.openedByAgentId
    ? { workspaceId: entry.openedByWorkspaceId, agentId: entry.openedByAgentId }
    : null
}

function validKey(key: PullRequestConversationKey | null | undefined): key is PullRequestConversationKey {
  return Boolean(
    key &&
    typeof key.workspaceId === 'string' &&
    key.workspaceId.length > 0 &&
    typeof key.agentId === 'string' &&
    key.agentId.length > 0,
  )
}

/** Two readings as a reader would see them, plus when the host was asked: what decides a write. */
function sameReading(a: BranchPullRequest, b: BranchPullRequest): boolean {
  return (
    a.title === b.title &&
    a.state === b.state &&
    a.isDraft === b.isDraft &&
    a.openedAt === b.openedAt &&
    a.endedAt === b.endedAt &&
    a.number === b.number &&
    a.headRefName === b.headRefName
  )
}

/** The record's file, or null when this build cannot read it. Malformed rows are dropped. */
function parseStoreFile(raw: string): BranchPullRequest[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.pullRequests)) return null
  return parsed.pullRequests.map((row) => parseEntry(row, null)).filter((entry) => entry !== null)
}

/**
 * The files the branch-lookup rule wrote, read once: one per repository,
 * `{ version: 1, repoKey, branches: { <branch>: rows } }`. Only a row a
 * conversation's capture filed (`openedByWorkspaceId`) is kept; everything a
 * branch lookup found is dropped. Returns the files to remove once the new one
 * is written, the conversations file among them.
 */
async function readLegacyStores(
  userDataDir: string,
  warn: (message: string, error: unknown) => void,
): Promise<{ entries: BranchPullRequest[]; files: string[] }> {
  const dir = join(userDataDir, STORE_DIR)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return { entries: [], files: [] }
  }
  const kept = new Map<string, BranchPullRequest>()
  const files: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name === STORE_FILE) continue
    const path = join(dir, name)
    if (name === LEGACY_CONVERSATIONS_FILE) {
      files.push(path)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf-8'))
    } catch (error) {
      warn('an old pull request record could not be read, and is left where it is', error)
      continue
    }
    if (!isRecord(parsed) || parsed.version !== LEGACY_STORE_VERSION || !isRecord(parsed.branches)) continue
    files.push(path)
    for (const [branch, rows] of Object.entries(parsed.branches)) {
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        const entry = parseEntry(row, branch || null)
        if (entry?.openedByWorkspaceId && !kept.has(entry.url)) kept.set(entry.url, entry)
      }
    }
  }
  return { entries: [...kept.values()], files }
}

// The file survives restarts and a person can edit it, so it is read as
// untrusted: a row that is not a well-formed pull request is dropped rather
// than smuggled into a mark.
function parseEntry(raw: unknown, branch: string | null): BranchPullRequest | null {
  if (!isRecord(raw)) return null
  const url = typeof raw.url === 'string' ? canonicalPullRequestUrlOf(raw.url.trim()) : null
  if (!url) return null
  const repository = pullRequestRepository(url)
  const classified = classifyPullRequestUrl(url)
  if (!repository || !classified) return null
  const state = raw.state
  if (state !== 'open' && state !== 'merged' && state !== 'closed') return null
  const number = typeof raw.number === 'number' && Number.isInteger(raw.number) && raw.number > 0 ? raw.number : 0
  const openedAt = typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt) ? raw.openedAt : 0
  const stateAt = typeof raw.stateAt === 'number' && Number.isFinite(raw.stateAt) ? raw.stateAt : 0
  const endedAt =
    state !== 'open' && typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt) ? raw.endedAt : null
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
  const workspaceId = text(raw.openedByWorkspaceId, 200)
  const agentId = workspaceId ? text(raw.openedByAgentId, 200) : null
  const headRefName = text(raw.headRefName, 255) ?? (branch && branch.length <= 255 ? branch : null)
  return {
    url,
    // Re-derived from the URL rather than trusted: the key is what files a pull
    // request, and a mangled one would file it under a repository it is not in.
    repoKey: repository.repoKey,
    repoName: repository.repoName,
    number: number || classified.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: classified.forge === 'github' ? state : 'open',
    isDraft: raw.isDraft === true && state === 'open',
    openedAt,
    stateAt,
    ...(endedAt !== null && classified.forge === 'github' ? { endedAt } : {}),
    ...(classified.forge !== 'github' ? { forge: classified.forge } : {}),
    ...(workspaceId ? { openedByWorkspaceId: workspaceId } : {}),
    ...(agentId ? { openedByAgentId: agentId } : {}),
    ...(headRefName ? { headRefName } : {}),
  }
}

/** Swept at the first load: a `.tmp` nothing is writing any more. */
async function sweepStaleTempFiles(userDataDir: string): Promise<void> {
  const dir = join(userDataDir, STORE_DIR)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  // Wall-clock, not an injected clock: this is a file's age, and a write in
  // flight RIGHT NOW must not have its temp file pulled out from under it.
  const cutoff = Date.now() - TEMP_FILE_SWEEP_MIN_AGE_MS
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.mtimeMs > cutoff) continue
      await unlink(path)
    } catch {
      // Already gone, or not ours to remove. Either is fine.
    }
  }
}
