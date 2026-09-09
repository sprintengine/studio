// The pull request record: which pull requests a conversation has, and what
// state each is in (epic `pull-request-marks`, decisions 3, 5, 9, 10). This is
// the OWNER of that fact — the sidebar mark, the peek's split control and the
// tooltip all read what is written here, and nothing else may decide it.
//
// KEYED BY REPOSITORY, NOT BY CHECKOUT. A pull request belongs to a repository
// (`host/owner/name`, the key every clone of it shares — the same
// `canonicalRepositoryKey` the sidebar groups folders by) and a branch. It is
// deliberately NOT keyed by the session's git root, because an agent opens pull
// requests in repositories its session does not sit in: `cd ../website && gh pr
// create` never moves the session's observed cwd, and a capture keyed off that
// cwd would file the website's pull request under this repository, on a branch
// it has never heard of. The URL says which repository; that is what we key on.
//
// A SESSION'S MARKS ARE A UNION (decision 10): the pull requests on the
// repository+branch its checkout is observed to be on, plus the ones it opened
// ITSELF anywhere, de-duplicated by URL and newest first. The branch lookup can
// only ever discover the first kind — `gh pr list` runs in one checkout — so the
// second is what makes a cross-repository pull request visible at all, and only
// for CLIs whose hooks report it.
//
// A CAPTURED PULL REQUEST HAS NO BRANCH YET. The hook sees a URL and a session,
// nothing more. It is filed under the repository with an unknown branch, and the
// first state read learns its `headRefName`, at which point it moves under that
// branch and joins whatever the lookup finds there.
//
// NOT ON THE AGENT RECORD (decision 10). The agent record persists in two places
// with no per-field conflict rule, so a fact refreshed by a headless watch would
// be clobbered by whichever window wrote last. This store is main-owned, on
// disk under `userData` exactly as `git-changelists.ts` keeps its lists, and
// reaches the renderer on the terminal session snapshot it already receives.
//
// WHAT MAY BE WRITTEN DOWN. Only a SETTLED read (see
// `github/branch-pull-request.ts`). "This branch has no pull request" is an
// answer and it is recorded; "I could not ask" changes nothing at all — a mark
// must never blink out because a laptop was offline for one probe. And state
// comes only from GitHub: there is no ancestry inference anywhere in this file,
// because a squash merge or a rebase would make it lie for ever (decision 8c).
//
// EARLIER PULL REQUESTS ARE NEVER DROPPED (decision 6). A lookup merges by URL
// and adds; it never deletes. A pull request that scrolled out of `gh pr list`
// (a branch reused for a second one, a repository transferred) stays on the
// record with the state it last had.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  canonicalPullRequestUrlOf,
  pullRequestRepository,
  unionPullRequests,
  type BranchPullRequest,
  type PullRequestState,
} from '../shared/git/pull-request'
import { isRecord } from '../shared/records'
import { isPullRequestWatchable } from '../shared/sprintengine/vcs'
import {
  listBranchPullRequests as listBranchPullRequestsDefault,
  readPullRequestState as readPullRequestStateDefault,
} from './github/branch-pull-request'
import {
  createPullRequestWatchPoller,
  type WatchPollerTimers,
} from './github/pull-request-watch-poller'
import { normalizeComparablePath } from './git-utils'
import { readRepositoryIdentityRead } from './repository-identity'

const STORE_DIR = 'pull-requests'
const STORE_VERSION = 1

/** The bucket a captured pull request sits in until GitHub names its branch. A ref name is never empty. */
const UNKNOWN_BRANCH = ''

/**
 * How long a settled branch lookup is held before another `gh pr list` is worth
 * making, and how long an UNSETTLED one is held before the next ask really asks
 * (the `{ at, read, settled }` hold/retry shape of `repository-identity.ts`: a
 * failure must not be cached for the full minute, and must not be retried on
 * every hover either).
 */
export const LOOKUP_HOLD_MS = 60_000
export const LOOKUP_RETRY_AFTER_FAILURE_MS = 10_000

