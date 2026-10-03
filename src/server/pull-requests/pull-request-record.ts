// The pull request record: which pull requests a conversation has, and what
// state each is in (epic `pull-request-marks`, decisions 3, 5, 9, 10). This is
// the OWNER of that fact — the sidebar mark, the peek's split control and the
// tooltip all read what is written here, through the Studio protocol, and
// nothing else may decide it. It is a server domain: the Studio server builds
// it with its core, in process and out of process alike, and every client
// displays what it answers (owner ruling 2026-10-03).
//
// ONE SOURCE: THE BRANCH LOOKUP (owner ruling 2026-10-03). A mark comes only
// from asking the host "is there a pull request for this branch?" — `gh pr
// list --head <branch>` in a checkout. Nothing here reads a command an agent
// ran or a URL out of a tool's output: a capture can only ever see the pull
// requests an agent opened the way the reader expected, and two readers (a
// hook script and a stream parser) disagreed about what that was.
//
// KEYED BY REPOSITORY, NOT BY CHECKOUT. A pull request belongs to a repository
// (`host/owner/name`, the key every clone of it shares — the same
// `canonicalRepositoryKey` the sidebar groups folders by) and a branch. A
// lookup's rows carry their own URL, and the URL says which repository; that
// is what we key on.
//
// A CONVERSATION'S MARKS ARE THE BRANCHES IT WORKED ON. A conversation (a
// workspace and an agent in it, chat or terminal) is told where it did work:
// its own checkout at each turn end, and the checkout of every other
// repository it changed files in (`noteCheckout`). Each of those is a TOUCH,
// remembered with the repository keys its lookup answered under, and the
// conversation wears the union of the pull requests on its touches'
// branches, de-duplicated by URL and newest first. The touch on its OWN
// checkout is its home: only the pull requests there are stamped
// `onSessionBranch`, the one reading the sidebar's "landed" diff may trust.
// Touches are written down (`conversations.json` beside the repositories),
// so a finished chat keeps its marks across a restart, and a pull request
// opened in another repository is visible because that repository was
// touched.
//
// RECORDS WRITTEN BEFORE THE LOOKUP-ONLY RULE stay readable. An entry captured
// from a hook carries `openedBySessionId` and `openedByWorkspaceId`, and may
// still sit in the not-yet-known-branch bucket. Those entries load, are
// watched, learn their branch from their first state read, and are worn by
// their conversation (`forWorkspace`) and by a terminal session that names
// itself (`noteCheckout`'s `sessionId`). Nothing writes new ones.
//
// WHAT MAY BE WRITTEN DOWN. Only a SETTLED read (see
// `github/branch-pull-request.ts`). "This branch has no pull request" is an
// answer and it is recorded; "I could not ask" changes nothing at all — a mark
// must never blink out because a laptop was offline for one probe, or because
// a server has no `gh`. And state comes only from GitHub: there is no ancestry
// inference anywhere in this file, because a squash merge or a rebase would
// make it lie for ever (decision 8c).
//
// ONE LOOKUP PER CHECKOUT AT A TIME. A lookup of a checkout and branch waits
// for the one in flight before it starts, so an older answer can never land
// over a newer one; and a turn end asks for a lookup that STARTED after it,
// so a pull request opened during that turn is never answered from a read
// made before it existed.
//
// A LOOKUP'S ANSWER IS READ BACK BY THE CHECKOUT THAT ASKED. A row is filed
// under the repository ITS OWN URL names, which is not always the key the
// asking checkout resolves to: an SSH host alias (`git@github-work:acme/app`)
// keys as `github-work/acme/app`, a fork's `gh pr list` answers for the parent,
// and a transferred repository answers under its new name. So every checkout
// also remembers WHICH repository keys its lookups came back under, and a
// touch reads the union of those and its own.
//
// THE WATCH IS BOUNDED (decision 9's schedule, not its scope). Only a pull
// request opened inside `PR_WATCH_BOOT_SCAN_MAX_AGE_MS` holds a timer — a
// 30-day window.
//
// EARLIER PULL REQUESTS ARE NEVER DROPPED (decision 6). A lookup merges by URL
// and adds; it never deletes. A pull request that scrolled out of `gh pr list`
// (a branch reused for a second one, a repository transferred) stays on the
// record with the state it last had.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  canonicalPullRequestUrlOf,
  pullRequestRepository,
  unionPullRequests,
  type BranchPullRequest,
  type PullRequestState,
} from '../../shared/git/pull-request'
import { isRecord } from '../../shared/records'
import {
  listBranchPullRequests as listBranchPullRequestsDefault,
  readPullRequestState as readPullRequestStateDefault,
} from '../../main/github/branch-pull-request'
import {
  createPullRequestWatchPoller,
  PR_WATCH_BOOT_SCAN_MAX_AGE_MS,
  type WatchPollerTimers,
} from '../../main/github/pull-request-watch-poller'
import { normalizeComparablePath } from '../../main/git-utils'
import { readRepositoryIdentityRead } from '../../main/repository-identity'

const STORE_DIR = 'pull-requests'
const STORE_VERSION = 1
/** Which conversations worked where. No repository is ever keyed by this name: theirs are `<slug>-<hash>.json`. */
const CONVERSATIONS_FILE = 'conversations.json'
const CONVERSATIONS_VERSION = 1
/** How long the conversations file waits for more notes before it is written. */
const CONVERSATIONS_WRITE_DELAY_MS = 1_000

/** The bucket a legacy captured pull request sits in until GitHub names its branch. A ref name is never empty. */
const UNKNOWN_BRANCH = ''

/**
 * How long a settled branch lookup is held before another `gh pr list` is worth
 * making for a hover, a focus or a poll, and how long an UNSETTLED one is held
 * before the next ask really asks (a failure must not be cached for the full
 * minute, and must not be retried on every hover either).
 */
export const LOOKUP_HOLD_MS = 60_000
export const LOOKUP_RETRY_AFTER_FAILURE_MS = 10_000

/**
 * The fewest milliseconds between two lookups of one checkout that a turn end
 * asks for. A turn end is never refused — the pull request it may have opened
 * is the point — but a burst of them (several agents in one checkout, a
 * terminal agent's quick turns) is folded into one lookup made this long
 * after the last one started, so a busy fleet does not spend GitHub's rate
 * limit a turn at a time.
 */
