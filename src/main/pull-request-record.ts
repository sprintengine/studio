// The pull request record: which pull requests a checkout's branch has, and
// what state each is in (epic `pull-request-marks`, decisions 3, 5, 9, 10).
// This is the OWNER of that fact — the sidebar mark, the peek's split control
// and the tooltip all read what is written here, and nothing else may decide it.
//
// KEYED BY CHECKOUT + BRANCH, and the checkout is the session's observed
// `gitRoot` — NEVER `observedCheckout.repoRoot`, which for a linked worktree is
// the primary checkout that owns the common git dir. `agent-changelist-feed.ts`
// explains the same rule at length for the ±lines ledger: an agent working in
// `…/worktrees/feature` would otherwise have its pull requests filed against the
// main repository, alongside another agent's, on a branch that repository is not
// even on. One conversation, one branch, one row of marks.
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

import type { BranchPullRequest, PullRequestState } from '../shared/git/pull-request'
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

const STORE_DIR = 'pull-requests'
const STORE_VERSION = 1

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

export type PullRequestRecordKeyParts = { gitRoot: string; branch: string }

export type PullRequestRecordOptions = {
  userDataDir: string
  /** The two GitHub reads, injected so tests never spawn `gh`. */
  reads?: {
    listBranchPullRequests?: typeof listBranchPullRequestsDefault
    readPullRequestState?: typeof readPullRequestStateDefault
  }
  /** Live sessions, for the hover and window-focus refreshes. */
  sessions?: {
    get(sessionId: string): PullRequestRecordSession | null
    list(): readonly PullRequestRecordSession[]
  }
  /**
   * A key's list changed. The app turns it into a re-emit of the terminal
   * session snapshots for the sessions on that key.
   */
  onRecordChanged?: (input: PullRequestRecordKeyParts & { key: string }) => void
  now?: () => number
  timers?: WatchPollerTimers
  random?: () => number
  logWarning?: (message: string, error: unknown) => void
}

export type PullRequestRecord = {
  /**
   * This checkout+branch's pull requests, newest first. Synchronous, because
   * the terminal snapshot is built from it on every broadcast. The stored array
   * is never mutated in place — a change replaces it — so a snapshot may hold
   * the same reference safely.
   */
  listFor(input: PullRequestRecordKeyParts): BranchPullRequest[]
  /** The same, for a session — empty when its checkout is not resolved yet. */
  listForSession(session: PullRequestRecordSession | null | undefined): BranchPullRequest[]
  /** Hook capture (the next item): a pull request this session just opened. */
  noteCaptured(input: PullRequestRecordKeyParts & { url: string; sessionId?: string }): void
  /** One `gh pr list` per key per hold, merged in. Unsettled reads change nothing. */
  ensureLookedUp(input: PullRequestRecordKeyParts): Promise<void>
  /** Re-read one pull request's state by URL. Unsettled leaves the last reading standing. */
  refresh(url: string): Promise<void>
  /** The hover hook: look this session's branch up, and refresh readings older than ~60s. */
  refreshForSession(sessionId: string): void
  /** Window focus: the same, for every live session. */
  refreshOnFocus(): void
  /** URLs holding a live watch timer. Introspection for diagnostics and tests. */
  watchedUrls(): string[]
  /** Settle every load, write and read in flight. The tests' synchronisation point. */
  flush(): Promise<void>
  dispose(): void
}

/**
 * The store's key for a checkout and a branch. The path half is normalised the
 * way every other checkout key in the app is (`normalizeComparablePath`, so a
 * trailing slash or a Windows drive's case is not a second key); the branch is
 * verbatim, because git's refs are case-sensitive. The separator is a NUL,
 * which neither a path nor a ref name may contain.
 */
export function pullRequestRecordKey(gitRoot: string, branch: string): string {
  return `${normalizeComparablePath(gitRoot)}\u0000${branch}`
}

/**
 * The checkout and branch a session's pull requests belong to, or null when
 * there is none to name yet. The observed checkout only — launch intent says
 * where the app PUT an agent, not where it is, and a mark filed against the
 * wrong checkout is worse than a mark that appears a moment later.
 */
