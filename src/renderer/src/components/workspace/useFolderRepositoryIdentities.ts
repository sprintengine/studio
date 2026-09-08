import { useEffect, useState } from 'react'

import type { RepositoryIdentity } from '../../../../shared/repository-identity'

// Which repository each local folder is a clone of (one-project-across-
// machines): the sidebar files a paired machine's copy of a repository under
// the local folder that is the same repository, and the launch panel offers a
// project once and asks "which machine has it". Main reads the identity off
// `git remote` and caches it; this hook asks once per folder it is shown and
// keeps the answers for the component's life — a remote URL changes about
// never, and a folder that is not a repository stays not one.
//
// Keys are the folder path normalised the way the sidebar keys its groups, so
// two spellings of one folder are one entry. A folder whose identity is not
// yet read is simply absent from the map — callers treat absent and null the
// same: "no identity", group by path.

export type FolderIdentityMap = ReadonlyMap<string, RepositoryIdentity | null>

export function folderIdentityKey(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

export function useFolderRepositoryIdentities(folderPaths: ReadonlyArray<string | null | undefined>): FolderIdentityMap {
  const [identities, setIdentities] = useState<Map<string, RepositoryIdentity | null>>(() => new Map())
  // A stable string of the folders asked about, so the effect re-runs when
  // the set changes and not when the array is rebuilt with the same members.
  const wanted = [...new Set(folderPaths.flatMap((path) => (path?.trim() ? [path.trim()] : [])))].sort()
  const wantedKey = wanted.join('\n')
  useEffect(() => {
    // A window whose preload predates the reader (or a test harness that stubs
    // a narrower api) simply has no identities: every folder groups by path.
    const read = window.api?.getGitRepositoryIdentity
    if (typeof read !== 'function') return
    let cancelled = false
    const missing = wanted.filter((path) => !identities.has(folderIdentityKey(path)))
    if (missing.length === 0) return
    void Promise.all(
      missing.map(async (path) => {
        // A read that threw is not an answer: the folder stays unasked, so
        // the next change to the set asks again rather than holding "no
        // remote" for the sidebar's life. Null from a completed read IS an
        // answer (not a repo, or no remote).
        const identity = await read(path).then((value) => ({ value }), () => null)
        return [folderIdentityKey(path), identity] as const
      })
    ).then((entries) => {
      if (cancelled) return
      setIdentities((current) => {
        const next = new Map(current)
        for (const [key, answer] of entries) {
          if (answer) next.set(key, answer.value)
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // `identities` is read for the missing set only; re-running on its change
    // would loop on the write it just made.
  }, [wantedKey])
  return identities
}
