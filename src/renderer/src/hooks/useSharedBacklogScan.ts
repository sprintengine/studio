import { useCallback, useEffect, useRef, useState } from 'react'

import {
  backlogRootPath,
  scanBacklog,
  type BacklogFilesystemAdapter,
  type BacklogItem,
  type BacklogScanResult,
} from '../utils/backlog'
import { hydrateBacklogScanResult } from '../utils/backlogObjects'
import { formatBacklogDisplayId } from '../../../shared/backlog/item-id'
import { normalizeProjectRootKey } from '../utils/projectKnowledge'
import type { BacklogItemRecordInput } from '../../../shared/electron-api'

// Project-folder-keyed shared Backlog scan, modeled on the shared-subscription
// pattern in useGitStatus: workspaces are grouped by folder, so several
// workspaces routinely point at the SAME backlog/ directory. Each BacklogPanel
// stays per-workspace in the UI, but every panel on the same project folder
// subscribes to ONE scan, ONE result, and ONE refresh here — instead of each
// instance scanning the identical folder and holding its own copy. Per-workspace
// view state (filter/sort/search/selection) stays local to the panel.

const adapter: BacklogFilesystemAdapter = {
  pathExists: (path) => window.api.pathExists(path),
  readdir: (path) => window.api.readdir(path),
  readfile: (path) => window.api.readfile(path),
  statPath: (path) => window.api.statPath(path),
}

// The minimal record the object store needs to ensure a row exists for each
// scanned file. Shared with BacklogPanel so the store and the panel agree on
// exactly which fields seed an item.json record.
export function backlogRecordInput(item: BacklogItem): BacklogItemRecordInput {
  return {
    relativePath: item.relativePath,
    status: item.status,
    // `epic` is not part of the sidecar payload union (epic-ness lives in
    // frontmatter and is re-derived every scan), so it never seeds items.json.
    type: item.type === 'epic' ? undefined : item.type,
    difficulty: item.difficulty,
    criticality: item.criticality,
  }
}

type BacklogScanSnapshot = {
  scan: BacklogScanResult | null
  loading: boolean
}

type BacklogScanSubscriber = (snapshot: BacklogScanSnapshot) => void

type BacklogScanSubscription = {
  folderPath: string
  scan: BacklogScanResult | null
  loading: boolean
  subscribers: Set<BacklogScanSubscriber>
  // Coalesces concurrent refreshes (mirrors useGitStatus): a refresh requested
  // while one is in flight sets refreshAgain instead of starting a second scan.
  refreshPromise: Promise<BacklogScanResult | null> | null
  refreshAgain: boolean
  // One shared filesystem watcher per project (mirrors startGitStatusWatch):
  // an event debounces into a refresh so external edits / sibling-workspace
  // writes update every consumer on the folder. Disposed on last unsubscribe.
  stopWatching: (() => Promise<void>) | null
  watchStarting: boolean
  watchTimer: number | null
}

// Collapse a burst of watch events into a single re-scan.
const BACKLOG_WATCH_DEBOUNCE_MS = 300

const backlogScanSubscriptions = new Map<string, BacklogScanSubscription>()

// The same key workspaces are grouped by: workspaceFolderKey(folderPath) is
// normalizeProjectRootKey lowercased (workspacesSlice.ts:84). We compute it from
// the lightweight path util directly rather than importing the store slice, so
// this module stays cheap to load (and unit-testable without the store graph).
function subscriptionKey(folderPath: string): string {
  return normalizeProjectRootKey(folderPath)?.toLowerCase() ?? folderPath
}

// The scan + object-store hydration flow, indirected so tests can inject a fake
// runner (counting calls, returning controlled results) without stubbing the
// filesystem IPC.
type BacklogScanRunner = (folderPath: string) => Promise<BacklogScanResult>

async function defaultBacklogScanRunner(folderPath: string): Promise<BacklogScanResult> {
  const scanned = await scanBacklog(folderPath, adapter)
  let metadataError: string | null = null
  const ensured = await window.api
    .ensureBacklogObjectRecords(folderPath, scanned.items.map(backlogRecordInput))
    .catch((error) => {
      metadataError = error instanceof Error ? error.message : String(error)
      return null
    })
  let result: BacklogScanResult
  if (ensured?.ok) result = hydrateBacklogScanResult(scanned, ensured.store)
  else if (ensured && !ensured.ok) result = mergeMetadataError(scanned, ensured.message)
  else if (metadataError) result = mergeMetadataError(scanned, metadataError)
  else result = scanned
  return allocateBacklogItemIds(folderPath, result)
}