/**
 * How old a state reading may be before hovering a conversation re-reads it
 * (decision 9). Coalesced by the per-URL in-flight map, so a pointer sweeping
 * down a sidebar buys one `gh` call per pull request, not one per hover.
 */
export const HOVER_REFRESH_STALE_MS = 60_000

/** What the record needs to see of a terminal session. Structural, so it can be tested without a pty. */
export type PullRequestRecordSession = {
  sessionId?: string
  observedCheckout?: { resolved: boolean; gitRoot: string | null; branch: string | null } | null
}

/** Where a session's own checkout is, when it has one. */
export type PullRequestCheckout = { gitRoot: string; branch: string }

/**
 * One list changed. `branch` is the branch whose list moved — `null` when the
 * change is "anything in this repository" (a checkout that has just been
 * resolved to it), and the empty string for the not-yet-known-branch bucket.
 * `sessionIds` are the sessions that opened entries in it, which is how a
 * conversation hears about a pull request it made in another repository.
 */
export type PullRequestRecordChange = {
  repoKey: string
  branch: string | null
  sessionIds: string[]
}

export type PullRequestRecordOptions = {
  userDataDir: string
  /** The two GitHub reads, injected so tests never spawn `gh`. */
  reads?: {
    listBranchPullRequests?: typeof listBranchPullRequestsDefault
    readPullRequestState?: typeof readPullRequestStateDefault
  }
  /** A checkout's repository key, injected so tests need no git remote. */
  resolveRepoKey?: (gitRoot: string) => Promise<string | null>
  /** Live sessions, for the hover and window-focus refreshes. */
  sessions?: {
    get(sessionId: string): PullRequestRecordSession | null
    list(): readonly PullRequestRecordSession[]
  }
  /**
   * A list changed. The app turns it into a re-emit of the terminal session
   * snapshots of every session the change reaches — see `changeAffectsSession`.
   */
  onRecordChanged?: (change: PullRequestRecordChange) => void
  now?: () => number
  timers?: WatchPollerTimers
  random?: () => number
  logWarning?: (message: string, error: unknown) => void
}

export type PullRequestRecord = {
  /** One repository and branch's pull requests, newest first. */
  forBranch(repoKey: string, branch: string): BranchPullRequest[]
  /** Every pull request this session opened, in any repository, newest first. */
  forSession(sessionId: string): BranchPullRequest[]
  /**
   * What a session wears: the union of the two above, de-duplicated by URL and
   * newest first. Synchronous, because the terminal snapshot is built from it on
   * every broadcast. The stored arrays are never mutated in place — a change
   * replaces them — so a snapshot may hold one safely.
   */
  listForSession(session: PullRequestRecordSession | null | undefined): BranchPullRequest[]
  /**
   * Hook capture (the next item): a pull request this session just opened,
   * anywhere. Filed by the URL's own repository; its branch is learned from the
   * state read this schedules.
   */
  noteCaptured(input: { url: string; sessionId?: string }): void
  /** One `gh pr list` per checkout+branch per hold, merged in. Unsettled reads change nothing. */
  ensureLookedUp(input: PullRequestCheckout): Promise<void>
  /** Re-read one pull request's state by URL. Unsettled leaves the last reading standing. */
  refresh(url: string): Promise<void>
  /** The hover hook: look this session's branch up, and refresh readings older than ~60s. */
  refreshForSession(sessionId: string): void
  /** Window focus: the same, for every live session. */
  refreshOnFocus(): void
  /** Whether a change reaches this session — the re-emit's filter. */
  changeAffectsSession(change: PullRequestRecordChange, session: PullRequestRecordSession): boolean
  /** URLs holding a live watch timer. Introspection for diagnostics and tests. */
  watchedUrls(): string[]
  /** Settle every load, write and read in flight. The tests' synchronisation point. */
  flush(): Promise<void>
  dispose(): void
}

