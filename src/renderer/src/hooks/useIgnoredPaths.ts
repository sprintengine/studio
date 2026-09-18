import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizePathKey } from './useGitStatus'

// Which rows in the tree git would ignore, so the explorer can drop them to a
// lower contrast. A build output tree is not something you are looking for, and
// dimming it is cheaper to read past than a colour that has to be decoded.
//
// The answer comes from `git check-ignore` in main rather than from parsing
// .gitignore here, because the real rule stack is nested ignore files at every
// depth plus info/exclude plus the user's global excludesFile. Asking git is
// the only way to be right.
//
// Batched PER DIRECTORY, because the tree loads that way: one spawn when a
// folder is first expanded, its answer cached for as long as the root and the
// refresh token hold. The alternative — `git status --ignored` over the repo —
// enumerates every file inside node_modules to answer a question about twelve
// visible rows.

type IgnoredPaths = {
  /** Is this absolute path ignored? False until its directory has been checked. */
  isIgnored: (path: string) => boolean
  /** Check a directory's entries, once. Safe to call on every load; repeats are dropped. */
  checkDirectory: (dirPath: string, absolutePaths: string[]) => void
}

function toRelative(repoRoot: string, absolutePath: string): string | null {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const path = absolutePath.replace(/\\/g, '/')
  if (!path.startsWith(`${root}/`)) return null
  return path.slice(root.length + 1)
}

export function useIgnoredPaths(repoRoot: string | null, refreshToken: number): IgnoredPaths {
  const [ignoredKeys, setIgnoredKeys] = useState<ReadonlySet<string>>(() => new Set())
  const checkedDirectories = useRef<Set<string>>(new Set())
  // Every directory the tree has shown us, kept so a check can be RE-run.
  // Load order is the reason this exists: the root directory lists before the
  // git status snapshot resolves a repo root, so the first — and, for a folder
  // nobody collapses and reopens, the only — offer of the root's entries
  // arrives while there is nothing to ask. Without a replay the top level of
  // every tree stayed undimmed.
  const offeredDirectories = useRef<Map<string, string[]>>(new Map())
  // The generation guards against a reply landing after the root changed or the
  // tree was refreshed: without it, a slow answer for the previous repo would
  // dim rows in the new one.
  const generationRef = useRef(0)
  const runCheckRef = useRef<(dirPath: string, absolutePaths: string[]) => void>(() => {})

  const checkDirectory = useCallback((dirPath: string, absolutePaths: string[]) => {
    if (absolutePaths.length === 0) return
    offeredDirectories.current.set(dirPath, absolutePaths)
    runCheckRef.current(dirPath, absolutePaths)
  }, [])

  const runCheck = useCallback(
    (dirPath: string, absolutePaths: string[]) => {
      if (!repoRoot) return
      if (checkedDirectories.current.has(dirPath)) return
      checkedDirectories.current.add(dirPath)

      const generation = generationRef.current
      const relativeByPath = new Map<string, string>()
      for (const absolutePath of absolutePaths) {
        const relative = toRelative(repoRoot, absolutePath)
        // A path outside the repo (a symlinked folder, a root that is not the
        // repo root) has no ignore answer; leaving it out is what makes it
        // render at full strength rather than at random.
        if (relative) relativeByPath.set(relative, absolutePath)
      }
      if (relativeByPath.size === 0) return

      void window.api
        .checkIgnored(repoRoot, Array.from(relativeByPath.keys()))
        .then((ignoredRelative) => {
          if (generation !== generationRef.current || ignoredRelative.length === 0) return
          setIgnoredKeys((current) => {
            const next = new Set(current)
            for (const relative of ignoredRelative) {
              const absolutePath = relativeByPath.get(relative)
              if (absolutePath) next.add(normalizePathKey(absolutePath))
            }
            return next
          })
        })
        .catch(() => {
          // A failed check means "nothing ignored here", which is what the
          // empty set already says. Let the directory be re-checked, though —
          // the failure may have been a transient one.
          checkedDirectories.current.delete(dirPath)
        })
    },
    [repoRoot],
  )

  runCheckRef.current = runCheck

  // A new repo root (or a manual refresh) drops every answer and asks again for
  // each directory the tree has shown, which is also what finally answers the
  // ones offered before there was a root to ask.
  useEffect(() => {
    generationRef.current += 1
    checkedDirectories.current = new Set()
    setIgnoredKeys(new Set())
    for (const [dirPath, absolutePaths] of offeredDirectories.current) {
      runCheck(dirPath, absolutePaths)
    }
  }, [repoRoot, refreshToken, runCheck])

  const isIgnored = useCallback((path: string) => ignoredKeys.has(normalizePathKey(path)), [ignoredKeys])

  return { isIgnored, checkDirectory }
}
