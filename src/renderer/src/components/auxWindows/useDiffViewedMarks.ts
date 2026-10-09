import { useCallback, useEffect, useRef, useState } from 'react'

import type { DiffFileItem } from './diffFileList'
import {
  diffViewedKey,
  fingerprintDiffContent,
  isViewedMarksStorageKey,
  pruneViewedMarks,
  readViewedMarks,
  withViewedMark,
  writeViewedMarks,
  type ViewedMarks,
} from './diffViewedMarks'

type Loadable = Parameters<typeof fingerprintDiffContent>[0]

/** How long the working tree must be still before the marked files are checked again. */
export const VIEWED_CHECK_DELAY_MS = 1_000

/**
 * The viewer's viewed marks for one repository, kept in step with the files.
 *
 * The open file is checked against its mark whenever its content is read. The
 * other marked files are checked when the working tree moves (`revision`):
 * once it has been still a moment, while the viewer is on screen, one file at
 * a time. A file is read again only when its cheap probe (`probe`: the file's
 * size and time on disk, say) moved since it was last checked; one whose diff
 * is no longer the one that was read loses its mark, so the count never claims
 * a changed file.
 */
export function useDiffViewedMarks(input: {
  repoRoot: string | null
  items: readonly DiffFileItem[]
  /** Moves when the working tree does. */
  revision: number
  /** Whether `items` is the repository's real list, not one still loading. */
  ready: boolean
  /**
   * Whether `items` is every changed file, so a mark missing from it names a
   * file that is no longer changed. Not under a filter, a commit step or a
   * tour, whose lists leave out files that still have marks to keep.
   */
  complete: boolean
  /** Whether the viewer is on screen: one out of sight checks nothing. */
  active: boolean
  /** The file on screen, checked as its content is read rather than here. */
  currentKey: string | null
  load: (item: DiffFileItem) => Promise<Loadable>
  /**
   * What says cheaply whether a file may have changed; null when nothing can,
   * and the file is read every time. A commit step's sides are revisions and
   * never change, which the caller says by answering a constant.
   */
  probe: (item: DiffFileItem) => Promise<string | null>
  /** Tests shorten it. */
  delayMs?: number
}): {
  marks: ViewedMarks
  setViewed: (item: DiffFileItem, fingerprint: string | null, viewed: boolean) => void
  /** The open file's content was read: a mark it no longer matches is dropped. */
  noteContent: (item: DiffFileItem, fingerprint: string | null) => void
} {
  const { repoRoot, items, revision, ready, complete, active, currentKey, delayMs = VIEWED_CHECK_DELAY_MS } = input
  const [marks, setMarks] = useState<ViewedMarks>(() => (repoRoot ? readViewedMarks(repoRoot) : {}))
  const marksRef = useRef(marks)
  marksRef.current = marks

  const commit = useCallback(
    (next: ViewedMarks) => {
      if (!repoRoot || next === marksRef.current) return
      marksRef.current = next
      setMarks(next)
      writeViewedMarks(repoRoot, next)
    },
    [repoRoot],
  )

  // The probe each marked file had when it was last checked, by mark key.
  const checkedProbes = useRef(new Map<string, string>())

  // Another diff window over the same repository ticked a file.
  useEffect(() => {
    checkedProbes.current.clear()
    if (!repoRoot) {
      setMarks({})
      return
    }
    setMarks(readViewedMarks(repoRoot))
    const onStorage = (event: StorageEvent) => {
      if (isViewedMarksStorageKey(event.key, repoRoot)) setMarks(readViewedMarks(repoRoot))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [repoRoot])

  const setViewed = useCallback(
    (item: DiffFileItem, fingerprint: string | null, viewed: boolean) => {
      checkedProbes.current.delete(diffViewedKey(item))
      commit(withViewedMark(marksRef.current, item, fingerprint, viewed))
    },
    [commit],
  )

  const noteContent = useCallback(
    (item: DiffFileItem, fingerprint: string | null) => {
      const mark = marksRef.current[diffViewedKey(item)]
      if (fingerprint === null || mark === undefined || mark === fingerprint) return
      commit(withViewedMark(marksRef.current, item, null, false))
    },
    [commit],
  )

  const latest = useRef({ items, currentKey, load: input.load, probe: input.probe })
  latest.current = { items, currentKey, load: input.load, probe: input.probe }

  // One pass at a time. A tick during a pass does not restart it, which on a
  // tree an agent keeps writing to would never finish: it asks for one more
  // pass after this one.
  const running = useRef(false)
  const again = useRef(false)
  const runPass = useCallback(async (): Promise<void> => {
    if (running.current) {
      again.current = true
      return
    }
    running.current = true
    try {
      do {
        again.current = false
        const { items: listed, currentKey: openKey, load, probe } = latest.current
        for (const item of listed) {
          const key = diffViewedKey(item)
          if (key === openKey || marksRef.current[key] === undefined) continue
          const probed = await probe(item).catch(() => null)
          if (probed !== null && checkedProbes.current.get(key) === probed) continue
          const fingerprint = fingerprintDiffContent(await load(item).catch(() => ({ state: 'error' })))
          if (fingerprint === null) continue
          if (marksRef.current[key] !== undefined && marksRef.current[key] !== fingerprint) {
            checkedProbes.current.delete(key)
            commit(withViewedMark(marksRef.current, item, null, false))
          } else if (probed !== null) checkedProbes.current.set(key, probed)
        }
      } while (again.current)
    } finally {
      running.current = false
    }
  }, [commit])

  useEffect(() => {
    if (!repoRoot || !ready || !active) return
    if (complete) commit(pruneViewedMarks(marksRef.current, latest.current.items))
    const timer = setTimeout(() => void runPass(), delayMs)
    return () => clearTimeout(timer)
  }, [repoRoot, ready, complete, active, revision, delayMs, commit, runPass])

  return { marks, setViewed, noteContent }
}
