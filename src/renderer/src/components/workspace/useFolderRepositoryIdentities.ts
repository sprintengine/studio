import { useEffect, useRef, useState } from 'react'

import type { RepositoryIdentity, RepositoryIdentityRead } from '../../../../shared/repository-identity'

// Which repository each local folder is a clone of (one-project-across-
// machines): the sidebar files a paired machine's copy of a repository under
// the local folder that is the same repository, and the launch panel offers a
// project once and asks "which machine has it". Main reads the identity off
// `git remote` and caches it; this hook asks once per folder it is shown and
// keeps the ANSWERS for the component's life — a remote URL changes about
// never, and a folder that is not a repository stays not one.
//
// Keys are the folder path normalised the way the sidebar keys its groups, so
// two spellings of one folder are one entry. What the map holds is answers
// only: a folder that was asked and is not a repository is present with `null`,
// and a folder whose question has not been ANSWERED — not asked yet, or asked
// and the read could not be made — is absent.
//
// That distinction exists for one caller. Grouping treats absent and null the
// same ("no identity", group by path), but the project-colour allocator
// (2026-09-09) waits for the answer before giving a project a hue: a folder
// coloured under its path key and then re-keyed to its repository would spend
// two of the six hues on one project and visibly change colour a moment after
// the window opened. A read that could not be made is therefore NOT recorded as
// "no remote" — a spun-down volume would otherwise be given a `folder:` hue
// now and a `repo:` one the next time it was awake.
//
// Two consequences follow, and both are here rather than at the call site:
//
//  * A window with no reader at all (a preload that predates it, a test harness
//    with a narrower api) answers `null` for every folder. An open question
//    that can never be answered would hold every project colourless for ever,
//    which is worse than the path key it would have got anyway.
//  * A read that did not settle is re-asked, a few times, on a timer that
//    matches main's own retry window. Without it the folder would stay absent
//    for the component's life — the hook asks once per folder — and a volume
//    that woke up a second later would never be noticed.

export type FolderIdentityMap = ReadonlyMap<string, RepositoryIdentity | null>

// Main holds an unsettled read for RETRY_AFTER_FAILURE_MS (10s) and re-reads
// after that, so asking sooner would only be served the same cached non-answer.
const RETRY_UNSETTLED_AFTER_MS = 10_000
// Bounded: a folder on a volume that is not coming back must not have this rail
// asking about it for the life of the window.
const MAX_UNSETTLED_ASKS = 3

export function folderIdentityKey(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * What the reader answered, from either shape it can answer in.
 *
 * A preload that predates `RepositoryIdentityRead` — and the test harnesses
 * that stub this api — hand back the identity itself, which is the settled
 * answer it always was. The envelope is told apart by its own `settled` field;
 * a `RepositoryIdentity` has no such member.
 */
function readAnswerOf(value: unknown): RepositoryIdentityRead {
  if (value && typeof value === 'object' && 'settled' in value) {
    const envelope = value as { identity?: RepositoryIdentity | null; settled?: unknown }
    return { identity: envelope.identity ?? null, settled: envelope.settled === true }
  }
  return { identity: (value as RepositoryIdentity | null) ?? null, settled: true }
}

export function useFolderRepositoryIdentities(folderPaths: ReadonlyArray<string | null | undefined>): FolderIdentityMap {
  const [identities, setIdentities] = useState<Map<string, RepositoryIdentity | null>>(() => new Map())
  // How many times each folder has been asked and not answered. A ref, not
  // state: it must not itself cause a render, and the timer below is what
  // schedules the next attempt.
  const unsettledAsks = useRef(new Map<string, number>())
  const [retryRound, setRetryRound] = useState(0)
  // A stable string of the folders asked about, so the effect re-runs when
  // the set changes and not when the array is rebuilt with the same members.
  const wanted = [...new Set(folderPaths.flatMap((path) => (path?.trim() ? [path.trim()] : [])))].sort()
  const wantedKey = wanted.join('\n')
  useEffect(() => {
    const read = window.api?.getGitRepositoryIdentity
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const missing = wanted.filter((path) => !identities.has(folderIdentityKey(path)))
    if (missing.length === 0) return
    // A window whose preload predates the reader (or a test harness that stubs
    // a narrower api) simply has no identities: every folder groups by path.
    // Recorded as a null ANSWER, not left unasked — see the note above.
    if (typeof read !== 'function') {
      setIdentities((current) => {
        const next = new Map(current)
        for (const path of missing) next.set(folderIdentityKey(path), null)
        return next
      })
      return
    }
    void Promise.all(
      missing.map(async (path) => {
        // A read that threw did not settle either: the folder stays absent and
        // is asked again, rather than being written down as "no remote".
        const answer = await read(path).then(readAnswerOf, () => ({ identity: null, settled: false }))
        return [folderIdentityKey(path), answer] as const
      })
    ).then((entries) => {
      if (cancelled) return
      const settled = entries.filter(([, answer]) => answer.settled)
      const unsettled = entries.filter(([, answer]) => !answer.settled)
      for (const [key] of unsettled) {
        unsettledAsks.current.set(key, (unsettledAsks.current.get(key) ?? 0) + 1)
      }
      if (settled.length > 0) {
        setIdentities((current) => {
          const next = new Map(current)
          for (const [key, answer] of settled) next.set(key, answer.identity)
          return next
        })
      }
      const worthRetrying = unsettled.some(
        ([key]) => (unsettledAsks.current.get(key) ?? 0) < MAX_UNSETTLED_ASKS
      )
      if (worthRetrying) {
        retryTimer = setTimeout(() => setRetryRound((round) => round + 1), RETRY_UNSETTLED_AFTER_MS)
      }
    })
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
    // `identities` is read for the missing set only; re-running on its change
    // would loop on the write it just made. `retryRound` is the re-ask above.
  }, [wantedKey, retryRound])
  return identities
}