/**
 * The checkout and branch a session's OWN pull requests would be on, or null
 * when there is none to name yet. The observed checkout only — launch intent
 * says where the app PUT an agent, not where it is, and a mark filed against the
 * wrong checkout is worse than a mark that appears a moment later.
 */
export function pullRequestSessionCheckout(
  session: PullRequestRecordSession | null | undefined,
): PullRequestCheckout | null {
  const observed = session?.observedCheckout
  if (!observed?.resolved) return null
  const gitRoot = observed.gitRoot?.trim()
  const branch = observed.branch?.trim()
  // A detached HEAD has no branch to look a pull request up by.
  if (!gitRoot || !branch) return null
  return { gitRoot, branch }
}

/** The file one repository's branches live in. Same scheme as `git-changelists.ts`. */
export function pullRequestStorePath(userDataDir: string, repoKey: string): string {
  const hash = createHash('sha1').update(repoKey).digest('hex').slice(0, 16)
  const name = repoKey.split('/').filter(Boolean).pop() ?? 'repo'
  const slug = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'
  return join(userDataDir, STORE_DIR, `${slug}-${hash}.json`)
}

type StoreFile = {
  version: number
  repoKey: string
  branches: Record<string, BranchPullRequest[]>
}

type RepoState = {
  repoKey: string
  /** Branch → its pull requests, newest first. `UNKNOWN_BRANCH` holds captures GitHub has not placed yet. */
  branches: Map<string, BranchPullRequest[]>
  loaded: boolean
  loading: Promise<void> | null
  writes: Promise<unknown>
}

type Located = { repoKey: string; branch: string; entry: BranchPullRequest }

type Hold = { at: number; settled: boolean }

