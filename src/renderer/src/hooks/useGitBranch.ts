import { useEffect, useState } from 'react'

// The current Git branch for a workspace folder, for a header label. The repo
// root is resolved once per folder and the branch is re-read only when main
// says the checkout's refs moved (`watchGitCheckout`, git-repo-watch.ts): a
// branch switch rewrites HEAD, which main watches. There is no timer here; the
// scheduler's own slow fallback covers a change its watcher missed, and it
// holds changes while the app is in the background.
export type GitBranchState = {
  // The current branch name, or null when detached, not yet loaded, or the
  // folder is not inside a Git repository.
  branch: string | null
  // True once we know the folder resolves to a Git repository root.
  isRepo: boolean
}

export function useGitBranch(folderPath: string | null): GitBranchState {
  const [state, setState] = useState<GitBranchState>({ branch: null, isRepo: false })

  useEffect(() => {
    let cancelled = false
    let repoRoot: string | null = null
    let stopWatching: (() => void) | null = null
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
      if (cancelled || typeof window.api.watchGitCheckout !== 'function') return
      stopWatching = window.api.watchGitCheckout(repoRoot, (change) => {
        if (change.kinds.includes('refs')) void loadBranch()
      })
    })()

    return () => {
      cancelled = true
      stopWatching?.()
    }
  }, [folderPath])

  return state
}
