// The horizon's draft + autosave loop (MC-1924), lifted verbatim out of the
// since-retired RoadmapEditorPanel (MC-1926) so the plan column is the ONE
// persistence path. The transforms it drives are the pure engine in roadmapAuthoring.ts;
// this hook owns only the three things that cannot be pure: the baseline/draft
// pair, the debounced write, and the external-change adoption rule.
//
// Autosave, not a Save button: an edit persists itself after a short debounce, a
// save already in flight defers, a failed save never hot-loops, and unmounting
// flushes. That contract is why there is no edit mode (MC-1926) — the drop IS
// the edit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { parseRoadmap, type RoadmapLane, type RoadmapPolicy } from '../../../../shared/backlog/roadmap'
import {
  composeRoadmapSaveContent,
  draftFromRoadmap,
  isDraftDirty,
  type RoadmapDraft,
} from './roadmapAuthoring'

// Long enough to batch a burst of drags into one write, short enough that
// "Saved" is true by the time a person looks away from the row they moved.
export const ROADMAP_AUTOSAVE_DEBOUNCE_MS = 800

// Persist one plan, composing against the CURRENT on-disk bytes rather than the
// possibly-stale baseline string, so frontmatter the scan added out-of-band (the
// id-allocation pass) is never dropped. Takes its target explicitly so a flush
// can write the file the edits were made to, not the one now on screen.
// An unreadable file falls back to the last bytes we knew, never to an empty
// string: composing a plan onto "" would emit a body with no frontmatter at all,
// turning a failed read into a wiped horizon.
async function writePlan(
  path: string,
  baseline: RoadmapDraft,
  draft: RoadmapDraft,
  lastKnownContent: string,
): Promise<string> {
  const current = await window.api.readfile(path).catch(() => lastKnownContent)
  const content = composeRoadmapSaveContent(current, baseline, draft)
  await window.api.writefile(path, content)
  return content
}

/** What the surface shows in place of a Save button. */
export type RoadmapSaveState = 'saved' | 'saving' | 'pending' | 'failed'

export type RoadmapPlanDraft = {
  /** The author's working copy — what the plan column renders. */
  draft: RoadmapDraft
  /** The last-persisted plan, for dirty comparison. */
  baseline: RoadmapDraft
  dirty: boolean
  saving: boolean
  saveError: string | null
  /** The one readout the bar shows (MC-1926 replaced the mode with this). */
  saveState: RoadmapSaveState
  update: (next: (current: RoadmapDraft) => RoadmapDraft) => void
  setLanes: (next: RoadmapLane[]) => void
  setPolicy: (patch: Partial<RoadmapPolicy>) => void
  /** Force a write now (the explicit "Try again" after a failure). */
  save: () => Promise<void>
}

export function useRoadmapPlanDraft({
  path,
  relativePath,
  sourceContent,
  onSaved,
}: {
  /** Absolute path of the horizon file — the write target. */
  path: string
  /** Project-relative path; a change means a different horizon entirely. */
  relativePath: string
  /** The file's bytes as the scan last read them (the baseline source). */
  sourceContent: string
  /** Persisted successfully — the host re-scans and re-reads. */
  onSaved: (content: string) => void
}): RoadmapPlanDraft {
  // Baseline = the parsed on-disk horizon; draft = the working copy. The
  // baseline CONTENT string is the byte source a save composes against.
  const [baseline, setBaseline] = useState<RoadmapDraft>(() => draftFromRoadmap(parseRoadmap(sourceContent)))
  const [draft, setDraft] = useState<RoadmapDraft>(baseline)
  const baselineContentRef = useRef<string>(sourceContent)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const dirty = isDraftDirty(baseline, draft)

  // Adopt an external file change only when there are no unsaved edits: a scan
  // re-read (the id-allocation pass stamping `id:`, a sibling edit, the
  // orchestrator advancing a lane) refreshes the baseline in place. While dirty
  // the working copy is kept — a save re-reads the current bytes, so nothing the
  // scan added out-of-band is clobbered.
  useEffect(() => {
    if (sourceContent === baselineContentRef.current) return
    if (dirty) return
    const nextBaseline = draftFromRoadmap(parseRoadmap(sourceContent))
    baselineContentRef.current = sourceContent
    setBaseline(nextBaseline)
    setDraft(nextBaseline)
    setSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content; `dirty` is read as a guard, not a trigger
  }, [relativePath, sourceContent])

  // What a pending write needs, captured so a save can target the file the edits
  // were made to even after the surface has moved on to another horizon.
  const pendingRef = useRef({ path, baseline, draft, dirty })
  pendingRef.current = { path, baseline, draft, dirty }

  // A different horizon file entirely. The hook stays MOUNTED across a rail
  // switch, so the unmount flush cannot cover this: flush the outgoing file's
  // unsaved edits against ITS OWN path first, then adopt the new one. Without
  // this, dragging a step and switching horizons inside the autosave debounce
  // silently discarded the drag.
  const lastPathRef = useRef(relativePath)
  useEffect(() => {
    if (lastPathRef.current === relativePath) return
    lastPathRef.current = relativePath
    const outgoing = pendingRef.current
    const outgoingContent = baselineContentRef.current
    if (outgoing.dirty && outgoing.path) {
      void writePlan(outgoing.path, outgoing.baseline, outgoing.draft, outgoingContent)
    }
    const nextBaseline = draftFromRoadmap(parseRoadmap(sourceContent))
    baselineContentRef.current = sourceContent
    setBaseline(nextBaseline)
    setDraft(nextBaseline)
    setSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content and the outgoing draft are read at switch time, never triggers
  }, [relativePath])

  const update = useCallback(
    (next: (current: RoadmapDraft) => RoadmapDraft) => setDraft((current) => next(current)),
    [],
  )
  const setLanes = useCallback((next: RoadmapLane[]) => setDraft((d) => ({ ...d, lanes: next })), [])
  const setPolicy = useCallback(
    (patch: Partial<RoadmapPolicy>) => setDraft((d) => ({ ...d, policy: { ...d.policy, ...patch } })),
    [],
  )

  // A failed autosave must not hot-loop: remember the draft that failed and only
  // retry once the author edits again (or hits the explicit "Try again").
  const lastFailedDraftRef = useRef<RoadmapDraft | null>(null)

  const save = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const content = await writePlan(path, baseline, draft, baselineContentRef.current)
      baselineContentRef.current = content
      lastFailedDraftRef.current = null
      setBaseline(draft)
      onSaved(content)
    } catch (error) {
      lastFailedDraftRef.current = draft
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [baseline, draft, onSaved, path])

  const saveRef = useRef(save)
  saveRef.current = save
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const savingRef = useRef(saving)
  savingRef.current = saving

  useEffect(() => {
    if (!dirty || saving) return
    if (saveError && lastFailedDraftRef.current === draft) return
    const timer = setTimeout(() => void saveRef.current(), ROADMAP_AUTOSAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [dirty, draft, saving, saveError])

  // Flush on unmount (back, door close, workspace switch) so navigating away
  // never discards edits. Fire-and-forget: the component is gone either way.
  useEffect(
    () => () => {
      if (dirtyRef.current && !savingRef.current) void saveRef.current()
    },
    [],
  )

  const saveState: RoadmapSaveState = saveError ? 'failed' : saving ? 'saving' : dirty ? 'pending' : 'saved'

  return useMemo(
    () => ({ draft, baseline, dirty, saving, saveError, saveState, update, setLanes, setPolicy, save }),
    [draft, baseline, dirty, saving, saveError, saveState, update, setLanes, setPolicy, save],
  )
}