// Scan-time id allocation (the single allocation authority): hand every scanned
// item with its current frontmatter id to the main process, which mints the next
// sequential id for any without one and writes it to frontmatter. We merge the
// freshly minted ids back onto the items so the panel shows `KEY-n` immediately,
// without waiting for the watcher re-scan the frontmatter write triggers. A
// failure is non-fatal — the next scan retries — so the backlog stays usable.
async function allocateBacklogItemIds(folderPath: string, result: BacklogScanResult): Promise<BacklogScanResult> {
  if (result.items.length === 0) return result
  const allocated = await window.api
    .ensureBacklogItemIds({
      workspaceRoot: folderPath,
      items: result.items.map((item) => ({ relativePath: item.relativePath, numericId: item.numericId ?? null })),
    })
    .catch(() => null)
  if (!allocated?.ok) return result
  const { key, assignments } = allocated
  // Compose the display id for every item that has (or just gained) a numeric id,
  // using the workspace key returned alongside the assignments. Items still
  // awaiting an id (none assignable) are left untouched.
  const items = result.items.map((item) => {
    const minted = assignments?.[item.relativePath]
    const numericId = typeof minted === 'number' ? minted : item.numericId
    if (typeof numericId !== 'number') return item
    return { ...item, numericId, displayId: formatBacklogDisplayId({ key, numericId }) }
  })
  return { ...result, items } as BacklogScanResult
}

let scanRunner: BacklogScanRunner = defaultBacklogScanRunner

function emit(subscription: BacklogScanSubscription): void {
  const snapshot: BacklogScanSnapshot = { scan: subscription.scan, loading: subscription.loading }
  subscription.subscribers.forEach((subscriber) => subscriber(snapshot))
}

function mergeMetadataError(scan: BacklogScanResult, message: string): BacklogScanResult {
  const errors = [...scan.errors, { relativePath: '.multi-code/backlog/items.json', message }]
  return scan.items.length > 0
    ? { state: 'partial', items: scan.items, errors }
    : { state: 'error', items: [], errors }
}

// One scan pass. Commits the result only if this subscription is still the live
// map entry, so a teardown (last unsubscribe) or folder switch mid-scan never
// repopulates a dead entry.
async function performBacklogScan(subscription: BacklogScanSubscription): Promise<BacklogScanResult | null> {
  const key = subscriptionKey(subscription.folderPath)
  subscription.loading = true
  emit(subscription)

  let result: BacklogScanResult
  try {
    result = await scanRunner(subscription.folderPath)
  } catch (error) {
    result = {
      state: 'error',
      items: [],
      errors: [{ relativePath: 'backlog/', message: error instanceof Error ? error.message : String(error) }],
    }
  }

  if (backlogScanSubscriptions.get(key) !== subscription) return subscription.scan

  subscription.scan = result
  subscription.loading = false
  emit(subscription)
  return result
}

function refreshSubscription(subscription: BacklogScanSubscription): Promise<BacklogScanResult | null> {
  if (subscription.refreshPromise) {
    subscription.refreshAgain = true
    return subscription.refreshPromise
  }

  const run = async (): Promise<BacklogScanResult | null> => {
    let latest = await performBacklogScan(subscription)
    while (subscription.refreshAgain) {
      subscription.refreshAgain = false
      latest = await performBacklogScan(subscription)
    }
    return latest
  }

  subscription.refreshPromise = run().finally(() => {
    subscription.refreshPromise = null
  })
  return subscription.refreshPromise
}

// Watch the project's backlog/ directory (scoped, low-noise). Env-guarded so it
// is a no-op without a renderer window (e.g. unit tests). A failure to watch is
// non-fatal: mount + mutation refreshes keep the panel usable, matching Git.
function startBacklogWatch(subscription: BacklogScanSubscription): void {
  if (subscription.watchStarting || subscription.stopWatching) return
  if (typeof window === 'undefined' || typeof window.api?.watchPath !== 'function') return

  const key = subscriptionKey(subscription.folderPath)
  subscription.watchStarting = true
  window.api
    .watchPath(backlogRootPath(subscription.folderPath), () => {
      if (subscription.watchTimer !== null) window.clearTimeout(subscription.watchTimer)
      subscription.watchTimer = window.setTimeout(() => {
        subscription.watchTimer = null
        if (backlogScanSubscriptions.get(key) === subscription) void refreshSubscription(subscription)
      }, BACKLOG_WATCH_DEBOUNCE_MS)
    })
    .then((cleanup) => {
      subscription.watchStarting = false
      // Subscription torn down while the watch was starting: drop the watcher.
      if (backlogScanSubscriptions.get(key) !== subscription) {
        void cleanup()
        return
      }
      subscription.stopWatching = cleanup
    })
    .catch(() => {
      subscription.watchStarting = false
    })
}

