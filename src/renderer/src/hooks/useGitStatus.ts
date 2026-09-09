import { useCallback, useEffect, useRef, useState } from 'react'
import { logPerfEvent } from '../utils/perfDiagnostics'

type UseGitStatusResult = {
  repoRoot: string | null
  status: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  repoState: GitRepoState
  errorMessage: string | null
  refresh: () => Promise<void>
}

type SharedGitStatusSnapshot = {
  status: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  errorMessage: string | null
}

export type GitRepoState = 'idle' | 'loading' | 'ready' | 'not-git' | 'error'

type GitStatusSubscriber = (snapshot: SharedGitStatusSnapshot) => void
// Told about every COMPLETED read, not only the ones that changed the file
// list. See `revision` on the subscription below.
type GitStatusRevisionSubscriber = (revision: number) => void
type GitStatusRefreshCause = 'initial' | 'watch' | 'recovery' | 'manual' | 'coalesced'
type GitStatusScheduledRefreshCause = Exclude<GitStatusRefreshCause, 'coalesced'>

type GitStatusSubscription = {
  repoRoot: string
  status: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  errorMessage: string | null
  signature: string
  /**
   * Ticks once per completed `git status` read. The signature above answers
   * "did the file LIST change"; this answers "was the tree read again", which
   * is the only honest cue for content that moved without moving status — a
   * save that leaves a file modified is invisible to the signature, and a diff
   * of that file is stale from the moment it lands.
   */
  revision: number
  subscribers: Set<GitStatusSubscriber>
  revisionSubscribers: Set<GitStatusRevisionSubscriber>
  refreshTimer: number | null
  recoveryTimer: number | null
  recoveryDelayMs: number
  refreshPromise: Promise<void> | null
  refreshAgain: boolean
  stopWatching?: () => Promise<void>
  watchStarting: boolean
  lastWatchRefreshAt: number
}

const GIT_STATUS_RECOVERY_INITIAL_MS = 30_000
const GIT_STATUS_WATCH_RECOVERY_INITIAL_MS = 120_000
const GIT_STATUS_RECOVERY_MAX_MS = 300_000
const GIT_STATUS_WATCH_REFRESH_DEBOUNCE_MS = 1_000
const GIT_STATUS_WATCH_REFRESH_MIN_INTERVAL_MS = 10_000
const GIT_STATUS_DEFAULT_REFRESH_DEBOUNCE_MS = 250
const GIT_STATUS_WATCH_IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  '.vite',
  '__pycache__',
])
const gitStatusSubscriptions = new Map<string, GitStatusSubscription>()
const gitRepoRootLookups = new Map<string, Promise<string | null>>()
let gitStatusVisibilityListenerInstalled = false

export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export function getGitEntry(status: GitStatusSnapshot | null, path: string | null | undefined): GitStatusEntry | null {
  if (!status || !path) return null
  return status.files[path] ?? status.files[normalizePathKey(path)] ?? null
}

function normalizeStatusSnapshot(snapshot: GitStatusSnapshot): GitStatusSnapshot {
  return {
    ...snapshot,
    files: Object.fromEntries(
      Object.values(snapshot.files).map((entry) => [
        normalizePathKey(entry.path),
        entry,
      ])
    ),
  }
}

function parentPathKey(pathKey: string): string | null {
  const trimmed = pathKey.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return null
  return trimmed.slice(0, index)
}

function mergeGitStatusPriority(
  current: GitFileStatus | null | undefined,
  next: GitFileStatus
): GitFileStatus {
  if (current === 'conflicted' || next === 'conflicted') return 'conflicted'
  if (
    current === 'modified'
    || current === 'renamed'
    || current === 'deleted'
    || next === 'modified'
    || next === 'renamed'
    || next === 'deleted'
  ) return 'modified'
  return 'new'
}

function buildDirectoryStatusMap(snapshot: GitStatusSnapshot | null): Record<string, GitFileStatus> {
  if (!snapshot) return {}

  const repoRootKey = normalizePathKey(snapshot.repoRoot).replace(/\/+$/, '')
  const directoryStatus: Record<string, GitFileStatus> = {}

  Object.values(snapshot.files).forEach((entry) => {
    let directoryKey = parentPathKey(normalizePathKey(entry.path))
    while (directoryKey && directoryKey.startsWith(repoRootKey) && directoryKey !== repoRootKey) {
      directoryStatus[directoryKey] = mergeGitStatusPriority(directoryStatus[directoryKey], entry.status)
      directoryKey = parentPathKey(directoryKey)
    }
  })

  return directoryStatus
}

