// Workspace file watch for module renderers (RendererHost.watchWorkspaceFile):
// the seam over the shell's fs watch plumbing that runStateSynchronizer
// already rides. Ports are injected so the contract is unit-testable without
// window.api; modules/index wires the real backends at boot.
//
// Semantics (mirrors the Backlog watcher where the medium allows):
// - fires once with the current content (null when the file doesn't exist),
//   then debounced (~300ms) on every change;
// - the watched path is workspace-relative and must stay inside the
//   workspace root — absolute paths and traversal reject with a named cause;
// - resolution failures (unknown workspace, folderless workspace) reject with
//   a named cause, never a silent no-op;
// - the resolved unsubscribe closure tears down the fs watcher.

import { watchEventPaths } from '../../../shared/file-watch-event'

export type WorkspaceFileWatchEvent = {
  relativePath: string
  /** File content after the change; null when the file does not exist. */
  content: string | null
}

type WatchPortEvent = { path?: string | null; paths?: string[]; overflow?: boolean }

export type WorkspaceFileWatchPorts = {
  resolveFolderPath: (workspaceId: string) => string | null
  watchPath: (path: string, cb: (event: WatchPortEvent) => void) => Promise<() => Promise<void> | void>
  readFile: (path: string) => Promise<string>
  /** Injectable for tests; defaults to setTimeout/clearTimeout. */
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 300

// Reject separators that escape the workspace and Windows-style absolutes.
function validateRelativePath(relativePath: string): string | null {
  if (relativePath.trim().length === 0) return 'relativePath must be a non-empty workspace-relative path.'
  if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith('\\')) {
    return `relativePath must be workspace-relative, got an absolute path: ${relativePath}`
  }
  const segments = relativePath.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    return `relativePath must stay inside the workspace root: ${relativePath}`
  }
  return null
}

export type WorkspaceFileWatcher = (
  workspaceId: string,
  relativePath: string,
  cb: (event: WorkspaceFileWatchEvent) => void,
) => Promise<() => void>

export function createWorkspaceFileWatcher(ports: WorkspaceFileWatchPorts): WorkspaceFileWatcher {
  const debounceMs = ports.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const setTimer = ports.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer = ports.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))

  return async (workspaceId, relativePath, cb) => {
    const pathIssue = validateRelativePath(relativePath)
    if (pathIssue) throw new Error(pathIssue)
    const folderPath = ports.resolveFolderPath(workspaceId)
    if (!folderPath) {
      throw new Error(
        `Workspace "${workspaceId}" has no project folder to watch (unknown, folderless, or not resolvable yet).`,
      )
    }
    const separator = folderPath.includes('\\') && !folderPath.includes('/') ? '\\' : '/'
    const absolutePath = `${folderPath.replace(/[\\/]+$/, '')}${separator}${relativePath}`
    const fileName = relativePath.split(/[\\/]+/).pop() ?? relativePath

    let disposed = false
    let debounce: unknown = null
    let stopWatching: (() => Promise<void> | void) | null = null

    const emit = async (): Promise<void> => {
      let content: string | null
      try {
        content = await ports.readFile(absolutePath)
      } catch {
        content = null
      }
      if (disposed) return
      try {
        cb({ relativePath, content })
      } catch (error) {
        // A throwing module callback must not break the watch loop.
        console.error('[modules] workspace file watch callback threw:', error)
      }
    }

    // Exact-path match with a separator boundary — `state/loop.json` must not
    // fire for `state/other-loop.json` or `nested/state/loop.json` siblings a
    // bare name-suffix check would catch.
    const matchesWatchedFile = (eventPath: string | null | undefined): boolean => {
      if (!eventPath) return true // watcher backends may omit the path; re-read rather than miss a change
      if (eventPath === absolutePath || eventPath === relativePath) return true
      return eventPath.endsWith(`/${fileName}`) || eventPath.endsWith(`\\${fileName}`)
        ? eventPath === absolutePath ||
            eventPath.endsWith(`/${relativePath}`) ||
            eventPath.endsWith(`\\${relativePath.replace(/\//g, '\\')}`)
        : false
    }

    const onWatchEvent = (event: WatchPortEvent): void => {
      if (disposed) return
      // A burst names every path it touched; the watched file is one of them
      // or it is not. A burst that names none is read as a possible change.
      const paths = watchEventPaths({ path: event.path ?? null, paths: event.paths, overflow: event.overflow })
      if (paths !== null && !paths.some((path) => matchesWatchedFile(path))) return
      if (debounce !== null) clearTimer(debounce)
      debounce = setTimer(() => {
        debounce = null
        void emit()
      }, debounceMs)
    }

    // Watch the file's containing directory (the file itself may not exist
    // yet). When THAT directory doesn't exist either, fall back to the
    // nearest existing ancestor (ultimately the workspace root, which does)
    // and re-attempt the deeper attach whenever the ancestor changes — the
    // watch must deliver its `content: null` snapshot and later recover once
    // the directory is created, never die on setup.
    const directoryPath = absolutePath.split(/[\\/]/).slice(0, -1).join(separator) || folderPath
    const ancestorsToTry: string[] = []
    {
      let candidate = directoryPath
      const rootNormalized = folderPath.replace(/[\\/]+$/, '')
      while (candidate.length >= rootNormalized.length) {
        ancestorsToTry.push(candidate)
        if (candidate === rootNormalized) break
        candidate = candidate.split(/[\\/]/).slice(0, -1).join(separator)
      }
      if (ancestorsToTry[ancestorsToTry.length - 1] !== rootNormalized) ancestorsToTry.push(rootNormalized)
    }

    let attachedPath: string | null = null
    const attach = async (): Promise<void> => {
      for (const candidate of ancestorsToTry) {
        try {
          const stop = await ports.watchPath(candidate, (event) => {
            onWatchEvent(event)
            // Attached to an ancestor: any activity may mean the target
            // directory now exists — try to move the watch deeper.
            if (attachedPath !== directoryPath) void reattach()
          })
          if (disposed) {
            void stop()
            return
          }
          attachedPath = candidate
          stopWatching = stop
          return
        } catch {
          // Try the next ancestor.
        }
      }
    }
    let reattaching = false
    const reattach = async (): Promise<void> => {
      if (reattaching || disposed || attachedPath === directoryPath) return
      reattaching = true
      try {
        const stop = await ports.watchPath(directoryPath, onWatchEvent)
        if (disposed) {
          void stop()
          return
        }
        if (stopWatching) void stopWatching()
        stopWatching = stop
        attachedPath = directoryPath
      } catch {
        // Directory still absent — keep the ancestor watch.
      } finally {
        reattaching = false
      }
    }
    await attach()

    // Initial snapshot after the watcher attaches, so no change can land in
    // the gap between snapshot and subscription.
    await emit()

    return () => {
      disposed = true
      if (debounce !== null) {
        clearTimer(debounce)
        debounce = null
      }
      if (stopWatching) {
        void stopWatching()
        stopWatching = null
      }
    }
  }
}