function stopBacklogWatch(subscription: BacklogScanSubscription): void {
  if (subscription.watchTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(subscription.watchTimer)
  }
  subscription.watchTimer = null
  if (subscription.stopWatching) {
    void subscription.stopWatching()
    subscription.stopWatching = null
  }
}

function getSubscription(folderPath: string): BacklogScanSubscription {
  const key = subscriptionKey(folderPath)
  const existing = backlogScanSubscriptions.get(key)
  if (existing) return existing

  const subscription: BacklogScanSubscription = {
    folderPath,
    scan: null,
    loading: false,
    subscribers: new Set(),
    refreshPromise: null,
    refreshAgain: false,
    stopWatching: null,
    watchStarting: false,
    watchTimer: null,
  }
  backlogScanSubscriptions.set(key, subscription)
  void refreshSubscription(subscription)
  startBacklogWatch(subscription)
  return subscription
}

function subscribeBacklogScan(folderPath: string, subscriber: BacklogScanSubscriber): () => void {
  const key = subscriptionKey(folderPath)
  const subscription = getSubscription(folderPath)
  subscription.subscribers.add(subscriber)
  // Hand the new subscriber the current snapshot immediately: if a sibling
  // panel already populated this folder, the result is shown with no re-scan.
  subscriber({ scan: subscription.scan, loading: subscription.loading })

  return () => {
    subscription.subscribers.delete(subscriber)
    if (subscription.subscribers.size > 0) return
    stopBacklogWatch(subscription)
    if (backlogScanSubscriptions.get(key) === subscription) backlogScanSubscriptions.delete(key)
  }
}

function refreshSharedBacklogScan(folderPath: string | null): Promise<BacklogScanResult | null> {
  if (!folderPath) return Promise.resolve(null)
  return refreshSubscription(getSubscription(folderPath))
}

export type UseSharedBacklogScanResult = {
  scan: BacklogScanResult | null
  loading: boolean
  refresh: () => Promise<BacklogScanResult | null>
}

export function useSharedBacklogScan(folderPath: string | null): UseSharedBacklogScanResult {
  const [snapshot, setSnapshot] = useState<BacklogScanSnapshot>({ scan: null, loading: Boolean(folderPath) })
  const folderRef = useRef<string | null>(folderPath)
  folderRef.current = folderPath

  const refresh = useCallback(() => refreshSharedBacklogScan(folderRef.current), [])

  useEffect(() => {
    if (!folderPath) {
      setSnapshot({ scan: null, loading: false })
      return
    }
    // Reset to a loading state on folder change; subscribe immediately overrides
    // this with the live (possibly cached) snapshot for the new folder.
    setSnapshot({ scan: null, loading: true })
    return subscribeBacklogScan(folderPath, setSnapshot)
  }, [folderPath])

  return { scan: snapshot.scan, loading: snapshot.loading, refresh }
}

// --- Test-only surface (the hook needs a DOM; these drive the subscription
// layer directly, which is where the dedup/refcount logic lives). ---

export function __resetBacklogScanSubscriptionsForTests(): void {
  backlogScanSubscriptions.forEach((subscription) => stopBacklogWatch(subscription))
  backlogScanSubscriptions.clear()
  scanRunner = defaultBacklogScanRunner
}

// How many distinct project folders currently have a live scan entry.
export function __backlogScanSubscriptionCountForTests(): number {
  return backlogScanSubscriptions.size
}

export function __setBacklogScanRunnerForTests(runner: BacklogScanRunner | null): void {
  scanRunner = runner ?? defaultBacklogScanRunner
}

export const __subscribeBacklogScanForTests = subscribeBacklogScan
export const __refreshSharedBacklogScanForTests = refreshSharedBacklogScan

// Awaits the in-flight scan for a folder without triggering another (unlike
// refresh, which would coalesce a re-scan). Resolves once no scan is pending.
export async function __flushBacklogScanForTests(folderPath: string): Promise<void> {
  for (;;) {
    const subscription = backlogScanSubscriptions.get(subscriptionKey(folderPath))
    if (!subscription?.refreshPromise) return
    await subscription.refreshPromise
  }
}