function getStatusSignature(snapshot: GitStatusSnapshot | null): string {
  if (!snapshot) return ''
  // The signature must cover every render-relevant snapshot field. `operation`
  // can flip with an unchanged file list (e.g. a cherry-pick that stops with a
  // clean tree), and the Continue/Abort notice hangs off it.
  const fileSignature = Object.values(snapshot.files)
    .map((entry) => `${entry.relativePath}:${entry.status}:${entry.staged ? '1' : '0'}:${entry.unstaged ? '1' : '0'}`)
    .sort()
    .join('|')
  return `${snapshot.operation ?? 'none'}#${fileSignature}`
}

function notifyGitStatusSubscribers(subscription: GitStatusSubscription): void {
  const snapshot = {
    status: subscription.status,
    directoryStatus: subscription.directoryStatus,
    errorMessage: subscription.errorMessage,
  }
  subscription.subscribers.forEach((subscriber) => subscriber(snapshot))
}

function clearGitStatusRecovery(subscription: GitStatusSubscription): void {
  if (subscription.recoveryTimer !== null) {
    window.clearTimeout(subscription.recoveryTimer)
    subscription.recoveryTimer = null
  }
}

function resetGitStatusRecoveryDelay(subscription: GitStatusSubscription): void {
  subscription.recoveryDelayMs = subscription.stopWatching
    ? GIT_STATUS_WATCH_RECOVERY_INITIAL_MS
    : GIT_STATUS_RECOVERY_INITIAL_MS
}

function backOffGitStatusRecovery(subscription: GitStatusSubscription): void {
  subscription.recoveryDelayMs = Math.min(
    subscription.recoveryDelayMs * 2,
    GIT_STATUS_RECOVERY_MAX_MS
  )
}

function scheduleGitStatusRecovery(subscription: GitStatusSubscription): void {
  clearGitStatusRecovery(subscription)
  // The same guard `releaseGitStatusSubscription` uses, and it has to be: that
  // one keeps the subscription alive while EITHER set has a listener, so a
  // revision-only subscription (the diff window's live re-read, with no status
  // reader beside it) would otherwise be kept alive and then never tick again
  // after its first failure.
  const listening = subscription.subscribers.size > 0 || subscription.revisionSubscribers.size > 0
  if (!listening || document.hidden) return

  subscription.recoveryTimer = window.setTimeout(() => {
    subscription.recoveryTimer = null
    if (document.hidden) return
    void refreshGitStatusSubscription(subscription, 'recovery')
  }, subscription.recoveryDelayMs)
}

function ensureGitStatusVisibilityListener(): void {
  if (gitStatusVisibilityListenerInstalled) return
  gitStatusVisibilityListenerInstalled = true

  document.addEventListener('visibilitychange', () => {
    gitStatusSubscriptions.forEach((subscription) => {
      if (document.hidden) {
        clearGitStatusRecovery(subscription)
        return
      }

      resetGitStatusRecoveryDelay(subscription)
      void refreshGitStatusSubscription(subscription, 'recovery')
    })
  })
}

async function refreshGitStatusSubscription(
  subscription: GitStatusSubscription,
  cause: GitStatusRefreshCause
): Promise<void> {
  if (subscription.refreshPromise) {
    subscription.refreshAgain = true
    logPerfEvent('GitStatus', 'refresh-coalesced', {
      cause,
      repoRoot: subscription.repoRoot,
      subscriberCount: subscription.subscribers.size,
    })
    return subscription.refreshPromise
  }

  subscription.refreshPromise = (async () => {
    const startedAt = performance.now()
    try {
      const normalized = normalizeStatusSnapshot(await window.api.getGitStatus(subscription.repoRoot))
      const nextSignature = getStatusSignature(normalized)
      const signatureChanged = nextSignature !== subscription.signature
      const hadError = Boolean(subscription.errorMessage)
      if (cause === 'recovery' && !signatureChanged) {
        backOffGitStatusRecovery(subscription)
      } else {
        resetGitStatusRecoveryDelay(subscription)
      }
      if (signatureChanged || !subscription.status || hadError) {
        subscription.status = normalized
        subscription.directoryStatus = buildDirectoryStatusMap(normalized)
        subscription.signature = nextSignature
        subscription.errorMessage = null
        notifyGitStatusSubscribers(subscription)
      }
      // Every completed read moves the revision, changed list or not; the
      // listeners are few (an open diff) and each one guards its own work.
      subscription.revision += 1
      const revision = subscription.revision
      subscription.revisionSubscribers.forEach((subscriber) => subscriber(revision))
      logPerfEvent('GitStatus', 'refresh', {
        cause,
        repoRoot: subscription.repoRoot,
        elapsedMs: Math.round(performance.now() - startedAt),
        changedFileCount: Object.keys(normalized.files).length,
        signatureChanged,
        subscriberCount: subscription.subscribers.size,
      })
    } catch (error) {
      if (cause === 'recovery') {
        backOffGitStatusRecovery(subscription)
      } else {
        resetGitStatusRecoveryDelay(subscription)
      }
      logPerfEvent('GitStatus', 'refresh-error', {
        cause,
        repoRoot: subscription.repoRoot,
        elapsedMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : String(error),
        subscriberCount: subscription.subscribers.size,
      })
      subscription.status = null
      subscription.directoryStatus = {}
      subscription.signature = ''
      subscription.errorMessage = error instanceof Error ? error.message : String(error)
      notifyGitStatusSubscribers(subscription)
    } finally {
      subscription.refreshPromise = null
      if (subscription.refreshAgain) {
        subscription.refreshAgain = false
        void refreshGitStatusSubscription(subscription, 'coalesced')
      } else {
        scheduleGitStatusRecovery(subscription)
      }
    }
  })()

  return subscription.refreshPromise
}

