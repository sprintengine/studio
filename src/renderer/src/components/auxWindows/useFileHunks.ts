// The open file's hunks, kept in step with the index — git-commit-window T7.
//
// One read (`git:get-file-hunks`) answers both things the window needs: EVERY
// hunk of the file — both sides of the index, each carrying whether it is in
// the index — which are where the gutter boxes go, and the whole file's
// "N differences, M included" counter. It re-runs on the same debounced tick
// `DiffViewer`'s live-content path uses, so the boxes and the text under them
// are always describing the same moment.
//
// The scope is NOT a filter on the boxes. It says which of the two texts Monaco
// is showing, and nothing more: drawing only that diff's hunks made a box
// vanish the instant it was ticked, which left no way to take the hunk back out
// again from this window.
//
// Nothing here caches a line number. Staging one hunk moves every later hunk,
// so a toggle sends git a fingerprint of the hunk's BODY and main finds it
// again in a diff it reads at that instant (`src/main/git-hunks.ts`).

import { useCallback, useEffect, useRef, useState } from 'react'

import type { GitHunkView, HunkInclusionSummary } from '../../../../shared/git/hunks'
import { hunkKey, hunkToggleScope } from '../../../../shared/git/hunks'
import type { DiffFileItem } from './diffFileList'
import {
  hasHunkGutter,
  hunkFileKey,
  OVERRIDE_PENDING_WRITE,
  pinOverride,
  predictedSummary,
  settleOverride,
  type HunkOverride,
} from './hunkGutterModel'

export type FileHunksState = {
  hunks: GitHunkView[]
  summary: HunkInclusionSummary | null
  /** The pending click, if any. `hunkBoxes` folds it into what is drawn. */
  override: HunkOverride | null
  /** git's own words when a toggle — or a read — was refused; null once one
   *  succeeds. */
  error: string | null
  /** Keyed by `hunkKey`, not by index: the union interleaves two diffs and a
   *  toggle renumbers both. */
  toggle: (key: string) => void
}

const EMPTY: GitHunkView[] = []

