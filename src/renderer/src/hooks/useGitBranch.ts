import { useEffect, useState } from 'react'

// The current Git branch for a workspace folder, kept fresh enough for a header
// label without a dedicated filesystem watcher. Branch switches are infrequent,
// so we resolve the repo root once per folder and re-read the current branch on
// window focus, tab visibility, and a gentle interval — cheap relative to the
// status watcher in `useGitStatus`, which carries file changes, not the branch.
export type GitBranchState = {
  // The current branch name, or null when detached, not yet loaded, or the
  // folder is not inside a Git repository.
  branch: string | null
  // True once we know the folder resolves to a Git repository root.
  isRepo: boolean
}

const GIT_BRANCH_REFRESH_MS = 20_000

export function useGitBranch(folderPath: string | null): GitBranchState {
  const [state, setState] = useState<GitBranchState>({ branch: null, isRepo: false })

  useEffect(() => {
    let cancelled = false
    let repoRoot: string | null = null
    setState({ branch: null, isRepo: false })

    if (
      !folderPath ||
      typeof window.api.getGitRepoRoot !== 'function' ||
      typeof window.api.getGitBranches !== 'function'
    ) {
      return
    }

    const loadBranch = async (): Promise<void> => {
      if (!repoRoot) return
      try {
        const snapshot = await window.api.getGitBranches(repoRoot)
        if (!cancelled) setState({ branch: snapshot.current, isRepo: true })
      } catch {
        // Transient git failure: keep the last good branch rather than flicker
        // the header indicator off and back on.
      }
    }

    void (async () => {
      try {
        repoRoot = await window.api.getGitRepoRoot(folderPath)
      } catch {
        repoRoot = null
      }
      if (cancelled) return
      if (!repoRoot) {
        // Unversioned folder: leave the header without a git indicator instead
        // of guessing a branch.
        setState({ branch: null, isRepo: false })
        return
      }
      await loadBranch()
    })()

    const refresh = (): void => {
      if (!document.hidden) void loadBranch()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, GIT_BRANCH_REFRESH_MS)

    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(interval)
    }
  }, [folderPath])

  return state
}