export const FORCED_LOOKUP_MIN_INTERVAL_MS = 15_000

/**
 * How long every read is skipped once `gh` turned out not to be installed. A
 * server on a machine with no `gh` (a fresh remote box) has no marks, and
 * says nothing about it; this keeps it from spawning a doomed process on every
 * turn end to learn that again.
 */
export const GH_MISSING_HOLD_MS = 5 * 60_000

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

/**
 * The most checkouts one conversation remembers working in. An agent that
 * wanders through more repositories than this keeps the most recent ones and
 * its own checkout; the pull requests it already holds stay on the record.
 */
export const MAX_TOUCHES_PER_CONVERSATION = 12

/** The most conversations remembered; the least recently active go first. */
export const MAX_CONVERSATIONS = 2_000

/** The most terminal sessions a conversation is known by, for the entries legacy captures filed under them. */
const MAX_SESSION_ALIASES = 1_000

/** A `<name>.<uuid>.tmp` left by a write that died must be older than this before it is swept. */
const TEMP_FILE_SWEEP_MIN_AGE_MS = 60 * 60 * 1000

/** A conversation: a workspace and one agent in it. */
export type PullRequestConversationKey = { workspaceId: string; agentId: string }

/** A checkout and the branch it is on. */
export type PullRequestCheckout = { gitRoot: string; branch: string }

/**
 * One list changed. `branch` is the branch whose list moved — `null` when the
 * change is "anything in this repository", and the empty string for the
 * not-yet-known-branch bucket. `workspaceIds` and `conversations` are the
 * readers the change reaches, which is how a client knows what to ask again.
 */
export type PullRequestRecordChange = {
  repoKey: string | null
  branch: string | null
  workspaceIds: string[]
  conversations: PullRequestConversationKey[]
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
  /** A list changed; see `PullRequestRecordChange`. */
  onRecordChanged?: (change: PullRequestRecordChange) => void
  /** Read every stored repository, and the conversations, at start rather than on first use. */
  loadStoredOnStart?: boolean
  now?: () => number
  timers?: WatchPollerTimers
  random?: () => number
  logWarning?: (message: string, error: unknown) => void
}

export type PullRequestRecord = {
  /** One repository and branch's pull requests, newest first. */
  forBranch(repoKey: string, branch: string): BranchPullRequest[]
  /**
   * What a conversation wears: the pull requests on every branch it worked
   * on, plus the legacy ones a session it was known by captured, de-duplicated
   * by URL and newest first; those on its own checkout's branch stamped
   * `onSessionBranch`. Synchronous; the stored arrays are never mutated.
   */
  forConversation(key: PullRequestConversationKey): BranchPullRequest[]
  /**
   * What a sidebar row wears: every conversation in the workspace, and every
   * legacy entry filed under it, outliving every agent in it. Nothing is
   * filtered by state: a merged pull request stays on its row as merged.
   */
  forWorkspace(workspaceId: string): BranchPullRequest[]
  /**
   * The conversation did work in this checkout. Remembered, then looked up:
   * `force` (a turn end) asks for a lookup that started after this call;
   * otherwise a held answer is enough. `home` marks the conversation's own
   * checkout. `sessionId` names a terminal session the conversation runs as,
   * for the entries a legacy capture filed under it. Resolves once the
   * lookup has settled or been skipped.
   */
  noteCheckout(
    key: PullRequestConversationKey,
    checkout: PullRequestCheckout,
    options?: { force?: boolean; home?: boolean; sessionId?: string },
  ): Promise<void>
  /**
   * The conversation runs as this terminal session, for the entries a legacy
   * capture filed under it, without noting a checkout: an agent on its
   * repository's default branch, which is never looked up, still wears them.
   */
  nameSession(key: PullRequestConversationKey, sessionId: string): void
  /** The conversation's own checkout, as last noted. */
  homeOf(key: PullRequestConversationKey): PullRequestCheckout | null
  /** One `gh pr list` per checkout+branch per hold, merged in. Unsettled reads change nothing. */
  ensureLookedUp(input: PullRequestCheckout, options?: { force?: boolean }): Promise<void>
  /** Re-read one pull request's state by URL. Unsettled leaves the last reading standing. */
  refresh(url: string): Promise<void>
  /**
   * Look a conversation's branches up again (held) and re-read its stale
   * readings. Returns whether there was anything to ask about.
   */
  refreshConversation(key: PullRequestConversationKey): boolean
  /** The same, for every conversation in a workspace and its legacy entries. */
  refreshWorkspace(workspaceId: string): boolean
  /** Every stale open pull request on the record, re-read: what a window coming back to the front asks. */
  refreshOutstanding(): void
  /** The conversations that noted a checkout at or after `since`, most recent first. */
  conversationsActiveSince(since: number): PullRequestConversationKey[]
  /** Resolves once what was stored has been read: a list asked for before then would be empty. */
  whenLoaded(): Promise<void>
  /** URLs holding a live watch timer. Introspection for diagnostics and tests. */
  watchedUrls(): string[]
  /** Settle every load, write and read in flight. The tests' synchronisation point, and the quit's. */
  flush(): Promise<void>
  dispose(): void
}

/** The file one repository's branches live in. Same scheme as `git-changelists.ts`. */
export function pullRequestStorePath(userDataDir: string, repoKey: string): string {
  const hash = createHash('sha1').update(repoKey).digest('hex').slice(0, 16)
  const name = repoKey.split('/').filter(Boolean).pop() ?? 'repo'
  const slug =
    name
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'repo'
  return join(userDataDir, STORE_DIR, `${slug}-${hash}.json`)
}

/** The file the conversations' touches live in. */
export function pullRequestConversationsPath(userDataDir: string): string {
  return join(userDataDir, STORE_DIR, CONVERSATIONS_FILE)
}

type StoreFile = {
  version: number
  repoKey: string
  branches: Record<string, BranchPullRequest[]>
}

type RepoState = {
  repoKey: string
  /** Branch → its pull requests, newest first. `UNKNOWN_BRANCH` holds legacy captures GitHub has not placed yet. */
  branches: Map<string, BranchPullRequest[]>
  loaded: boolean
  loading: Promise<void> | null
  writes: Promise<unknown>
}

type Located = { repoKey: string; branch: string; entry: BranchPullRequest }

/**
 * What is known about the last lookup of one checkout and branch. `startedAt`
 * is when it asked (a turn end needs an answer asked after it); `retryAt` is
 * when a hover, focus or poll may ask again.
 */
