import type { BacklogScanSnapshot } from '../hooks/useSharedBacklogScan'
import type { BacklogItem, BacklogScanResult } from '../utils/backlog'
import type { BacklogReader } from './renderer-host'

// The backlog module's implementation of the kernel's BacklogReader seam:
// module renderers list/watch Backlog items through the SAME shared scan the
// BacklogPanel uses (one scan + one watcher per project root — never a second
// pipeline). Dependencies are injected so the module wiring can resolve the
// workspace store lazily (keeping it out of the eager module-registry graph)
// and tests can drive the reader with a fake subscription layer.

export type BacklogReaderSubscribeOptions = {
  /** Skip the filesystem watcher for one-shot reads (list) on cold folders. */
  startWatcher?: boolean
}

export type BacklogReaderDeps = {
  /** workspaceId → project folder, from the workspace store. */
  resolveFolderPath(workspaceId: string): Promise<string | null>
  /** The shared scan subscription (useSharedBacklogScan's subscribeBacklogScan). */
  subscribe(
    folderPath: string,
    cb: (snapshot: BacklogScanSnapshot) => void,
    options?: BacklogReaderSubscribeOptions
  ): () => void
}

// Modules get their own copy, never the live array the shared subscription
// holds and the Backlog panel renders — the SDK documents these as read-only
// views, and a module sort/splice/field write must not corrupt sibling
// consumers. Scan items are plain parsed data, so structuredClone is safe.
function copyItems(scan: BacklogScanResult): BacklogItem[] {
  return structuredClone(scan.items)
}

export function createBacklogReader(deps: BacklogReaderDeps): BacklogReader {
  return {
    async list(workspaceId) {
      const folderPath = await deps.resolveFolderPath(workspaceId)
      if (!folderPath) {
        throw new Error(`Workspace "${workspaceId}" has no project folder, so it has no Backlog.`)
      }
      // One-shot ride on the shared subscription: the immediate snapshot when a
      // sibling consumer already populated this folder, otherwise the first
      // settled scan. Unsubscribes as soon as it resolves, and skips spinning
      // up the filesystem watcher on cold folders (a watcher created for one
      // microtask is pure IPC churn).
      return new Promise<BacklogItem[]>((resolve, reject) => {
        let settled = false
        let unsubscribe: (() => void) | null = null
        const done = (): void => {
          const off = unsubscribe
          unsubscribe = null
          off?.()
        }
        unsubscribe = deps.subscribe(
          folderPath,
          (snapshot) => {
            if (settled || snapshot.loading || !snapshot.scan) return
            settled = true
            if (snapshot.scan.state === 'error') {
              // An unreadable backlog directory must not look like an empty
              // backlog; the first scan error names the cause.
              const cause = snapshot.scan.errors[0]
              reject(new Error(
                `The Backlog for "${workspaceId}" could not be read${cause ? `: ${cause.relativePath}: ${cause.message}` : '.'}`
              ))
            } else {
              resolve(copyItems(snapshot.scan))
            }
            // The immediate-snapshot call happens synchronously, before
            // `subscribe` has returned the unsubscriber — defer in that case.
            queueMicrotask(done)
          },
          { startWatcher: false }
        )
        if (settled) done()
      })
    },

    watch(workspaceId, cb) {
      let disposed = false
      let unsubscribe: (() => void) | null = null
      // Folder resolution is async (lazy store import); the subscription starts
      // as soon as it lands unless the caller already unsubscribed. There is no
      // error channel on a watch, so resolution failures are surfaced as
      // console diagnostics instead of a silently dead subscription.
      deps.resolveFolderPath(workspaceId)
        .then((folderPath) => {
          if (disposed) return
          if (!folderPath) {
            console.error(
              `[backlog] watchBacklogItems: workspace "${workspaceId}" has no project folder — this watch will never fire.`
            )
            return
          }
          unsubscribe = deps.subscribe(folderPath, (snapshot) => {
            // Emit only settled, readable scans: subscribers never see a
            // half-scan, and a failed scan is not deliverable as "no items".
            if (snapshot.loading || !snapshot.scan) return
            if (snapshot.scan.state === 'error') {
              console.warn(
                `[backlog] watchBacklogItems: the Backlog for "${workspaceId}" could not be read; skipping this update.`
              )
              return
            }
            cb(copyItems(snapshot.scan))
          })
          if (disposed) {
            unsubscribe()
            unsubscribe = null
          }
        })
        .catch((error) => {
          console.error(
            `[backlog] watchBacklogItems: resolving workspace "${workspaceId}" failed — this watch will never fire.`,
            error
          )
        })
      return () => {
        disposed = true
        unsubscribe?.()
        unsubscribe = null
      }
    },
  }
}