function scheduleGitStatusRefresh(subscription: GitStatusSubscription, cause: GitStatusScheduledRefreshCause): void {
  if (subscription.refreshTimer !== null) {
    window.clearTimeout(subscription.refreshTimer)
  }

  const delayMs = cause === 'watch'
    ? GIT_STATUS_WATCH_REFRESH_DEBOUNCE_MS
    : GIT_STATUS_DEFAULT_REFRESH_DEBOUNCE_MS

  subscription.refreshTimer = window.setTimeout(() => {
    subscription.refreshTimer = null
    void refreshGitStatusSubscription(subscription, cause)
  }, delayMs)
}

function shouldIgnoreGitStatusWatchPath(path: string | null): boolean {
  if (!path) return true
  return path
    .split(/[/\\]+/)
    .filter(Boolean)
    .some((segment) => GIT_STATUS_WATCH_IGNORED_SEGMENTS.has(segment))
}

function startGitStatusWatch(subscription: GitStatusSubscription): void {
  if (subscription.watchStarting || subscription.stopWatching || typeof window.api.watchPath !== 'function') return
  if (window.api.platform === 'win32') {
    logPerfEvent('GitStatus', 'watch-disabled', {
      repoRoot: subscription.repoRoot,
      reason: 'Windows recursive fs.watch can retrigger Git status refresh loops.',
    })
    resetGitStatusRecoveryDelay(subscription)
    scheduleGitStatusRecovery(subscription)
    return
  }

  subscription.watchStarting = true
  window.api.watchPath(subscription.repoRoot, (event) => {
    if (shouldIgnoreGitStatusWatchPath(event.path)) {
      logPerfEvent('GitStatus', 'watch-ignored', {
        repoRoot: subscription.repoRoot,
        path: event.path,
      })
      return
    }
    logPerfEvent('GitStatus', 'watch', {
      repoRoot: subscription.repoRoot,
      path: event.path,
      eventType: event.eventType,
    })
    const now = Date.now()
    if (now - subscription.lastWatchRefreshAt < GIT_STATUS_WATCH_REFRESH_MIN_INTERVAL_MS) {
      logPerfEvent('GitStatus', 'watch-throttled', {
        repoRoot: subscription.repoRoot,
        path: event.path,
        eventType: event.eventType,
      })
      return
    }
    subscription.lastWatchRefreshAt = now
    scheduleGitStatusRefresh(subscription, 'watch')
  })
    .then((cleanup) => {
      subscription.watchStarting = false
      if (gitStatusSubscriptions.get(normalizePathKey(subscription.repoRoot)) !== subscription) {
        void cleanup()
        return
      }
      subscription.stopWatching = cleanup
      resetGitStatusRecoveryDelay(subscription)
      scheduleGitStatusRecovery(subscription)
    })
    .catch(() => {
      subscription.watchStarting = false
      // Git status still works without watch support; recovery and manual refreshes keep it usable.
    })
}

function getGitStatusSubscription(repoRoot: string): GitStatusSubscription {
  const key = normalizePathKey(repoRoot)
  const existing = gitStatusSubscriptions.get(key)
  if (existing) return existing
  ensureGitStatusVisibilityListener()

  const subscription: GitStatusSubscription = {
    repoRoot,
    status: null,
    directoryStatus: {},
    errorMessage: null,
    signature: '',
    revision: 0,
    subscribers: new Set(),
    revisionSubscribers: new Set(),
    refreshTimer: null,
    recoveryTimer: null,
    recoveryDelayMs: GIT_STATUS_RECOVERY_INITIAL_MS,
    refreshPromise: null,
    refreshAgain: false,
    watchStarting: false,
    lastWatchRefreshAt: 0,
  }

  gitStatusSubscriptions.set(key, subscription)
  void refreshGitStatusSubscription(subscription, 'initial')
  startGitStatusWatch(subscription)
  return subscription
}

