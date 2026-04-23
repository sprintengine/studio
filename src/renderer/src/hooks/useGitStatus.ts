import { useCallback, useEffect, useRef, useState } from 'react'

type UseGitStatusResult = {
  repoRoot: string | null
  status: GitStatusSnapshot | null
  refresh: () => Promise<void>
}

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

function getStatusSignature(snapshot: GitStatusSnapshot | null): string {
  if (!snapshot) return ''
  return Object.values(snapshot.files)
    .map((entry) => `${entry.relativePath}:${entry.status}:${entry.staged ? '1' : '0'}:${entry.unstaged ? '1' : '0'}`)
    .sort()
    .join('|')
}

export function useGitStatus(rootPath: string | null): UseGitStatusResult {
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null)
  const repoRootRef = useRef<string | null>(null)
  const refreshTimerRef = useRef<number | null>(null)
  const statusSignatureRef = useRef('')

  const applyStatus = useCallback((nextStatus: GitStatusSnapshot | null) => {
    const normalized = nextStatus ? normalizeStatusSnapshot(nextStatus) : null
    const nextSignature = getStatusSignature(normalized)
    if (nextSignature === statusSignatureRef.current) return

    statusSignatureRef.current = nextSignature
    setStatus(normalized)
  }, [])

  const refresh = useCallback(async () => {
    const currentRepoRoot = repoRootRef.current
    if (!currentRepoRoot || typeof window.api.getGitStatus !== 'function') return

    try {
      applyStatus(await window.api.getGitStatus(currentRepoRoot))
    } catch {
      applyStatus(null)
    }
  }, [applyStatus])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current)
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      void refresh()
    }, 250)
  }, [refresh])

  useEffect(() => {
    let cancelled = false

    repoRootRef.current = null
    statusSignatureRef.current = ''
    setRepoRoot(null)
    setStatus(null)

    if (!rootPath) return
    if (typeof window.api.getGitRepoRoot !== 'function' || typeof window.api.getGitStatus !== 'function') return

    window.api.getGitRepoRoot(rootPath)
      .then(async (nextRepoRoot) => {
        if (cancelled) return
        repoRootRef.current = nextRepoRoot
        setRepoRoot(nextRepoRoot)
        if (nextRepoRoot) {
          try {
            applyStatus(await window.api.getGitStatus(nextRepoRoot))
          } catch {
            applyStatus(null)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          repoRootRef.current = null
          statusSignatureRef.current = ''
          setRepoRoot(null)
          setStatus(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [applyStatus, rootPath])

  useEffect(() => {
    if (!repoRoot) return
    if (typeof window.api.watchPath !== 'function') return

    let disposed = false
    let unsubscribe: (() => Promise<void>) | undefined

    window.api.watchPath(repoRoot, scheduleRefresh)
      .then((cleanup) => {
        if (disposed) {
          void cleanup()
          return
        }
        unsubscribe = cleanup
      })
      .catch(() => {
        // Git status still works without watch support; manual refreshes keep it usable.
      })

    return () => {
      disposed = true
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      if (unsubscribe) {
        void unsubscribe()
      }
    }
  }, [repoRoot, scheduleRefresh])

  return { repoRoot, status, refresh }
}
