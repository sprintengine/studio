import { useCallback, useEffect, useRef, useState } from 'react'
import { logPerfEvent } from '../utils/perfDiagnostics'

type UseGitStatusResult = {
  repoRoot: string | null
  status: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  refresh: () => Promise<void>
}

type SharedGitStatusSnapshot = {
  status: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
}

type GitStatusSubscriber = (snapshot: SharedGitStatusSnapshot) => void
type GitStatusRefreshCause = 'initial' | 'watch' | 'recovery' | 'manual' | 'coalesced'
type GitStatusScheduledRefreshCause = Exclude<GitStatusRefreshCause, 'coalesced'>

type GitStatusSubscription = {
  repoRoot: string
  status: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  signature: string
  subscribers: Set<GitStatusSubscriber>
  refreshTimer: number | null
  recoveryTimer: number | null
  recoveryDelayMs: number
  refreshPromise: Promise<void> | null
  refreshAgain: boolean
  stopWatching?: () => Promise<void>
  watchStarting: boolean
}

const GIT_STATUS_RECOVERY_INITIAL_MS = 30_000
const GIT_STATUS_WATCH_RECOVERY_INITIAL_MS = 120_000
const GIT_STATUS_RECOVERY_MAX_MS = 300_000
const GIT_STATUS_WATCH_REFRESH_DEBOUNCE_MS = 1_000
const GIT_STATUS_DEFAULT_REFRESH_DEBOUNCE_MS = 250
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
  return Object.values(snapshot.files)
    .map((entry) => `${entry.relativePath}:${entry.status}:${entry.staged ? '1' : '0'}:${entry.unstaged ? '1' : '0'}`)
    .sort()
    .join('|')
}

function notifyGitStatusSubscribers(subscription: GitStatusSubscription): void {
  const snapshot = {
    status: subscription.status,
    directoryStatus: subscription.directoryStatus,
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
  if (!subscription.subscribers.size || document.hidden) return

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
      if (cause === 'recovery' && !signatureChanged) {
        backOffGitStatusRecovery(subscription)
      } else {
        resetGitStatusRecoveryDelay(subscription)
      }
      if (signatureChanged) {
        subscription.status = normalized
        subscription.directoryStatus = buildDirectoryStatusMap(normalized)
        subscription.signature = nextSignature
        notifyGitStatusSubscribers(subscription)
      }
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
      if (subscription.status || subscription.signature) {
        subscription.status = null
        subscription.directoryStatus = {}
        subscription.signature = ''
        notifyGitStatusSubscribers(subscription)
      }
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

function startGitStatusWatch(subscription: GitStatusSubscription): void {
  if (subscription.watchStarting || subscription.stopWatching || typeof window.api.watchPath !== 'function') return

  subscription.watchStarting = true
  window.api.watchPath(subscription.repoRoot, () => scheduleGitStatusRefresh(subscription, 'watch'))
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
    signature: '',
    subscribers: new Set(),
    refreshTimer: null,
    recoveryTimer: null,
    recoveryDelayMs: GIT_STATUS_RECOVERY_INITIAL_MS,
    refreshPromise: null,
    refreshAgain: false,
    watchStarting: false,
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
  })

  return () => {
    subscription.subscribers.delete(subscriber)
    if (subscription.subscribers.size > 0) return

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

export function useGitStatus(rootPath: string | null): UseGitStatusResult {
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null)
  const [directoryStatus, setDirectoryStatus] = useState<Record<string, GitFileStatus>>({})
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

    if (!rootPath) return
    if (typeof window.api.getGitRepoRoot !== 'function' || typeof window.api.getGitStatus !== 'function') return

    resolveSharedGitRepoRoot(rootPath)
      .then((nextRepoRoot) => {
        if (cancelled) return
        repoRootRef.current = nextRepoRoot
        setRepoRoot(nextRepoRoot)
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
    })
  }, [repoRoot])

  return { repoRoot, status, directoryStatus, refresh }
}