function subscribeGitStatus(repoRoot: string, subscriber: GitStatusSubscriber): () => void {
  const key = normalizePathKey(repoRoot)
  const subscription = getGitStatusSubscription(repoRoot)
  subscription.subscribers.add(subscriber)
  subscriber({
    status: subscription.status,
    directoryStatus: subscription.directoryStatus,
    errorMessage: subscription.errorMessage,
  })

  return () => {
    subscription.subscribers.delete(subscriber)
    releaseGitStatusSubscription(subscription, key)
  }
}

// The shared subscription lives as long as ANY listener wants it — a status
// reader or a revision watcher. Dropping it while the other kind is still
// listening would stop the watcher under it.
function releaseGitStatusSubscription(subscription: GitStatusSubscription, key: string): void {
  if (subscription.subscribers.size > 0 || subscription.revisionSubscribers.size > 0) return

  if (subscription.refreshTimer !== null) {
    window.clearTimeout(subscription.refreshTimer)
    subscription.refreshTimer = null
  }
  clearGitStatusRecovery(subscription)
  if (subscription.stopWatching) {
    void subscription.stopWatching()
  }
  gitStatusSubscriptions.delete(key)
}

function subscribeGitStatusRevision(repoRoot: string, subscriber: GitStatusRevisionSubscriber): () => void {
  const key = normalizePathKey(repoRoot)
  const subscription = getGitStatusSubscription(repoRoot)
  subscription.revisionSubscribers.add(subscriber)
  subscriber(subscription.revision)

  return () => {
    subscription.revisionSubscribers.delete(subscriber)
    releaseGitStatusSubscription(subscription, key)
  }
}

function refreshSharedGitStatus(repoRoot: string | null): Promise<void> {
  if (!repoRoot || typeof window.api.getGitStatus !== 'function') return Promise.resolve()
  return refreshGitStatusSubscription(getGitStatusSubscription(repoRoot), 'manual')
}

function resolveSharedGitRepoRoot(rootPath: string): Promise<string | null> {
  const key = normalizePathKey(rootPath)
  const existing = gitRepoRootLookups.get(key)
  if (existing) return existing

  const lookup = window.api.getGitRepoRoot(rootPath)
    .catch(() => null)
    .finally(() => {
      gitRepoRootLookups.delete(key)
    })
  gitRepoRootLookups.set(key, lookup)
  return lookup
}

/**
 * How many times this repository's status has been read, for a view that has to
 * re-read something ELSE when the tree moves — the open diff's file content.
 * Pass the RESOLVED repo root (`useGitStatus(...).repoRoot`), so this joins the
 * subscription that already exists rather than starting a second watcher.
 *
 * It ticks inside the status hook's own debounce, so a burst of saves is one
 * tick, and it is deliberately not part of `useGitStatus`'s result: every panel
 * in the app reads that, and none of them should re-render because a poll came
 * back identical.
 */
export function useGitTreeRevision(repoRoot: string | null): number {
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!repoRoot) {
      setRevision(0)
      return
    }
    return subscribeGitStatusRevision(repoRoot, setRevision)
  }, [repoRoot])

  return revision
}

export function useGitStatus(rootPath: string | null): UseGitStatusResult {
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null)
  const [directoryStatus, setDirectoryStatus] = useState<Record<string, GitFileStatus>>({})
  const [repoState, setRepoState] = useState<GitRepoState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const repoRootRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    await refreshSharedGitStatus(repoRootRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false

    repoRootRef.current = null
    setRepoRoot(null)
    setStatus(null)
    setDirectoryStatus({})
    setErrorMessage(null)
    setRepoState(rootPath ? 'loading' : 'idle')

    if (!rootPath) return
    if (typeof window.api.getGitRepoRoot !== 'function' || typeof window.api.getGitStatus !== 'function') {
      setErrorMessage('Git integration is unavailable.')
      setRepoState('error')
      return
    }

    resolveSharedGitRepoRoot(rootPath)
      .then((nextRepoRoot) => {
        if (cancelled) return
        repoRootRef.current = nextRepoRoot
        setRepoRoot(nextRepoRoot)
        if (!nextRepoRoot) setRepoState('not-git')
      })

    return () => {
      cancelled = true
    }
  }, [rootPath])

  useEffect(() => {
    if (!repoRoot) {
      setStatus(null)
      setDirectoryStatus({})
      return
    }

    return subscribeGitStatus(repoRoot, (snapshot) => {
      setStatus(snapshot.status)
      setDirectoryStatus(snapshot.directoryStatus)
      setErrorMessage(snapshot.errorMessage)
      setRepoState(snapshot.errorMessage ? 'error' : snapshot.status ? 'ready' : 'loading')
    })
  }, [repoRoot])

  return { repoRoot, status, directoryStatus, repoState, errorMessage, refresh }
}