export function createPullRequestRecord(options: PullRequestRecordOptions): PullRequestRecord {
  const now = options.now ?? (() => Date.now())
  const listBranch = options.reads?.listBranchPullRequests ?? listBranchPullRequestsDefault
  const readState = options.reads?.readPullRequestState ?? readPullRequestStateDefault
  const resolveRepoKey = options.resolveRepoKey ?? defaultResolveRepoKey
  const warn =
    options.logWarning
    ?? ((message: string, error: unknown) => console.warn(`[pull-request-record] ${message}`, error))

  const repos = new Map<string, RepoState>()
  /** Every entry, by URL — the index behind `forSession` and every relocation. */
  const located = new Map<string, Located>()
  /** Session → the URLs it opened. Rebuilt from `openedBySessionId` on load. */
  const bySession = new Map<string, Set<string>>()
  /** A checkout's repository, once git has answered. Only settled answers are kept. */
  const repoKeyByCheckout = new Map<string, string>()
  const repoKeyReads = new Map<string, Promise<void>>()
  const held = new Map<string, Hold>()
  const lookupsInFlight = new Map<string, Promise<void>>()
  const refreshesInFlight = new Map<string, Promise<void>>()
  let disposed = false

  // Every pull request still OPEN is watched, each stopping on its own when it
  // lands, so a menu never shows a stale open one (decision 9). The key is the
  // pull request URL: one timer per pull request, however many branches or
  // conversations happen to carry it.
  const watch = createPullRequestWatchPoller({
    isWatchable: (url) => isUrlWatchable(url),
    probe: (url) => refresh(url),
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.random ? { random: options.random } : {}),
  })
  watch.begin()

  function repoStateFor(repoKey: string): RepoState {
    const existing = repos.get(repoKey)
    if (existing) return existing
    const state: RepoState = { repoKey, branches: new Map(), loaded: false, loading: null, writes: Promise.resolve() }
    repos.set(repoKey, state)
    return state
  }

  function load(state: RepoState): Promise<void> {
    if (state.loaded) return Promise.resolve()
    if (state.loading) return state.loading
    const loading = (async () => {
      let raw: string | null = null
      try {
        raw = await readFile(pullRequestStorePath(options.userDataDir, state.repoKey), 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          // A store we cannot read starts over rather than taking the marks
          // down; the next lookup refills it from GitHub.
          warn('could not read a stored pull request record', error)
        }
      }
      state.loaded = true
      state.loading = null
      if (disposed) return
      const stored = raw === null ? new Map<string, BranchPullRequest[]>() : parseStoreFile(raw)
      for (const [branch, entries] of stored) {
        // Anything learned while the read was in flight wins: it came from a
        // live read of GitHub, the file did not.
        const fresh = entries.filter((entry) => !located.has(entry.url))
        if (fresh.length === 0) continue
        commit(state, branch, [...entriesOf(state, branch), ...fresh])
      }
    })()
    state.loading = loading
    return loading
  }

  async function loadedRepo(repoKey: string): Promise<RepoState> {
    const state = repoStateFor(repoKey)
    await load(state)
    return state
  }

  function persist(state: RepoState): void {
    const snapshot: StoreFile = {
      version: STORE_VERSION,
      repoKey: state.repoKey,
      branches: Object.fromEntries(state.branches),
    }
    // One writer per repository, chained: two branches settling a frame apart
    // must not both read-modify-write the same file.
    state.writes = state.writes.then(
      () => writeStoreFile(options.userDataDir, state.repoKey, snapshot).catch((error) => {
        warn('could not write a pull request record', error)
      }),
      () => undefined,
    )
  }

  function emitChanged(repoKey: string, branch: string | null, sessionIds: string[]): void {
    if (!options.onRecordChanged || disposed) return
    try {
      options.onRecordChanged({ repoKey, branch, sessionIds })
    } catch (error) {
      warn('a pull request record listener failed', error)
    }
  }

  function entriesOf(state: RepoState, branch: string): BranchPullRequest[] {
    return state.branches.get(branch) ?? []
  }

  function sessionIdsOf(...lists: readonly (readonly BranchPullRequest[])[]): string[] {
    const ids = new Set<string>()
    for (const list of lists) for (const entry of list) if (entry.openedBySessionId) ids.add(entry.openedBySessionId)
    return [...ids]
  }

  /** Keep `located` and `bySession` in step with one list's replacement. */
  function indexList(
    repoKey: string,
    branch: string,
    previous: readonly BranchPullRequest[],
    next: readonly BranchPullRequest[],
  ): void {
    for (const entry of previous) {
      const at = located.get(entry.url)
      if (at && at.repoKey === repoKey && at.branch === branch) located.delete(entry.url)
      if (entry.openedBySessionId) bySession.get(entry.openedBySessionId)?.delete(entry.url)
    }
    for (const entry of next) {
      located.set(entry.url, { repoKey, branch, entry })
      if (!entry.openedBySessionId) continue
      const urls = bySession.get(entry.openedBySessionId) ?? new Set<string>()
      urls.add(entry.url)
      bySession.set(entry.openedBySessionId, urls)
    }
  }

  /**
   * Replace a branch's list, newest first. Writes, re-emits and reconciles the
   * watch only when something actually changed — a focus refresh that learned
   * nothing must not repaint every window.
   */
  function commit(state: RepoState, branch: string, next: BranchPullRequest[]): void {
    const sorted = [...next].sort((a, b) => b.openedAt - a.openedAt || b.number - a.number)
    const previous = entriesOf(state, branch)
    if (sameList(previous, sorted)) return
    state.branches.set(branch, sorted)
    indexList(state.repoKey, branch, previous, sorted)
    persist(state)
    reconcileWatch(state, branch)
    emitChanged(state.repoKey, branch, sessionIdsOf(previous, sorted))
  }

  function isUrlWatchable(url: string): boolean {
    const at = located.get(url)
    if (!at) return false
    // The one rule, shared with the sprint run watch: merged and closed are
    // terminal and stop for good; open is the live case.
    return isPullRequestWatchable({ hasVcs: true, prState: at.entry.state, hasPrUrl: true })
  }

  function reconcileWatch(state: RepoState, branch: string): void {
    for (const entry of entriesOf(state, branch)) {
      if (isPullRequestWatchable({ hasVcs: true, prState: entry.state, hasPrUrl: true })) watch.arm(entry.url)
      else if (!isUrlWatchable(entry.url)) watch.disarm(entry.url)
    }
  }

  /**
   * Apply a settled reading to the one entry with that URL, and move it under
   * the branch GitHub named if it was still in the unknown bucket.
   */
  function applyState(
    url: string,
    next: { state: PullRequestState; isDraft: boolean; stateAt: number; headRefName: string | null },
  ): void {
    const at = located.get(url)
    if (!at) return
    const state = repos.get(at.repoKey)
    if (!state) return
    const updated: BranchPullRequest = {
      ...at.entry,
      state: next.state,
      isDraft: next.isDraft,
      stateAt: next.stateAt,
    }
    const target = at.branch === UNKNOWN_BRANCH && next.headRefName ? next.headRefName : at.branch
    if (target === at.branch) {
      commit(state, at.branch, entriesOf(state, at.branch).map((entry) => (entry.url === url ? updated : entry)))
      return
    }
    // Learned its branch: out of the unknown bucket and in beside whatever the
    // branch lookup has already found there.
    commit(state, at.branch, entriesOf(state, at.branch).filter((entry) => entry.url !== url))
    commit(state, target, mergeByUrl(entriesOf(state, target), [updated]))
  }

  async function refresh(url: string): Promise<void> {
    if (disposed) return
    const inFlight = refreshesInFlight.get(url)
    if (inFlight) return inFlight
    const read = (async () => {
      const outcome = await readState(url, { now })
      if (disposed) return
      // Unsettled: the state stays as last read. Nothing is written, nothing is
      // emitted, and the watch keeps its schedule.
      if (!outcome.settled) return
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

  async function ensureLookedUp(input: PullRequestCheckout): Promise<void> {
    if (disposed) return
    const checkout = normalizeCheckout(input)
    if (!checkout) return
    const key = `${normalizeComparablePath(checkout.gitRoot)} ${checkout.branch}`
    const hold = held.get(key)
    if (hold && now() - hold.at < LOOKUP_HOLD_MS) return
    const inFlight = lookupsInFlight.get(key)
    if (inFlight) return inFlight

    const lookup = (async () => {
      const read = await listBranch({ gitRoot: checkout.gitRoot, branch: checkout.branch }, { now })
      if (disposed) return
      if (!read.settled) {
        // Could not ask. The record is left exactly as it was, and the hold is
        // dated into the past so the next ask really asks.
        held.set(key, { at: now() - LOOKUP_HOLD_MS + LOOKUP_RETRY_AFTER_FAILURE_MS, settled: false })
        return
      }
      held.set(key, { at: now(), settled: true })
      // One `gh pr list` answers for one repository, but the rows carry their
      // own — a fork's pull request is in the fork — so they are grouped rather
      // than assumed.
      for (const [repoKey, incoming] of groupByRepo(read.pullRequests)) {
        const state = await loadedRepo(repoKey)
        if (disposed) return
        // A captured entry for one of these URLs may still be sitting in the
        // unknown-branch bucket. What it knows — the session that opened it — is
        // read BEFORE it is taken out of that bucket, because taking it out
        // drops it from the index the merge would otherwise read it from.
        const priors = new Map<string, BranchPullRequest>()
        for (const entry of incoming) {
          const at = located.get(entry.url)
          if (at) priors.set(entry.url, at.entry)
        }
        for (const entry of incoming) detachFromOtherBranch(state, entry.url, checkout.branch)
        commit(state, checkout.branch, mergeByUrl(entriesOf(state, checkout.branch), incoming, priors))
      }
    })().catch((error) => {
      warn('could not look a branch up', error)
    })
    lookupsInFlight.set(key, lookup)
    try {
      await lookup
    } finally {
      if (lookupsInFlight.get(key) === lookup) lookupsInFlight.delete(key)
    }
  }

  function detachFromOtherBranch(state: RepoState, url: string, keepBranch: string): void {
    const at = located.get(url)
    if (!at || at.repoKey !== state.repoKey || at.branch === keepBranch) return
    commit(state, at.branch, entriesOf(state, at.branch).filter((entry) => entry.url !== url))
  }

  /** Everything we hold about a URL, wherever it sits — the merge's memory. */
  function priorOf(url: string): BranchPullRequest | undefined {
    return located.get(url)?.entry
  }

  function mergeByUrl(
    existing: readonly BranchPullRequest[],
    incoming: readonly BranchPullRequest[],
    priors?: ReadonlyMap<string, BranchPullRequest>,
  ): BranchPullRequest[] {
    const merged = new Map<string, BranchPullRequest>()
    for (const entry of existing) merged.set(entry.url, entry)
    for (const entry of incoming) {
      // A captured entry's `openedBySessionId` is the one field a branch lookup
      // can NEVER supply, so it is the one field the merge preserves — losing it
      // would unfile a conversation's own pull request from the conversation.
      const previous = merged.get(entry.url) ?? priors?.get(entry.url) ?? priorOf(entry.url)
      merged.set(
        entry.url,
        previous?.openedBySessionId ? { ...entry, openedBySessionId: previous.openedBySessionId } : entry,
      )
    }
    return [...merged.values()]
  }

  /** A checkout's repository key, if git has already answered. Kicks off the read when it has not. */
  function repoKeyFor(gitRoot: string): string | null {
    const key = normalizeComparablePath(gitRoot)
    const known = repoKeyByCheckout.get(key)
    if (known !== undefined) return known
    if (!repoKeyReads.has(key) && !disposed) {
      const read = (async () => {
        const repoKey = await resolveRepoKey(gitRoot)
        if (disposed || !repoKey) return
        // Only a settled answer is remembered; a remote that could not be read
        // is asked about again rather than cached as "no repository".
        repoKeyByCheckout.set(key, repoKey)
        // Sessions on this checkout can be answered for now: anything in that
        // repository may be theirs.
        emitChanged(repoKey, null, [])
      })()
        .catch((error) => warn('could not resolve a checkout repository', error))
        .finally(() => {
          repoKeyReads.delete(key)
        })
      repoKeyReads.set(key, read)
    }
    return null
  }

  function forBranch(repoKey: string, branch: string): BranchPullRequest[] {
    const state = repoStateFor(repoKey)
    // First ask about this repository: read the file, and re-emit when it lands.
    // Until then the honest answer is "nothing known", never a guess.
    if (!state.loaded) void load(state)
    return entriesOf(state, branch)
  }

  function forSession(sessionId: string): BranchPullRequest[] {
    const urls = bySession.get(sessionId)
    if (!urls || urls.size === 0) return []
    const entries: BranchPullRequest[] = []
    for (const url of urls) {
      const at = located.get(url)
      if (at) entries.push(at.entry)
    }
    return entries.sort((a, b) => b.openedAt - a.openedAt || b.number - a.number)
  }

  function listForSession(session: PullRequestRecordSession | null | undefined): BranchPullRequest[] {
    const own = session?.sessionId ? forSession(session.sessionId) : []
    const checkout = pullRequestSessionCheckout(session)
    const repoKey = checkout ? repoKeyFor(checkout.gitRoot) : null
    const onBranch = repoKey && checkout ? forBranch(repoKey, checkout.branch) : []
    if (own.length === 0) return onBranch
    if (onBranch.length === 0) return own
    return unionPullRequests(onBranch, own)
  }

  /** The stale readings on a session's list, refreshed. Each URL's refresh coalesces itself. */
  function refreshStale(session: PullRequestRecordSession): void {
    const cutoff = now() - HOVER_REFRESH_STALE_MS
    for (const entry of listForSession(session)) {
      // Merged and closed are terminal: there is nothing left to learn.
      if (entry.state !== 'open') continue
      if (entry.stateAt > cutoff) continue
      void refresh(entry.url)
    }
  }

  function refreshSession(session: PullRequestRecordSession): void {
    const checkout = pullRequestSessionCheckout(session)
    if (!checkout) {
      // No checkout to look a branch up in — but the pull requests this session
      // opened elsewhere still age.
      refreshStale(session)
      return
    }
    void ensureLookedUp(checkout).then(() => {
      if (!disposed) refreshStale(session)
    })
  }

  return {
    forBranch,
    forSession,
    listForSession,

    noteCaptured(input) {
      const url = canonicalPullRequestUrlOf(input.url?.trim() ?? '')
      const repository = url ? pullRequestRepository(url) : null
      if (!url || !repository || disposed) return
      void (async () => {
        const state = await loadedRepo(repository.repoKey)
        if (disposed) return
        const existing = located.get(url)
        if (existing) {
          // Already known — from the branch lookup, or from an earlier capture.
          // A session id is the one thing this capture can add, and only when
          // the entry has none: an existing one is never overwritten.
          if (!input.sessionId || existing.entry.openedBySessionId) return
          const owner = repos.get(existing.repoKey)
          if (!owner) return
          commit(
            owner,
            existing.branch,
            entriesOf(owner, existing.branch).map((entry) =>
              entry.url === url ? { ...entry, openedBySessionId: input.sessionId } : entry,
            ),
          )
          return
        }
        const at = now()
        // A pull request the app watched being created is open the moment it
        // exists (decision 3). Its number comes off the URL; its branch and
        // title arrive with the reads this schedules — so the mark can be drawn
        // before either lands.
        commit(state, UNKNOWN_BRANCH, [
          ...entriesOf(state, UNKNOWN_BRANCH),
          {
            url,
            repoKey: repository.repoKey,
            repoName: repository.repoName,
            number: numberFromUrl(url),
            title: '',
            state: 'open',
            isDraft: false,
            openedAt: at,
            stateAt: at,
            ...(input.sessionId ? { openedBySessionId: input.sessionId } : {}),
          },
        ])
        void refresh(url)
      })().catch((error) => warn('could not record a captured pull request', error))
    },

    ensureLookedUp,
    refresh,

    refreshForSession(sessionId) {
      const session = options.sessions?.get(sessionId) ?? null
      if (!session || disposed) return
      refreshSession(session)
    },

    refreshOnFocus() {
      if (disposed) return
      for (const session of options.sessions?.list() ?? []) refreshSession(session)
    },

    changeAffectsSession(change, session) {
      // The conversation that opened it hears about it wherever it lives.
      if (session.sessionId && change.sessionIds.includes(session.sessionId)) return true
      const checkout = pullRequestSessionCheckout(session)
      if (!checkout) return false
      // Only an already-resolved checkout can match by repository; an
      // unresolved one is re-emitted for when its resolution lands (see
      // `repoKeyFor`), so nothing is lost by not asking git from here.
      const repoKey = repoKeyByCheckout.get(normalizeComparablePath(checkout.gitRoot))
      if (!repoKey || repoKey !== change.repoKey) return false
      return change.branch === null || change.branch === checkout.branch
    },

    watchedUrls() {
      return watch.watchedKeys()
    },

    async flush() {
      for (let pass = 0; pass < 8; pass += 1) {
        const pending: Promise<unknown>[] = []
        for (const state of repos.values()) {
          if (state.loading) pending.push(state.loading)
          pending.push(state.writes)
        }
        pending.push(...lookupsInFlight.values(), ...refreshesInFlight.values(), ...repoKeyReads.values())
        await Promise.allSettled(pending)
        if (lookupsInFlight.size === 0 && refreshesInFlight.size === 0 && repoKeyReads.size === 0) {
          // One more pass over the write chains, which the last commit extended.
          await Promise.allSettled([...repos.values()].map((state) => state.writes))
          return
        }
      }
    },

    dispose() {
      disposed = true
      watch.dispose()
      held.clear()
      lookupsInFlight.clear()
      refreshesInFlight.clear()
      repoKeyReads.clear()
    },
  }
}

/** The repository a checkout is a clone of, through the app's one identity reader. */
async function defaultResolveRepoKey(gitRoot: string): Promise<string | null> {
  const read = await readRepositoryIdentityRead(gitRoot)
  // An unsettled read is "could not ask": no key, and the next ask asks again.
  return read.settled ? read.identity?.canonicalKey ?? null : null
}

function normalizeCheckout(input: PullRequestCheckout): PullRequestCheckout | null {
  const gitRoot = input?.gitRoot?.trim()
  const branch = input?.branch?.trim()
  return gitRoot && branch ? { gitRoot, branch } : null
}

function groupByRepo(entries: readonly BranchPullRequest[]): Map<string, BranchPullRequest[]> {
  const grouped = new Map<string, BranchPullRequest[]>()
  for (const entry of entries) {
    const list = grouped.get(entry.repoKey) ?? []
    list.push(entry)
    grouped.set(entry.repoKey, list)
  }
  return grouped
}

function sameList(a: readonly BranchPullRequest[], b: readonly BranchPullRequest[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => sameEntry(entry, b[index]))
}

function sameEntry(a: BranchPullRequest, b: BranchPullRequest): boolean {
  return (
    a.url === b.url
    && a.repoKey === b.repoKey
    && a.repoName === b.repoName
    && a.number === b.number
    && a.title === b.title
    && a.state === b.state
    && a.isDraft === b.isDraft
    && a.openedAt === b.openedAt
    && a.stateAt === b.stateAt
    && a.openedBySessionId === b.openedBySessionId
  )
}

/** A number from a canonical pull request URL, for an entry recorded before GitHub was asked. */
function numberFromUrl(url: string): number {
  const match = /\/pull\/(\d+)/.exec(url)
  return match ? Number(match[1]) : 0
}

function parseStoreFile(raw: string): Map<string, BranchPullRequest[]> {
  const branches = new Map<string, BranchPullRequest[]>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return branches
  }
  if (!isRecord(parsed) || !isRecord(parsed.branches)) return branches
  for (const [branch, value] of Object.entries(parsed.branches)) {
    if (!Array.isArray(value)) continue
    const entries = value.map(parseEntry).filter((entry): entry is BranchPullRequest => entry !== null)
    if (entries.length > 0) branches.set(branch, entries)
  }
  return branches
}

// The file survives restarts and a person can edit it, so it is read as
// untrusted: a row that is not a well-formed pull request is dropped rather
// than smuggled into a mark.
function parseEntry(raw: unknown): BranchPullRequest | null {
  if (!isRecord(raw)) return null
  const url = typeof raw.url === 'string' ? canonicalPullRequestUrlOf(raw.url.trim()) : null
  if (!url) return null
  const repository = pullRequestRepository(url)
  if (!repository) return null
  const state = raw.state
  if (state !== 'open' && state !== 'merged' && state !== 'closed') return null
  const number = typeof raw.number === 'number' && Number.isInteger(raw.number) && raw.number >= 0 ? raw.number : 0
  const openedAt = typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt) ? raw.openedAt : 0
  const stateAt = typeof raw.stateAt === 'number' && Number.isFinite(raw.stateAt) ? raw.stateAt : 0
  return {
    url,
    // Re-derived from the URL rather than trusted: the key is what files a pull
    // request, and a mangled one would file it under a repository it is not in.
    repoKey: repository.repoKey,
    repoName: repository.repoName,
    number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state,
    isDraft: raw.isDraft === true && state === 'open',
    openedAt,
    stateAt,
    ...(typeof raw.openedBySessionId === 'string' && raw.openedBySessionId
      ? { openedBySessionId: raw.openedBySessionId }
      : {}),
  }
}

async function writeStoreFile(userDataDir: string, repoKey: string, file: StoreFile): Promise<void> {
  const finalPath = pullRequestStorePath(userDataDir, repoKey)
  const tempPath = `${finalPath}.${randomUUID()}.tmp`
  await mkdir(join(userDataDir, STORE_DIR), { recursive: true })
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}