export function pullRequestSessionKey(
  session: PullRequestRecordSession | null | undefined,
): PullRequestRecordKeyParts | null {
  const observed = session?.observedCheckout
  if (!observed?.resolved) return null
  const gitRoot = observed.gitRoot?.trim()
  const branch = observed.branch?.trim()
  // A detached HEAD has no branch to look a pull request up by.
  if (!gitRoot || !branch) return null
  return { gitRoot, branch }
}

/** The file one checkout's branches live in. Same scheme as `git-changelists.ts`. */
export function pullRequestStorePath(userDataDir: string, gitRoot: string): string {
  const comparable = normalizeComparablePath(gitRoot)
  const hash = createHash('sha1').update(comparable).digest('hex').slice(0, 16)
  const name = comparable.split('/').filter(Boolean).pop() ?? 'repo'
  const slug = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'
  return join(userDataDir, STORE_DIR, `${slug}-${hash}.json`)
}

type StoreFile = {
  version: number
  gitRoot: string
  branches: Record<string, BranchPullRequest[]>
}

type RootState = {
  gitRoot: string
  branches: Map<string, BranchPullRequest[]>
  loaded: boolean
  loading: Promise<void> | null
  writes: Promise<unknown>
}

type Hold = { at: number; settled: boolean }

export function createPullRequestRecord(options: PullRequestRecordOptions): PullRequestRecord {
  const now = options.now ?? (() => Date.now())
  const listBranch = options.reads?.listBranchPullRequests ?? listBranchPullRequestsDefault
  const readState = options.reads?.readPullRequestState ?? readPullRequestStateDefault
  const warn =
    options.logWarning
    ?? ((message: string, error: unknown) => console.warn(`[pull-request-record] ${message}`, error))

  const roots = new Map<string, RootState>()
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

  function rootStateFor(gitRoot: string): RootState {
    const key = normalizeComparablePath(gitRoot)
    const existing = roots.get(key)
    if (existing) return existing
    const state: RootState = { gitRoot, branches: new Map(), loaded: false, loading: null, writes: Promise.resolve() }
    roots.set(key, state)
    return state
  }

  function load(state: RootState): Promise<void> {
    if (state.loaded) return Promise.resolve()
    if (state.loading) return state.loading
    const loading = (async () => {
      let raw: string | null = null
      try {
        raw = await readFile(pullRequestStorePath(options.userDataDir, state.gitRoot), 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          // A store we cannot read starts over rather than taking the marks
          // down; the next lookup refills it from GitHub.
          warn('could not read a stored pull request record', error)
        }
      }
      if (disposed) return
      const branches = raw === null ? new Map<string, BranchPullRequest[]>() : parseStoreFile(raw)
      // Anything written while the read was in flight wins: it came from a live
      // read of GitHub, the file did not.
      for (const [branch, entries] of branches) {
        if (!state.branches.has(branch)) state.branches.set(branch, entries)
      }
      state.loaded = true
      state.loading = null
      for (const branch of state.branches.keys()) {
        reconcileWatch(state, branch)
        emitChanged(state.gitRoot, branch)
      }
    })()
    state.loading = loading
    return loading
  }

  function persist(state: RootState): void {
    const snapshot: StoreFile = {
      version: STORE_VERSION,
      gitRoot: state.gitRoot,
      branches: Object.fromEntries(state.branches),
    }
    // One writer per checkout, chained: two branches settling a frame apart must
    // not both read-modify-write the same file.
    state.writes = state.writes.then(
      () => writeStoreFile(options.userDataDir, state.gitRoot, snapshot).catch((error) => {
        warn('could not write a pull request record', error)
      }),
      () => undefined,
    )
  }

  function emitChanged(gitRoot: string, branch: string): void {
    if (!options.onRecordChanged || disposed) return
    try {
      options.onRecordChanged({ gitRoot, branch, key: pullRequestRecordKey(gitRoot, branch) })
    } catch (error) {
      warn('a pull request record listener failed', error)
    }
  }

  function entriesOf(state: RootState, branch: string): BranchPullRequest[] {
    return state.branches.get(branch) ?? []
  }

  /**
   * Replace a branch's list, newest first. Writes, re-emits and reconciles the
   * watch only when something actually changed — a focus refresh that learned
   * nothing must not repaint every window.
   */
  function commit(state: RootState, branch: string, next: BranchPullRequest[]): void {
    const sorted = [...next].sort((a, b) => b.openedAt - a.openedAt || b.number - a.number)
    if (sameList(entriesOf(state, branch), sorted)) return
    state.branches.set(branch, sorted)
    persist(state)
    reconcileWatch(state, branch)
    emitChanged(state.gitRoot, branch)
  }

  function isUrlWatchable(url: string): boolean {
    for (const state of roots.values()) {
      for (const entries of state.branches.values()) {
        for (const entry of entries) {
          if (entry.url !== url) continue
          // The one rule, shared with the sprint run watch: merged and closed
          // are terminal and stop for good; open is the live case.
          if (isPullRequestWatchable({ hasVcs: true, prState: entry.state, hasPrUrl: true })) return true
        }
      }
    }
    return false
  }

  function reconcileWatch(state: RootState, branch: string): void {
    for (const entry of entriesOf(state, branch)) {
      if (isPullRequestWatchable({ hasVcs: true, prState: entry.state, hasPrUrl: true })) watch.arm(entry.url)
      else if (!isUrlWatchable(entry.url)) watch.disarm(entry.url)
    }
  }

  /** Apply a settled state reading to every branch of every checkout carrying that URL. */
  function applyState(url: string, state: PullRequestState, isDraft: boolean, stateAt: number): void {
    for (const root of roots.values()) {
      for (const [branch, entries] of [...root.branches]) {
        if (!entries.some((entry) => entry.url === url)) continue
        commit(
          root,
          branch,
          entries.map((entry) => (entry.url === url ? { ...entry, state, isDraft, stateAt } : entry)),
        )
      }
    }
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
      applyState(url, outcome.state, outcome.isDraft, outcome.stateAt)
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

  async function ensureLookedUp(input: PullRequestRecordKeyParts): Promise<void> {
    if (disposed) return
    const parts = normalizeParts(input)
    if (!parts) return
    const key = pullRequestRecordKey(parts.gitRoot, parts.branch)
    const hold = held.get(key)
    if (hold && now() - hold.at < LOOKUP_HOLD_MS) return
    const inFlight = lookupsInFlight.get(key)
    if (inFlight) return inFlight

    const lookup = (async () => {
      const state = rootStateFor(parts.gitRoot)
      await load(state)
      if (disposed) return
      const read = await listBranch({ gitRoot: parts.gitRoot, branch: parts.branch }, { now })
      if (disposed) return
      if (!read.settled) {
        // Could not ask. The record is left exactly as it was, and the hold is
        // dated into the past so the next ask really asks.
        held.set(key, { at: now() - LOOKUP_HOLD_MS + LOOKUP_RETRY_AFTER_FAILURE_MS, settled: false })
        return
      }
      held.set(key, { at: now(), settled: true })
      commit(state, parts.branch, mergeByUrl(entriesOf(state, parts.branch), read.pullRequests))
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

  /** The stale readings on a key, refreshed. Each URL's refresh coalesces itself. */
  function refreshStale(parts: PullRequestRecordKeyParts): void {
    const state = rootStateFor(parts.gitRoot)
    const cutoff = now() - HOVER_REFRESH_STALE_MS
    for (const entry of entriesOf(state, parts.branch)) {
      // Merged and closed are terminal: there is nothing left to learn.
      if (entry.state !== 'open') continue
      if (entry.stateAt > cutoff) continue
      void refresh(entry.url)
    }
  }

  function refreshKey(parts: PullRequestRecordKeyParts): void {
    void ensureLookedUp(parts).then(() => {
      if (!disposed) refreshStale(parts)
    })
  }

  function listFor(input: PullRequestRecordKeyParts): BranchPullRequest[] {
    const parts = normalizeParts(input)
    if (!parts) return []
    const state = rootStateFor(parts.gitRoot)
    // First ask about this checkout: read the file, and re-emit when it lands.
    // Until then the honest answer is "nothing known", never a guess.
    if (!state.loaded) void load(state)
    return entriesOf(state, parts.branch)
  }

  return {
    listFor,

    listForSession(session) {
      const parts = pullRequestSessionKey(session)
      return parts ? listFor(parts) : []
    },

    noteCaptured(input) {
      const parts = normalizeParts(input)
      const url = input.url?.trim()
      if (!parts || !url || disposed) return
      void (async () => {
        const state = rootStateFor(parts.gitRoot)
        await load(state)
        if (disposed) return
        const entries = entriesOf(state, parts.branch)
        if (entries.some((entry) => entry.url === url)) return
        const at = now()
        // A pull request the app just watched being created is open the moment
        // it exists (decision 3). Its number comes off the URL and its title
        // arrives with the next branch lookup — a state read answers state and
        // draftness only — so the mark can be drawn before either lands.
        commit(state, parts.branch, [
          ...entries,
          {
            url,
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
      const parts = pullRequestSessionKey(session)
      if (!parts || disposed) return
      refreshKey(parts)
    },

    refreshOnFocus() {
      if (disposed) return
      const seen = new Set<string>()
      for (const session of options.sessions?.list() ?? []) {
        const parts = pullRequestSessionKey(session)
        if (!parts) continue
        const key = pullRequestRecordKey(parts.gitRoot, parts.branch)
        if (seen.has(key)) continue
        seen.add(key)
        refreshKey(parts)
      }
    },

    watchedUrls() {
      return watch.watchedKeys()
    },

    async flush() {
      for (let pass = 0; pass < 8; pass += 1) {
        const pending: Promise<unknown>[] = []
        for (const state of roots.values()) {
          if (state.loading) pending.push(state.loading)
          pending.push(state.writes)
        }
        pending.push(...lookupsInFlight.values(), ...refreshesInFlight.values())
        await Promise.allSettled(pending)
        if (lookupsInFlight.size === 0 && refreshesInFlight.size === 0) {
          // One more pass over the write chains, which the last commit extended.
          await Promise.allSettled([...roots.values()].map((state) => state.writes))
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
    },
  }
}

function normalizeParts(input: PullRequestRecordKeyParts): PullRequestRecordKeyParts | null {
  const gitRoot = input?.gitRoot?.trim()
  const branch = input?.branch?.trim()
  return gitRoot && branch ? { gitRoot, branch } : null
}

/**
 * GitHub's answer merged onto what we hold, by URL. A captured entry's
 * `openedBySessionId` is the one field a lookup can NEVER supply, so it is the
 * one field the merge preserves — losing it would unfile a conversation's own
 * pull request from the conversation. Entries GitHub did not mention are kept
 * (decision 6: earlier pull requests are never dropped).
 */
function mergeByUrl(
  existing: readonly BranchPullRequest[],
  incoming: readonly BranchPullRequest[],
): BranchPullRequest[] {
  const merged = new Map<string, BranchPullRequest>()
  for (const entry of existing) merged.set(entry.url, entry)
  for (const entry of incoming) {
    const previous = merged.get(entry.url)
    merged.set(
      entry.url,
      previous?.openedBySessionId ? { ...entry, openedBySessionId: previous.openedBySessionId } : entry,
    )
  }
  return [...merged.values()]
}

function sameList(a: readonly BranchPullRequest[], b: readonly BranchPullRequest[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => sameEntry(entry, b[index]))
}

function sameEntry(a: BranchPullRequest, b: BranchPullRequest): boolean {
  return (
    a.url === b.url
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
    if (!branch || !Array.isArray(value)) continue
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
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url) return null
  const state = raw.state
  if (state !== 'open' && state !== 'merged' && state !== 'closed') return null
  const number = typeof raw.number === 'number' && Number.isInteger(raw.number) && raw.number >= 0 ? raw.number : 0
  const openedAt = typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt) ? raw.openedAt : 0
  const stateAt = typeof raw.stateAt === 'number' && Number.isFinite(raw.stateAt) ? raw.stateAt : 0
  return {
    url,
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

async function writeStoreFile(userDataDir: string, gitRoot: string, file: StoreFile): Promise<void> {
  const finalPath = pullRequestStorePath(userDataDir, gitRoot)
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