export function useFileHunks({
  repoRoot,
  item,
  treeRevision,
  refreshGitStatus,
}: {
  repoRoot: string
  item: DiffFileItem | null
  /** Ticks once per completed `git status` read — the cue the tree moved. */
  treeRevision: number
  refreshGitStatus: () => Promise<void>
}): FileHunksState {
  const [hunks, setHunks] = useState<GitHunkView[]>(EMPTY)
  const [summary, setSummary] = useState<HunkInclusionSummary | null>(null)
  const [override, setOverride] = useState<HunkOverride | null>(null)
  const [error, setError] = useState<string | null>(null)

  const key = hunkFileKey(item)
  const supported = hasHunkGutter(item)
  // The two facts the read is made of, as primitives: `item` is a fresh object
  // on every status snapshot, and depending on it would re-read the diff on
  // every tick of the watcher twice over.
  const path = item?.path ?? null
  const kind = item?.kind ?? null

  // One token for every read in flight: whoever started last is the only one
  // allowed to land, exactly as the content loader beside this one works.
  const loadSeqRef = useRef(0)
  // Counts LANDED reads. An override is a prediction about the index made at
  // one of these; the next one supersedes it, right or wrong.
  const revisionRef = useRef(0)
  const [revision, setRevision] = useState(0)
  // Bumped by a toggle so the re-read does not depend on the status watcher
  // having ticked: if it never did, the box would keep its optimistic value.
  const [reloadToken, setReloadToken] = useState(0)
  const busyRef = useRef(false)
  const hunksRef = useRef<GitHunkView[]>(EMPTY)
  hunksRef.current = hunks
  const itemRef = useRef<DiffFileItem | null>(item)
  itemRef.current = item
  // Read inside the toggle to tell "the status refresh moved the tree" from
  // "it did not", without making the callback depend on the number.
  const treeRevisionRef = useRef(treeRevision)
  treeRevisionRef.current = treeRevision

  useEffect(() => {
    if (!path || !supported) {
      loadSeqRef.current += 1
      setHunks(EMPTY)
      setSummary(null)
      setOverride(null)
      return
    }
    loadSeqRef.current += 1
    const token = loadSeqRef.current
    // Which TEXT is on screen. Both diffs are read whichever this is.
    const scope = kind === 'staged' ? 'staged' : 'unstaged'
    void window.api
      .getGitFileHunks(repoRoot, path, scope)
      .then((result) => {
        if (loadSeqRef.current !== token) return
        const landed = revisionRef.current + 1
        revisionRef.current = landed
        setRevision(landed)
        if (!result.ok) {
          // A diff that could not be read is not a file with no changes: keep
          // the counter silent rather than claiming a zero — and SAY why. git's
          // message was dropped here, so a repository that had gone away under
          // the window simply lost its boxes with no word about it.
          setHunks(EMPTY)
          setSummary(null)
          setError(result.message)
        } else {
          setHunks(result.hunks)
          setSummary(result.summary)
          setError(null)
        }
        setOverride((current) => settleOverride(current, key, landed))
      })
      .catch((failure: unknown) => {
        if (loadSeqRef.current !== token) return
        const landed = revisionRef.current + 1
        revisionRef.current = landed
        setRevision(landed)
        setHunks(EMPTY)
        setSummary(null)
        setError(failure instanceof Error ? failure.message : 'Could not read this file\u2019s changes.')
        setOverride((current) => settleOverride(current, key, landed))
      })
    // `key` is `<kind>:<path>`, which is what makes the same file's staged and
    // unstaged diffs two different reads.
  }, [repoRoot, key, path, kind, supported, treeRevision, reloadToken])

  // The file changed. Everything held about the last one goes NOW rather than
  // when the next read lands: a counter cleared a git call late would spend that
  // call showing the previous file's total beside this file's diff, and a
  // prediction about the last file's hunk would be drawn on one of this file's.
  useEffect(() => {
    setHunks(EMPTY)
    setSummary(null)
    setOverride((current) => (current && current.fileKey !== key ? null : current))
    setError(null)
  }, [key])

  const toggle = useCallback(
    (key: string) => {
      const target = itemRef.current
      if (!target || busyRef.current) return
      const hunk = hunksRef.current.find((entry) => hunkKey(entry) === key)
      if (!hunk) return
      const fileKey = hunkFileKey(target)
      if (!fileKey) return

      busyRef.current = true
      setOverride({
        fileKey,
        hunkKey: key,
        checked: !hunk.included,
        // Not `revisionRef.current`: a read that was already in flight when
        // this box was clicked would then land and clear the prediction before
        // git had been asked at all.
        afterRevision: OVERRIDE_PENDING_WRITE,
      })
      const revisionBefore = treeRevisionRef.current
      void (async () => {
        try {
          const ref = {
            repoRoot,
            filePath: target.path,
            // The hunk's OWN diff, not the one on screen. The gutter draws both
            // sides of the index, so an included hunk is a hunk of the staged
            // diff even while the unstaged text is what Monaco is showing —
            // and taking it back out is a reverse-apply of that diff's patch.
            scope: hunkToggleScope(hunk),
            index: hunk.index,
            fingerprint: hunk.fingerprint,
          }
          const result = hunk.included
            ? await window.api.unstageGitHunk(ref)
            : await window.api.stageGitHunk(ref)
          if (!result.ok) {
            // Let the real state win rather than leaving a box that lies.
            setOverride(null)
            setError(result.message ?? result.stderr ?? 'Could not change what is included.')
          } else {
            setError(null)
          }
          // The file list, the file's own box and every other reader of the
          // status hook learn about this the same way they learn about a stage.
          await refreshGitStatus()
        } catch (failure) {
          setOverride(null)
          setError(failure instanceof Error ? failure.message : 'Could not change what is included.')
        } finally {
          busyRef.current = false
          // git has answered; from here the next completed read supersedes the
          // prediction, and this is the read that will.
          setOverride((current) => pinOverride(current, revisionRef.current))
          // ONE re-read, not two. `refreshGitStatus` ticks `treeRevision`,
          // which is already a dependency of the read effect, so bumping the
          // reload token as well ran the same `git diff` pair twice on every
          // click. The bump survives only as the fallback it was meant to be:
          // checked a task later, and taken only if the status refresh moved
          // nothing — otherwise the box would keep its optimistic value for a
          // whole watcher period.
          window.setTimeout(() => {
            if (treeRevisionRef.current === revisionBefore) setReloadToken((value) => value + 1)
          }, 0)
        }
      })()
    },
    [refreshGitStatus, repoRoot]
  )

  // A stale prediction can outlive nothing: if the read that was to supersede
  // it has already landed, it is gone.
  const settled = settleOverride(override, key, revision)

  return {
    hunks: supported ? hunks : EMPTY,
    // The counter carries the pending click too, or it would contradict the box
    // that is already showing it.
    summary: supported ? predictedSummary(summary, settled, key) : null,
    override: settled,
    error,
    toggle,
  }
}