type Hold = { startedAt: number; settled: boolean; retryAt: number }

/** A checkout a conversation worked in, with the repository keys its lookups answered under. */
type Touch = { gitRoot: string; branch: string; repoKeys: string[]; at: number }

type ConversationTouches = {
  workspaceId: string
  agentId: string
  /** Newest first. */
  touches: Touch[]
  /** `touchId` of the conversation's own checkout, if it has noted one. */
  home: string | null
  /** When the conversation last noted a checkout. */
  at: number
}

type InFlightLookup = { startedAt: number; promise: Promise<void> }

export function createPullRequestRecord(options: PullRequestRecordOptions): PullRequestRecord {
  const now = options.now ?? (() => Date.now())
  const listBranch = options.reads?.listBranchPullRequests ?? listBranchPullRequestsDefault
  const readState = options.reads?.readPullRequestState ?? readPullRequestStateDefault
  const resolveRepoKey = options.resolveRepoKey ?? defaultResolveRepoKey
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

  const repos = new Map<string, RepoState>()
  /** Every entry, by URL — the index behind every relocation and every legacy read. */
  const located = new Map<string, Located>()
  /** Legacy: session → the URLs a hook capture filed under it. Rebuilt from `openedBySessionId` on load. */
  const bySession = new Map<string, Set<string>>()
  /** Legacy: workspace → the URLs a capture filed under it. Rebuilt from `openedByWorkspaceId` on load. */
  const byWorkspace = new Map<string, Set<string>>()
  /** Conversation → the checkouts it worked in. Written to `conversations.json`. */
  const conversations = new Map<string, ConversationTouches>()
  /** Terminal session → the conversation it runs as. Not stored: a session names itself on every turn. */
  const sessionAliases = new Map<string, string>()
  /** The same, the other way round. */
  const aliasesByConversation = new Map<string, Set<string>>()
  function aliasSession(sessionId: string, conversation: string): void {
    const previous = sessionAliases.get(sessionId)
    if (previous !== undefined) aliasesByConversation.get(previous)?.delete(sessionId)
    sessionAliases.delete(sessionId)
    sessionAliases.set(sessionId, conversation)
    addTo(aliasesByConversation, conversation, sessionId)
    while (sessionAliases.size > MAX_SESSION_ALIASES) {
      const [oldest, owner] = sessionAliases.entries().next().value!
      sessionAliases.delete(oldest)
      aliasesByConversation.get(owner)?.delete(oldest)
    }
  }
  /** A checkout's repository, once git has answered. Only settled answers are kept. */
  const repoKeyByCheckout = new Map<string, string>()
  /**
   * The repository keys a checkout's OWN lookups came back under — usually
   * the one key above; a host alias, a fork or a transferred repository make
   * it a different one (see the header).
   */
  const lookupRepoKeys = new Map<string, Set<string>>()
  const repoKeyReads = new Map<string, Promise<string | null>>()
  const held = new Map<string, Hold>()
  /** Per-URL hold on a state read, so an unsettled one is not re-spawned on every focus. */
  const refreshHolds = new Map<string, { at: number; settled: boolean }>()
  const lookupsInFlight = new Map<string, InFlightLookup>()
  /** A turn end's lookup waiting out `FORCED_LOOKUP_MIN_INTERVAL_MS`, one per checkout. */
  const deferredLookups = new Map<string, { promise: Promise<void>; handle: unknown; resolve: () => void }>()
  const refreshesInFlight = new Map<string, Promise<void>>()
  let ghMissingUntil = 0
  const sweepStaleTempFiles = createTempFileSweep(options.userDataDir)
  let storedLoad: Promise<void> | null = null
  let conversationsLoad: Promise<void> | null = null
  let conversationWrites: Promise<unknown> = Promise.resolve()
  let disposed = false

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
  function releaseWaitingReads(): void {
    while (waitingReads.length > 0) waitingReads.shift()?.()
  }

  /** Whether a read may be made at all: not disposed, and `gh` not known to be missing. */
  function mayAsk(): boolean {
    return !disposed && now() >= ghMissingUntil
  }
  function noteReadFailure(reason: string): void {
    if (reason === 'gh-missing') ghMissingUntil = now() + GH_MISSING_HOLD_MS
  }

  // Every pull request still OPEN is watched, each stopping on its own when it
  // lands, so a menu never shows a stale open one (decision 9).
  const watch = createPullRequestWatchPoller({
    isWatchable: (url) => isUrlWatchable(url),
    probe: (url) => refresh(url),
    timers,
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
      await sweepStaleTempFiles()
      const path = pullRequestStorePath(options.userDataDir, state.repoKey)
      let raw: string | null = null
      try {
        raw = await readFile(path, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          warn('could not read a stored pull request record', error)
        }
      }
      let stored = raw === null ? new Map<string, BranchPullRequest[]>() : parseStoreFile(raw)
      if (stored === null) {
        // Truncated, hand-edited, or written by a version this build does not
        // know: kept aside rather than overwritten by the next commit.
        warn(
          'a stored pull request record could not be understood; keeping it aside as .corrupt',
          new Error(`unreadable store for ${state.repoKey}`),
        )
        await rename(path, `${path}.corrupt`).catch((error) => {
          warn('could not keep an unreadable pull request record aside', error)
        })
        stored = new Map<string, BranchPullRequest[]>()
      }
      state.loaded = true
      state.loading = null
      if (disposed) return
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

  /**
   * Every repository on disk, loaded (owner, 2026-10-02): a chat whose agents
   * are gone wears its marks after a restart, and its open pull requests are
   * watched for a merge.
   */
  function loadStored(): Promise<void> {
    if (storedLoad) return storedLoad
    storedLoad = (async () => {
      const dir = join(options.userDataDir, STORE_DIR)
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (disposed) return
        if (!name.endsWith('.json') || name === CONVERSATIONS_FILE) continue
        const path = join(dir, name)
        let repoKey = ''
        try {
          const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
          if (isRecord(parsed) && typeof parsed.repoKey === 'string') repoKey = parsed.repoKey.trim()
        } catch {
          // Left for `load` to set aside, the first time its repository is asked about.
          continue
        }
        // Only a file at the path its own key names: one renamed by hand would
        // otherwise load under a key whose writes go to a different file.
        if (!repoKey || pullRequestStorePath(options.userDataDir, repoKey) !== path) continue
        await loadedRepo(repoKey)
      }
    })().catch((error) => warn('could not load the stored pull request records', error))
    return storedLoad
  }

  /** The conversations' touches, read once. A file this build cannot read starts over and is kept aside. */
  function loadConversations(): Promise<void> {
    if (conversationsLoad) return conversationsLoad
    conversationsLoad = (async () => {
      const path = pullRequestConversationsPath(options.userDataDir)
      let raw: string
      try {
        raw = await readFile(path, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          warn('could not read which conversations worked where', error)
        }
        return
      }
      const parsed = parseConversationsFile(raw)
      if (parsed === null) {
        warn(
          'the stored conversations could not be understood; keeping the file aside as .corrupt',
          new Error('unreadable conversations store'),
        )
        await rename(path, `${path}.corrupt`).catch(() => undefined)
        return
      }
      if (disposed) return
      for (const conversation of parsed) {
        const id = conversationId(conversation)
        // Anything noted while the file was being read is newer.
        if (!conversations.has(id)) conversations.set(id, conversation)
      }
      // The repositories those touches read from, so their lists are there to wear.
      const keys = new Set<string>()
      for (const conversation of conversations.values())
        for (const touch of conversation.touches) for (const key of touch.repoKeys) keys.add(key)
      for (const key of keys) await loadedRepo(key)
    })().catch((error) => warn('could not load which conversations worked where', error))
    return conversationsLoad
  }

  function persist(state: RepoState): void {
    const snapshot: StoreFile = {
      version: STORE_VERSION,
      repoKey: state.repoKey,
      branches: Object.fromEntries(state.branches),
    }
    // One writer per repository, chained.
    state.writes = state.writes.then(
      () =>
        writeJsonFile(options.userDataDir, pullRequestStorePath(options.userDataDir, state.repoKey), snapshot).catch(
          (error) => {
            warn('could not write a pull request record', error)
          },
        ),
      () => undefined,
    )
  }

  /**
   * Written a moment after the last note rather than on every one: a terminal
   * agent notes where it is on each directory it moves through, and the file
   * would otherwise be rewritten per tool call. A flush writes at once.
   */
  let conversationsWriteTimer: ReturnType<typeof setTimeout> | null = null
  function persistConversations(): void {
    if (conversationsWriteTimer) return
    conversationsWriteTimer = setTimeout(writeConversationsNow, CONVERSATIONS_WRITE_DELAY_MS)
    conversationsWriteTimer.unref?.()
  }

  function writeConversationsNow(): void {
    if (conversationsWriteTimer) clearTimeout(conversationsWriteTimer)
    conversationsWriteTimer = null
    conversationWrites = conversationWrites.then(
      () =>
        writeJsonFile(options.userDataDir, pullRequestConversationsPath(options.userDataDir), {
          version: CONVERSATIONS_VERSION,
          conversations: [...conversations.values()],
        }).catch((error) => {
          warn('could not write which conversations worked where', error)
        }),
      () => undefined,
    )
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

  /**
   * One repository's list moved: everyone who reads it hears. That is every
   * conversation with a touch on that repository and branch, and every
   * conversation a legacy entry in it was filed under.
   */
  function emitChanged(repoKey: string, branch: string | null, lists: readonly (readonly BranchPullRequest[])[]): void {
    if (!options.onRecordChanged || disposed) return
    const workspaceIds = new Set<string>()
    const reached = new Map<string, PullRequestConversationKey>()
    for (const list of lists) {
      for (const entry of list) {
        if (entry.openedByWorkspaceId) workspaceIds.add(entry.openedByWorkspaceId)
        const alias = entry.openedBySessionId ? sessionAliases.get(entry.openedBySessionId) : undefined
        const conversation = alias ? conversations.get(alias) : undefined
        if (conversation) reached.set(alias!, keyOf(conversation))
      }
    }
    for (const [id, conversation] of conversations) {
      const touched = conversation.touches.some(
        (touch) => (branch === null || branch === touch.branch) && touchRepoKeys(touch).includes(repoKey),
      )
      if (touched) reached.set(id, keyOf(conversation))
    }
    for (const key of reached.values()) workspaceIds.add(key.workspaceId)
    emit({ repoKey, branch, workspaceIds: [...workspaceIds], conversations: [...reached.values()] })
  }

  function entriesOf(state: RepoState, branch: string): BranchPullRequest[] {
    return state.branches.get(branch) ?? []
  }

  /** Keep `located` and the legacy indexes in step with one list's replacement. */
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
      if (entry.openedByWorkspaceId) byWorkspace.get(entry.openedByWorkspaceId)?.delete(entry.url)
    }
    for (const entry of next) {
      located.set(entry.url, { repoKey, branch, entry })
      if (entry.openedBySessionId) addTo(bySession, entry.openedBySessionId, entry.url)
      if (entry.openedByWorkspaceId) addTo(byWorkspace, entry.openedByWorkspaceId, entry.url)
    }
  }

  /**
   * Replace a branch's list, newest first. Writes, re-emits and reconciles the
   * watch only when something actually changed — a refresh that learned
   * nothing must not repaint every window.
   */
  function commit(state: RepoState, branch: string, next: BranchPullRequest[]): void {
    const sorted = [...next].sort((a, b) => b.openedAt - a.openedAt || b.number - a.number)
    const previous = entriesOf(state, branch)
    if (sameList(previous, sorted, true)) return
    // A probe that learned nothing still moves `stateAt`, which is kept (it is
    // what stops the next refresh asking again, across a restart too) but is
    // not a repaint.
    const learnedSomething = !sameList(previous, sorted, false)
    state.branches.set(branch, sorted)
    indexList(state.repoKey, branch, previous, sorted)
    persist(state)
    if (!learnedSomething) return
    reconcileWatch(state, branch)
    emitChanged(state.repoKey, branch, [previous, sorted])
  }

  function isEntryWatchable(entry: BranchPullRequest): boolean {
    if (entry.state === 'merged' || entry.state === 'closed') return false
    if (!(entry.openedAt > 0)) return true
    return now() - entry.openedAt <= WATCH_MAX_AGE_MS
  }

  function isUrlWatchable(url: string): boolean {
    const at = located.get(url)
    if (!at) return false
    return isEntryWatchable(at.entry)
  }

  function reconcileWatch(state: RepoState, branch: string): void {
    for (const entry of entriesOf(state, branch)) {
      if (isEntryWatchable(entry)) watch.arm(entry.url)
      else if (!isUrlWatchable(entry.url)) watch.disarm(entry.url)
    }
  }

  /**
   * Apply a settled reading to the one entry with that URL, and move it under
   * the branch GitHub named if it was still in the unknown bucket.
   */
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
    },
  ): void {
    const at = located.get(url)
    if (!at) return
    const state = repos.get(at.repoKey)
    if (!state) return
    // A legacy captured entry was filed from a URL alone: no title, and the
    // moment of capture standing in for the moment it was opened. GitHub's
    // word wins where GitHub gave one; a read that said nothing never blanks
    // what we have.
    const updated: BranchPullRequest = {
      ...at.entry,
      ...(next.title ? { title: next.title } : {}),
      ...(typeof next.openedAt === 'number' && next.openedAt > 0 ? { openedAt: next.openedAt } : {}),
      ...(at.entry.number === 0 && typeof next.number === 'number' && next.number > 0 ? { number: next.number } : {}),
      state: next.state,
      isDraft: next.isDraft,
      stateAt: next.stateAt,
    }
    const target = at.branch === UNKNOWN_BRANCH && next.headRefName ? next.headRefName : at.branch
    if (target === at.branch) {
      commit(
        state,
        at.branch,
        entriesOf(state, at.branch).map((entry) => (entry.url === url ? updated : entry)),
      )
      return
    }
    commit(
      state,
      at.branch,
      entriesOf(state, at.branch).filter((entry) => entry.url !== url),
    )
    commit(state, target, mergeByUrl(entriesOf(state, target), [updated]))
  }

  async function refresh(url: string): Promise<void> {
    if (disposed) return
    const inFlight = refreshesInFlight.get(url)
    if (inFlight) return inFlight
    // A read that could not settle is HELD: with `gh` unauthenticated or rate
    // limited every read fails instantly, and each focus would otherwise spawn
    // `gh` once per open pull request, for ever, learning nothing.
    const hold = refreshHolds.get(url)
    if (hold && !hold.settled && now() - hold.at < LOOKUP_RETRY_AFTER_FAILURE_MS) return
    if (!mayAsk()) return
    const read = (async () => {
      const outcome = await withReadSlot(() =>
        mayAsk() ? readState(url, { now }) : Promise.resolve({ settled: false, reason: 'bad-request' } as const),
      )
      if (disposed) return
      if (!outcome.settled) {
        noteReadFailure(outcome.reason)
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

  function checkoutId(checkout: PullRequestCheckout): string {
    return `${normalizeComparablePath(checkout.gitRoot)}\0${checkout.branch}`
  }

  async function ensureLookedUp(input: PullRequestCheckout, lookupOptions: { force?: boolean } = {}): Promise<void> {
    if (disposed) return
    const checkout = normalizeCheckout(input)
    if (!checkout) return
    const key = checkoutId(checkout)
    const force = lookupOptions.force === true
    const asked = now()
    // At most a few passes: each one either answers, waits for the lookup in
    // flight (the per-checkout lock) and looks again, or starts one.
    for (let pass = 0; pass < 4; pass += 1) {
      if (disposed) return
      const hold = held.get(key)
      if (force) {
        if (hold?.settled && hold.startedAt >= asked) return
        if (hold && !hold.settled && now() < hold.retryAt) return
      } else if (hold && now() < hold.retryAt) {
        return
      }
      const inFlight = lookupsInFlight.get(key)
      if (inFlight) {
        if (!force || inFlight.startedAt >= asked) return inFlight.promise
        // Never two lookups of one checkout at once: an older answer landing
        // after a newer one would put back what the newer one learned.
        await inFlight.promise
        continue
      }
      if (force && hold?.settled && now() - hold.startedAt < FORCED_LOOKUP_MIN_INTERVAL_MS) {
        await deferredLookup(key, checkout, hold.startedAt + FORCED_LOOKUP_MIN_INTERVAL_MS)
        return
      }
      return runLookup(key, checkout)
    }
  }

  /** One turn end's lookup, made once the minimum interval has passed; every turn end inside it shares it. */
  function deferredLookup(key: string, checkout: PullRequestCheckout, at: number): Promise<void> {
    const pending = deferredLookups.get(key)
    if (pending) return pending.promise
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    const handle = timers.setTimeout(
      () => {
        deferredLookups.delete(key)
        void (async () => {
          const inFlight = lookupsInFlight.get(key)
          if (inFlight) await inFlight.promise
          if (!disposed) await runLookup(key, checkout)
        })().finally(resolve)
      },
      Math.max(0, at - now()),
    )
    deferredLookups.set(key, { promise, handle, resolve })
    return promise
  }

  function runLookup(key: string, checkout: PullRequestCheckout): Promise<void> {
    const startedAt = now()
    if (!mayAsk()) {
      held.set(key, { startedAt, settled: false, retryAt: startedAt + LOOKUP_RETRY_AFTER_FAILURE_MS })
      return Promise.resolve()
    }
    const promise = (async () => {
      const read = await withReadSlot(() =>
        mayAsk()
          ? listBranch({ gitRoot: checkout.gitRoot, branch: checkout.branch }, { now })
          : Promise.resolve({ settled: false, reason: 'bad-request' } as const),
      )
      if (disposed) return
      if (!read.settled) {
        // Could not ask. The record is left exactly as it was.
        noteReadFailure(read.reason)
        held.set(key, { startedAt, settled: false, retryAt: now() + LOOKUP_RETRY_AFTER_FAILURE_MS })
        return
      }
      held.set(key, { startedAt, settled: true, retryAt: now() + LOOKUP_HOLD_MS })
      // One `gh pr list` answers for one repository, but the rows carry their
      // own — a fork's pull request is in the fork — so they are grouped.
      for (const [repoKey, incoming] of groupByRepo(read.pullRequests)) {
        // This checkout can read this key back, whatever its own remote says.
        // Recorded BEFORE the commit below, so the change it emits reaches
        // the conversations on this checkout.
        noteLookupRepoKey(checkout.gitRoot, repoKey)
        const state = await loadedRepo(repoKey)
        if (disposed) return
        // A legacy entry for one of these URLs may still sit in the unknown
        // bucket. Who it was filed under is read BEFORE it is taken out of
        // that bucket, because taking it out drops it from the index.
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
    const entry: InFlightLookup = { startedAt, promise }
    lookupsInFlight.set(key, entry)
    return promise.finally(() => {
      if (lookupsInFlight.get(key) === entry) lookupsInFlight.delete(key)
    })
  }

  function detachFromOtherBranch(state: RepoState, url: string, keepBranch: string): void {
    const at = located.get(url)
    if (!at || at.repoKey !== state.repoKey || at.branch === keepBranch) return
    commit(
      state,
      at.branch,
      entriesOf(state, at.branch).filter((entry) => entry.url !== url),
    )
  }

  function mergeByUrl(
    existing: readonly BranchPullRequest[],
    incoming: readonly BranchPullRequest[],
    priors?: ReadonlyMap<string, BranchPullRequest>,
  ): BranchPullRequest[] {
    const merged = new Map<string, BranchPullRequest>()
    for (const entry of existing) merged.set(entry.url, entry)
    for (const entry of incoming) {
      // Who a legacy entry was filed under is what a branch lookup can NEVER
      // supply, so those are the fields the merge preserves.
      const previous = merged.get(entry.url) ?? priors?.get(entry.url) ?? located.get(entry.url)?.entry
      merged.set(entry.url, {
        ...entry,
        ...(previous?.openedBySessionId ? { openedBySessionId: previous.openedBySessionId } : {}),
        ...(previous?.openedByWorkspaceId ? { openedByWorkspaceId: previous.openedByWorkspaceId } : {}),
      })
    }
    return [...merged.values()]
  }

  /** A checkout's own repository key, asked of git once and kept when git answered. */
  function ensureRepoKey(gitRoot: string): Promise<string | null> {
    const key = normalizeComparablePath(gitRoot)
    const known = repoKeyByCheckout.get(key)
    if (known !== undefined) return Promise.resolve(known)
    const reading = repoKeyReads.get(key)
    if (reading) return reading
    const read = (async () => {
      const repoKey = await resolveRepoKey(gitRoot)
      if (disposed || !repoKey) return null
      // Only a settled answer is remembered; a remote that could not be read
      // is asked about again rather than cached as "no repository".
      repoKeyByCheckout.set(key, repoKey)
      return repoKey
    })()
      .catch((error) => {
        warn('could not resolve a checkout repository', error)
        return null
      })
      .finally(() => {
        repoKeyReads.delete(key)
      })
    repoKeyReads.set(key, read)
    return read
  }

  function noteLookupRepoKey(gitRoot: string, repoKey: string): void {
    addTo(lookupRepoKeys, normalizeComparablePath(gitRoot), repoKey)
  }

  /** Every repository key a checkout may read a list back under: its own remote's, plus its lookups'. */
  function checkoutRepoKeys(gitRoot: string): string[] {
    const keys: string[] = []
    const own = repoKeyByCheckout.get(normalizeComparablePath(gitRoot))
    if (own) keys.push(own)
    for (const key of lookupRepoKeys.get(normalizeComparablePath(gitRoot)) ?? []) {
      if (!keys.includes(key)) keys.push(key)
    }
    return keys
  }

  /** A touch's keys: the ones written down with it, and whatever this run has learned since. */
  function touchRepoKeys(touch: Touch): string[] {
    const keys = [...touch.repoKeys]
    for (const key of checkoutRepoKeys(touch.gitRoot)) if (!keys.includes(key)) keys.push(key)
    return keys
  }

  function forBranch(repoKey: string, branch: string): BranchPullRequest[] {
    const state = repoStateFor(repoKey)
    // First ask about this repository: read the file, and re-emit when it lands.
    if (!state.loaded) void load(state)
    return entriesOf(state, branch)
  }

  function entriesAt(urls: Iterable<string> | undefined): BranchPullRequest[] {
    const entries: BranchPullRequest[] = []
    for (const url of urls ?? []) {
      const at = located.get(url)
      if (at) entries.push(at.entry)
    }
    return entries
  }

  function forConversation(key: PullRequestConversationKey): BranchPullRequest[] {
    const id = conversationId(key)
    const conversation = conversations.get(id)
    const lists: BranchPullRequest[][] = []
    const homeUrls = new Set<string>()
    for (const touch of conversation?.touches ?? []) {
      const isHome = conversation?.home === touchId(touch)
      for (const repoKey of touchRepoKeys(touch)) {
        const list = forBranch(repoKey, touch.branch)
        if (list.length === 0) continue
        lists.push(list)
        if (isHome) for (const entry of list) homeUrls.add(entry.url)
      }
    }
    // The legacy entries a hook capture filed under a session this
    // conversation runs as.
    for (const sessionId of aliasesByConversation.get(id) ?? []) {
      const own = entriesAt(bySession.get(sessionId))
      if (own.length > 0) lists.push(own)
    }
    if (lists.length === 0) return []
    const union = lists.length === 1 ? [...lists[0]] : unionPullRequests(...lists)
    // Stamped after the union, so the flag survives whichever copy of a
    // twice-reached pull request won: the sidebar's "landed" reading may only
    // be decided by a pull request on the conversation's own branch, never by
    // one in another repository (the-diff-an-agent-made decision 10).
    return union.map((entry) => (homeUrls.has(entry.url) ? { ...entry, onSessionBranch: true } : entry))
  }

  function forWorkspace(workspaceId: string): BranchPullRequest[] {
    const lists: BranchPullRequest[][] = []
    const legacy = entriesAt(byWorkspace.get(workspaceId))
    if (legacy.length > 0) lists.push(legacy)
    for (const conversation of conversations.values()) {
      if (conversation.workspaceId !== workspaceId) continue
      const list = forConversation(keyOf(conversation))
      // A row is the conversation, not one agent's checkout: no entry on it
      // speaks for a branch.
      if (list.length > 0) lists.push(list.map(({ onSessionBranch: _onBranch, ...entry }) => entry))
    }
    if (lists.length === 0) return []
    return unionPullRequests(...lists)
  }

  /** Remember that a conversation worked in this checkout; returns its record. */
  function touch(key: PullRequestConversationKey, checkout: PullRequestCheckout, home: boolean): ConversationTouches {
    const id = conversationId(key)
    const at = now()
    const existing = conversations.get(id)
    const conversation: ConversationTouches = existing ?? {
      workspaceId: key.workspaceId,
      agentId: key.agentId,
      touches: [],
      home: null,
      at,
    }
    const tid = touchId(checkout)
    const previous = conversation.touches.find((candidate) => touchId(candidate) === tid)
    const next: Touch = { gitRoot: checkout.gitRoot, branch: checkout.branch, repoKeys: previous?.repoKeys ?? [], at }
    const others = conversation.touches.filter((candidate) => touchId(candidate) !== tid)
    const homeId = home ? tid : conversation.home
    // Bounded, newest first; the conversation's own checkout is never the one
    // that goes.
    const kept = [next, ...others]
    while (kept.length > MAX_TOUCHES_PER_CONVERSATION) {
      let index = kept.length - 1
      while (index >= 0 && touchId(kept[index]) === homeId) index -= 1
      if (index < 0) break
      kept.splice(index, 1)
    }
    const updated: ConversationTouches = { ...conversation, touches: kept, home: homeId, at }
    conversations.delete(id)
    conversations.set(id, updated)
    // The map is in order of last activity: the first key is the oldest.
    while (conversations.size > MAX_CONVERSATIONS) {
      const oldest = conversations.keys().next().value
      if (oldest === undefined) break
      conversations.delete(oldest)
    }
    return updated
  }

  function signatureOf(list: readonly BranchPullRequest[]): string {
    return list
      .map((entry) => `${entry.url}|${entry.state}|${entry.isDraft}|${entry.onSessionBranch === true}`)
      .join('\n')
  }

  async function noteCheckout(
    key: PullRequestConversationKey,
    input: PullRequestCheckout,
    noteOptions: { force?: boolean; home?: boolean; sessionId?: string } = {},
  ): Promise<void> {
    if (disposed) return
    const checkout = normalizeCheckout(input)
    if (!checkout || !validKey(key)) return
    await loadConversations()
    if (disposed) return
    const id = conversationId(key)
    const before = signatureOf(forConversation(key))
    if (noteOptions.sessionId) aliasSession(noteOptions.sessionId, id)
    touch(key, checkout, noteOptions.home === true)
    persistConversations()
    await Promise.all([
      ensureLookedUp(checkout, { force: noteOptions.force === true }),
      ensureRepoKey(checkout.gitRoot),
    ])
    if (disposed) return
    // What the lookup answered under, written down with the touch, so after a
    // restart its list is worn before any lookup has run again.
    const conversation = conversations.get(id)
    const current = conversation?.touches.find((candidate) => touchId(candidate) === touchId(checkout))
    if (conversation && current) {
      const keys = checkoutRepoKeys(checkout.gitRoot)
      if (keys.some((repoKey) => !current.repoKeys.includes(repoKey))) {
        current.repoKeys = [...new Set([...current.repoKeys, ...keys])]
        persistConversations()
      }
      for (const repoKey of current.repoKeys) await loadedRepo(repoKey)
    }
    if (disposed) return
    // A conversation that has just begun to read a list nothing changed in
    // hears so itself: the commit that filled the list emitted before it
    // was reading it.
    if (signatureOf(forConversation(key)) !== before) {
      emit({ repoKey: null, branch: null, workspaceIds: [key.workspaceId], conversations: [{ ...key }] })
    }
  }

  /** The stale open readings in a list, re-read. Each URL's refresh coalesces itself. */
  function refreshStale(list: readonly BranchPullRequest[]): void {
    const cutoff = now() - HOVER_REFRESH_STALE_MS
    for (const entry of list) {
      if (entry.state !== 'open') continue
      if (entry.stateAt > cutoff) continue
      void refresh(entry.url)
    }
  }

  /** Every open pull request on the record whose reading is stale, bounded like the watch. */
  function refreshOpenEntries(): void {
    const cutoff = now() - HOVER_REFRESH_STALE_MS
    for (const { entry } of located.values()) {
      if (!isEntryWatchable(entry) || entry.stateAt > cutoff) continue
      void refresh(entry.url)
    }
  }

  function refreshConversation(key: PullRequestConversationKey): boolean {
    if (disposed || !validKey(key)) return false
    const conversation = conversations.get(conversationId(key))
    const touches = conversation?.touches ?? []
    if (touches.length === 0) {
      const own = forConversation(key)
      refreshStale(own)
      return own.length > 0
    }
    void Promise.all(touches.map((candidate) => ensureLookedUp(candidate))).then(() => {
      if (!disposed) refreshStale(forConversation(key))
    })
    return true
  }

  if (options.loadStoredOnStart) {
    void loadStored()
    void loadConversations()
  }

  return {
    forBranch,
    forConversation,
    forWorkspace,
    noteCheckout,
    nameSession(key, sessionId) {
      if (disposed || !validKey(key) || !sessionId) return
      const id = conversationId(key)
      if (sessionAliases.get(sessionId) === id) return
      const before = signatureOf(forConversation(key))
      aliasSession(sessionId, id)
      if (signatureOf(forConversation(key)) !== before) {
        emit({ repoKey: null, branch: null, workspaceIds: [key.workspaceId], conversations: [{ ...key }] })
      }
    },
    homeOf(key) {
      const conversation = conversations.get(conversationId(key))
      const home = conversation?.touches.find((candidate) => touchId(candidate) === conversation.home)
      return home ? { gitRoot: home.gitRoot, branch: home.branch } : null
    },
    ensureLookedUp,
    refresh,
    refreshConversation,

    refreshWorkspace(workspaceId) {
      if (disposed || !workspaceId) return false
      let asked = false
      for (const conversation of [...conversations.values()]) {
        if (conversation.workspaceId === workspaceId && refreshConversation(keyOf(conversation))) asked = true
      }
      const legacy = entriesAt(byWorkspace.get(workspaceId))
      refreshStale(legacy)
      return asked || legacy.length > 0
    },

    refreshOutstanding() {
      if (disposed) return
      void loadStored().then(() => {
        if (!disposed) refreshOpenEntries()
      })
    },

    conversationsActiveSince(since) {
      return [...conversations.values()]
        .filter((conversation) => conversation.at >= since)
        .sort((a, b) => b.at - a.at)
        .map(keyOf)
    },

    async whenLoaded() {
      await Promise.all([loadStored(), loadConversations()])
    },

    watchedUrls() {
      return watch.watchedKeys()
    },

    async flush() {
      if (conversationsWriteTimer) writeConversationsNow()
      for (let pass = 0; pass < 8; pass += 1) {
        const pending: Promise<unknown>[] = [conversationWrites]
        for (const state of repos.values()) {
          if (state.loading) pending.push(state.loading)
          pending.push(state.writes)
        }
        if (storedLoad) pending.push(storedLoad)
        if (conversationsLoad) pending.push(conversationsLoad)
        pending.push(
          ...[...lookupsInFlight.values()].map((entry) => entry.promise),
          ...refreshesInFlight.values(),
          ...repoKeyReads.values(),
        )
        await Promise.allSettled(pending)
        if (lookupsInFlight.size === 0 && refreshesInFlight.size === 0 && repoKeyReads.size === 0) {
          if (conversationsWriteTimer) writeConversationsNow()
          // One more pass over the write chains, which the last commit extended.
          await Promise.allSettled([conversationWrites, ...[...repos.values()].map((state) => state.writes)])
          return
        }
      }
    },

    dispose() {
      disposed = true
      // A quit flushes first; a dispose on its own drops a write still waiting.
      if (conversationsWriteTimer) clearTimeout(conversationsWriteTimer)
      conversationsWriteTimer = null
      watch.dispose()
      releaseWaitingReads()
      for (const pending of deferredLookups.values()) {
        timers.clearTimeout(pending.handle)
        pending.resolve()
      }
      deferredLookups.clear()
      held.clear()
      refreshHolds.clear()
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
  return read.settled ? (read.identity?.canonicalKey ?? null) : null
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>()
  values.add(value)
  index.set(key, values)
}

function conversationId(key: PullRequestConversationKey): string {
  return `${key.workspaceId}\0${key.agentId}`
}

function keyOf(conversation: Pick<ConversationTouches, 'workspaceId' | 'agentId'>): PullRequestConversationKey {
  return { workspaceId: conversation.workspaceId, agentId: conversation.agentId }
}

function touchId(checkout: Pick<Touch, 'gitRoot' | 'branch'>): string {
  return `${normalizeComparablePath(checkout.gitRoot)}\0${checkout.branch}`
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

function normalizeCheckout(input: PullRequestCheckout): PullRequestCheckout | null {
  const gitRoot = input?.gitRoot?.trim()
  const branch = input?.branch?.trim()
  return gitRoot && branch && !branch.startsWith('-') ? { gitRoot, branch } : null
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

function sameList(a: readonly BranchPullRequest[], b: readonly BranchPullRequest[], includeStateAt: boolean): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => sameEntry(entry, b[index], includeStateAt))
}

/**
 * Two entries as a reader would see them. `stateAt` — WHEN GitHub was last
 * asked — is only compared when the caller is deciding whether anything at all
 * moved; it is not something rendered.
 */
function sameEntry(a: BranchPullRequest, b: BranchPullRequest, includeStateAt: boolean): boolean {
  return (
    a.url === b.url &&
    a.repoKey === b.repoKey &&
    a.repoName === b.repoName &&
    a.number === b.number &&
    a.title === b.title &&
    a.state === b.state &&
    a.isDraft === b.isDraft &&
    a.openedAt === b.openedAt &&
    (!includeStateAt || a.stateAt === b.stateAt) &&
    a.openedBySessionId === b.openedBySessionId &&
    a.openedByWorkspaceId === b.openedByWorkspaceId
  )
}

/**
 * One store file's branches, or null when the file is not one this build can
 * read — truncated, hand-edited into nonsense, or stamped with a version it
 * does not know. Null is never "empty": the caller keeps the file aside.
 */
function parseStoreFile(raw: string): Map<string, BranchPullRequest[]> | null {
  const branches = new Map<string, BranchPullRequest[]>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.branches)) return null
  if (parsed.version !== STORE_VERSION) return null
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
    ...(typeof raw.openedByWorkspaceId === 'string' && raw.openedByWorkspaceId
      ? { openedByWorkspaceId: raw.openedByWorkspaceId }
      : {}),
  }
}

/** The conversations file, or null when this build cannot read it. Malformed rows are dropped. */
function parseConversationsFile(raw: string): ConversationTouches[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== CONVERSATIONS_VERSION || !Array.isArray(parsed.conversations)) return null
  const out: ConversationTouches[] = []
  for (const row of parsed.conversations.slice(0, MAX_CONVERSATIONS)) {
    if (!isRecord(row) || typeof row.workspaceId !== 'string' || typeof row.agentId !== 'string') continue
    if (!row.workspaceId || !row.agentId || !Array.isArray(row.touches)) continue
    const touches: Touch[] = []
    for (const candidate of row.touches.slice(0, MAX_TOUCHES_PER_CONVERSATION)) {
      if (!isRecord(candidate)) continue
      const checkout = normalizeCheckout({
        gitRoot: typeof candidate.gitRoot === 'string' ? candidate.gitRoot : '',
        branch: typeof candidate.branch === 'string' ? candidate.branch : '',
      })
      if (!checkout) continue
      const repoKeys = Array.isArray(candidate.repoKeys)
        ? candidate.repoKeys.filter((key): key is string => typeof key === 'string' && key.length > 0).slice(0, 8)
        : []
      const at = typeof candidate.at === 'number' && Number.isFinite(candidate.at) ? candidate.at : 0
      touches.push({ ...checkout, repoKeys, at })
    }
    const home = typeof row.home === 'string' && touches.some((touch) => touchId(touch) === row.home) ? row.home : null
    const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
    out.push({ workspaceId: row.workspaceId, agentId: row.agentId, touches, home, at })
  }
  return out
}

async function writeJsonFile(userDataDir: string, finalPath: string, data: unknown): Promise<void> {
  const tempPath = `${finalPath}.${randomUUID()}.tmp`
  await mkdir(join(userDataDir, STORE_DIR), { recursive: true })
  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/** Swept once per record, at the first load: a `.tmp` nothing is writing any more. */
function createTempFileSweep(userDataDir: string): () => Promise<void> {
  let sweep: Promise<void> | null = null
  return () => {
    if (sweep) return sweep
    sweep = (async () => {
      const dir = join(userDataDir, STORE_DIR)
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      // Wall-clock, not an injected clock: this is a file's age, and a write
      // in flight RIGHT NOW must not have its temp file pulled out from under it.
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
    })().catch(() => undefined)
    return sweep
  }
}
