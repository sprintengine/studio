import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  GhostButton,
  IconButton,
  InlineNotice,
  Popover,
  PrimaryButton,
  SegmentedControl,
  StatusDot,
  Tooltip,
  TruncatedText,
  useConfirmDialog,
} from '../ui'
import type { Tone } from '../ui/tokens'
import type { BacklogItem } from '../../utils/backlog'
import {
  nextEligible,
  validateRoadmap,
  parseRoadmap,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapLane,
  type RoadmapLaneReason,
  type RoadmapPolicy,
} from '../../../../shared/backlog/roadmap'
import { BACKLOG_STATUS_LABEL } from './BacklogRow'
import { BacklogItemSearchPicker } from './BacklogItemSearchPicker'
import {
  addLane,
  addLibraryEntry,
  authoredRef,
  buildRoadmapLibrary,
  composeRoadmapSaveContent,
  draftFromRoadmap,
  entryPickerOptionsMulti,
  epicEntryDrift,
  isDraftDirty,
  mergeLaneDown,
  moveEntry,
  refDisplayMapMulti,
  removeEntry,
  removeLane,
  renameLane,
  resyncEpicEntry,
  roadmapItemStatesMulti,
  splitAuthoredRef,
  splitLane,
  type RoadmapDraft,
  type RoadmapLibraryEntry,
  type RoadmapLibraryGroup,
  type RoadmapProjectItems,
  type RoadmapRefDisplay,
} from './roadmapAuthoring'
import type { ProjectKey } from '../../../../shared/backlog/roadmap'

// The roadmap authoring surface (MC-1618 / T4). It replaces the plain backlog
// detail body when the selected item is a roadmap, turning the file's markdown
// tracks into a direct-manipulation editor: add steps from the reused backlog
// picker, drag or key them into order, split and merge tracks, and set the
// execution policy. Save writes back through the T3 canonical serializers — a
// policy-only edit preserves the body byte-for-byte; a structural edit re-emits
// the canonical body under the same frontmatter.
//
// The referenced mockup (mockups/2026-07-15-roadmap-builder-multi-repo.html) is
// ABSENT from the repo; this UI is built against the item's §1 textual spec and
// the house style (overlay scrims, plain-human copy, no per-step accent chrome).

// No live run context exists at authoring time, so the eligibility preview reads
// terminal status as "delivered" (the shared function's shared/manual-run branch)
// rather than a PR-merge signal. That is the honest authoring-time frontier: it
// shows the author which step each track would reach next from backlog status
// alone, and never claims a merge state it cannot know.
const NO_RUN_LINKS = new Map()

type RoadmapEditorPanelProps = {
  roadmapItem: BacklogItem
  // The home project's backlog scan: the display/status of every referenced ref and
  // the epic membership the drift check reconciles against, for the home project.
  items: BacklogItem[]
  // Every project's backlog, when planning on the instance-global surface (MC-1690):
  // the source of the cross-project library rail and the resolution of aliased refs.
  // Omitted for the single-project Backlog editor, which plans the home project only
  // (the home project is then the sole implicit source).
  libraryProjects?: RoadmapProjectItems[]
  // Persist a save, then re-scan + reselect this roadmap (owned by the panel).
  onSaved: (content: string) => void
  onOpenInEditor: (item: BacklogItem) => void
  // Navigate to a referenced item's own detail (widening navigate — a target may
  // sit outside the active lens/search). Receives the authored ref.
  onNavigate: (itemId: string) => void
  showBack: boolean
  onBack: () => void
}

export function RoadmapEditorPanel({
  roadmapItem,
  items,
  libraryProjects,
  onSaved,
  onOpenInEditor,
  onNavigate,
  showBack,
  onBack,
}: RoadmapEditorPanelProps): JSX.Element {
  const dialog = useConfirmDialog()

  // The plan resolves against a set of projects. On the global surface that is every
  // known project (the library rail); in the single-project Backlog editor it is
  // just the home project, so the two paths share one project-aware data model.
  const showLibrary = libraryProjects !== undefined && libraryProjects.length > 0
  const projectsInput = useMemo<RoadmapProjectItems[]>(
    () => libraryProjects ?? [{ projectKey: null, projectName: 'This project', path: '', items }],
    [libraryProjects, items],
  )
  const itemsByProjectKey = useMemo(() => {
    const map = new Map<ProjectKey, ReadonlyArray<BacklogItem>>()
    for (const project of projectsInput) map.set(project.projectKey, project.items)
    return map
  }, [projectsInput])
  const projectByKey = useCallback(
    (projectKey: ProjectKey) => projectsInput.find((project) => project.projectKey === projectKey),
    [projectsInput],
  )

  // Baseline = the parsed on-disk roadmap; draft = the author's working copy. The
  // baseline content string is the byte source a save composes against.
  const [baseline, setBaseline] = useState<RoadmapDraft>(() => draftFromRoadmap(parseRoadmap(roadmapItem.sourceContent)))
  const [draft, setDraft] = useState<RoadmapDraft>(baseline)
  const baselineContentRef = useRef<string>(roadmapItem.sourceContent)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const dirty = isDraftDirty(baseline, draft)

  // Adopt an external file change only when the author has no unsaved edits: a
  // scan re-read (e.g. the id-allocation pass stamping `id:` on first discovery,
  // or a sibling edit) refreshes the baseline in place. While dirty, the working
  // copy is kept — a save re-reads the current bytes so nothing is clobbered.
  useEffect(() => {
    if (roadmapItem.sourceContent === baselineContentRef.current) return
    if (dirty) return
    const nextBaseline = draftFromRoadmap(parseRoadmap(roadmapItem.sourceContent))
    baselineContentRef.current = roadmapItem.sourceContent
    setBaseline(nextBaseline)
    setDraft(nextBaseline)
    setSaveError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content; `dirty` read as a guard, not a trigger
  }, [roadmapItem.relativePath, roadmapItem.sourceContent])

  const itemStates = useMemo(() => roadmapItemStatesMulti(projectsInput), [projectsInput])
  const refDisplay = useMemo(() => refDisplayMapMulti(projectsInput), [projectsInput])
  const pickerOptions = useMemo(() => entryPickerOptionsMulti(projectsInput), [projectsInput])

  // Validation + the per-track frontier are derived from the DRAFT, so both track
  // dangling/cycle state and the "up next" readout update live as the author edits.
  // The draft's own `projects:` map lets validate/eligibility resolve aliased refs.
  const draftRoadmap = useMemo<Roadmap>(
    () => ({ policy: draft.policy, projects: draft.projects, title: draft.title, lanes: draft.lanes, body: '', issues: [] }),
    [draft],
  )
  const validation = useMemo(() => validateRoadmap(draftRoadmap, itemStates), [draftRoadmap, itemStates])
  const eligibility = useMemo(() => nextEligible(draftRoadmap, itemStates, NO_RUN_LINKS), [draftRoadmap, itemStates])
  const danglingRefs = useMemo(() => new Set(validation.danglingRefs), [validation])
  const cycleRefs = useMemo(() => new Set(validation.cycleRefs), [validation])

  const setLanes = useCallback((next: RoadmapLane[]) => setDraft((d) => ({ ...d, lanes: next })), [])
  const setPolicy = useCallback(
    (patch: Partial<RoadmapPolicy>) => setDraft((d) => ({ ...d, policy: { ...d.policy, ...patch } })),
    [],
  )

  // Add a step from an authored ref (the keyboard picker's value, or a dragged
  // library row) into a track, at an optional insert index. Routes through
  // addLibraryEntry so the source project's alias is registered the first time it
  // contributes — home refs stay unqualified, cross-project refs gain their prefix.
  const addRef = useCallback(
    (laneIndex: number, value: string, index?: number) => {
      const { projectKey, relativePath } = splitAuthoredRef(value)
      const project = projectByKey(projectKey)
      if (!project) return
      setDraft((d) => addLibraryEntry(d, laneIndex, project, relativePath, index))
    },
    [projectByKey],
  )

  // The library rail feed + its search query. Built from the DRAFT lanes so a row
  // dims the instant it is placed, and re-computed as the query narrows.
  const [libraryQuery, setLibraryQuery] = useState('')
  const libraryGroups = useMemo(
    () => (showLibrary ? buildRoadmapLibrary(projectsInput, draft.lanes, libraryQuery) : []),
    [showLibrary, projectsInput, draft.lanes, libraryQuery],
  )
  // A library drag in flight, shared so a track can accept the drop (the rail and
  // the tracks live in one tree, so React state is the transport — no dataTransfer).
  const [libDrag, setLibDrag] = useState<{ ref: string } | null>(null)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      // Compose against the CURRENT on-disk bytes, not the possibly-stale baseline
      // string, so frontmatter the scan added out-of-band (id) is never dropped.
      const current = await window.api.readfile(roadmapItem.path).catch(() => baselineContentRef.current)
      const content = composeRoadmapSaveContent(current, baseline, draft)
      await window.api.writefile(roadmapItem.path, content)
      baselineContentRef.current = content
      setBaseline(draft)
      onSaved(content)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [baseline, draft, onSaved, roadmapItem.path])

  const handleDiscard = useCallback(() => {
    setDraft(baseline)
    setSaveError(null)
  }, [baseline])

  const confirmRemoveTrack = useCallback(
    async (laneIndex: number) => {
      const lane = draft.lanes[laneIndex]
      const hasSteps = lane && lane.entries.length > 0
      if (hasSteps) {
        const ok = await dialog.confirm({
          title: 'Remove this track?',
          body: `“${lane.title}” has ${lane.entries.length} ${lane.entries.length === 1 ? 'step' : 'steps'}. Removing the track drops them from the roadmap (the backlog items stay).`,
          confirmLabel: 'Remove track',
          tone: 'danger',
        })
        if (!ok) return
      }
      setLanes(removeLane(draft.lanes, laneIndex))
    },
    [dialog, draft.lanes, setLanes],
  )

  const projectNameByKey = useMemo(() => {
    const map = new Map<ProjectKey, string>()
    for (const project of projectsInput) map.set(project.projectKey, project.projectName)
    return map
  }, [projectsInput])

  const title = draft.title ?? roadmapItem.title
  const statusLabel = BACKLOG_STATUS_LABEL[roadmapItem.status] ?? roadmapItem.status

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-surface)]">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {showBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to list"
              className="interactive -ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
            <RoadmapGlyph className="icon-sm text-[color:var(--text-subtle)]" />
            Roadmap
          </span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
            <StatusDot tone={statusTone(roadmapItem.status)} label={statusLabel} />
            {statusLabel}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Tooltip content="Open the roadmap file">
              <IconButton aria-label="Open roadmap file" onClick={() => onOpenInEditor(roadmapItem)}>
                <FileGlyph />
              </IconButton>
            </Tooltip>
            {dirty ? (
              <GhostButton onClick={handleDiscard} disabled={saving} aria-label="Discard changes">
                Discard
              </GhostButton>
            ) : null}
            <PrimaryButton onClick={() => void handleSave()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </PrimaryButton>
          </div>
        </div>
        <TitleField value={title} onChange={(next) => setDraft((d) => ({ ...d, title: next || undefined }))} />
        <PolicyBar policy={draft.policy} onChange={setPolicy} />
      </header>

      <div className="flex min-h-0 flex-1">
        {showLibrary ? (
          <LibraryRail
            groups={libraryGroups}
            query={libraryQuery}
            onQuery={setLibraryQuery}
            firstLaneIndex={draft.lanes.length > 0 ? 0 : null}
            onAdd={(ref) => addRef(0, ref)}
            onDragStart={(ref) => setLibDrag({ ref })}
            onDragEnd={() => setLibDrag(null)}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {saveError ? (
            <div className="px-4 pt-3">
              <InlineNotice tone="error">{saveError}</InlineNotice>
            </div>
          ) : null}
          {validation.hasCycle ? (
            <div className="px-4 pt-3">
              <InlineNotice tone="warn">
                Some steps must run before themselves — an ordering loop. Reorder them or remove a
                prerequisite so the roadmap can run start to finish.
              </InlineNotice>
            </div>
          ) : null}

          <TrackList
            lanes={draft.lanes}
            eligibility={eligibility}
            refDisplay={refDisplay}
            danglingRefs={danglingRefs}
            cycleRefs={cycleRefs}
            pickerOptions={pickerOptions}
            itemsByProjectKey={itemsByProjectKey}
            projectNameByKey={projectNameByKey}
            showProjectTag={showLibrary}
            libDragRef={libDrag?.ref ?? null}
            onAddRef={addRef}
            onLanes={setLanes}
            onRemoveTrack={(index) => void confirmRemoveTrack(index)}
            onNavigate={onNavigate}
          />

          <div className="px-4 py-4">
            <GhostButton onClick={() => setLanes(addLane(draft.lanes))} aria-label="Add a track">
              <PlusGlyph />
              Add track
            </GhostButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Title + policy --------------------------------------------------------

function TitleField({ value, onChange }: { value: string; onChange: (next: string) => void }): JSX.Element {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Roadmap name"
      placeholder="Roadmap name"
      className="mt-2 w-full bg-transparent text-[15px] font-semibold text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus-visible:ring-0"
    />
  )
}

// The execution policies, in plain human terms: what happens after a step
// finishes and who merges delivered work. (`policy.concurrency` is parsed and
// preserved but the orchestrator does not honor it yet — it serializes to one
// active run per repo — so no editing control is shown for it. See the backlog
// item for real per-repo concurrency.)
function PolicyBar({
  policy,
  onChange,
}: {
  policy: RoadmapPolicy
  onChange: (patch: Partial<RoadmapPolicy>) => void
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3">
      <PolicyControl label="After a step finishes">
        <SegmentedControl
          ariaLabel="After a step finishes"
          value={policy.advance}
          onChange={(value) => onChange({ advance: value as RoadmapPolicy['advance'] })}
          items={[
            { value: 'approve', label: 'Ask me first' },
            { value: 'auto', label: 'Start the next' },
          ]}
        />
      </PolicyControl>
      <PolicyControl label="Merging delivered work">
        <SegmentedControl
          ariaLabel="Merging delivered work"
          value={policy.merge}
          onChange={(value) => onChange({ merge: value as RoadmapPolicy['merge'] })}
          items={[
            { value: 'manual', label: 'I merge' },
            { value: 'auto', label: 'Automatic' },
          ]}
        />
      </PolicyControl>
    </div>
  )
}

function PolicyControl({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-[color:var(--text-muted)]">{label}</span>
      {children}
    </div>
  )
}

// ---- Tracks + steps --------------------------------------------------------

type DragState = { lane: number; index: number } | null
type DropTarget = { lane: number; index: number } | null

function TrackList({
  lanes,
  eligibility,
  refDisplay,
  danglingRefs,
  cycleRefs,
  pickerOptions,
  itemsByProjectKey,
  projectNameByKey,
  showProjectTag,
  libDragRef,
  onAddRef,
  onLanes,
  onRemoveTrack,
  onNavigate,
}: {
  lanes: RoadmapLane[]
  eligibility: ReturnType<typeof nextEligible>
  refDisplay: Map<string, RoadmapRefDisplay>
  danglingRefs: Set<string>
  cycleRefs: Set<string>
  pickerOptions: ReturnType<typeof entryPickerOptionsMulti>
  itemsByProjectKey: Map<ProjectKey, ReadonlyArray<BacklogItem>>
  projectNameByKey: Map<ProjectKey, string>
  showProjectTag: boolean
  // The authored ref of a library row being dragged, or null. Non-null lets a track
  // accept the drop as an add rather than a reorder.
  libDragRef: string | null
  onAddRef: (laneIndex: number, ref: string, index?: number) => void
  onLanes: (next: RoadmapLane[]) => void
  onRemoveTrack: (index: number) => void
  onNavigate: (itemId: string) => void
}): JSX.Element {
  const [drag, setDrag] = useState<DragState>(null)
  const [over, setOver] = useState<DropTarget>(null)

  const endDrag = useCallback(() => {
    setDrag(null)
    setOver(null)
  }, [])

  // A drop resolves to a reorder (a step was dragged) or an add (a library row was
  // dragged, tracked in libDragRef). Either way it lands at the over-index.
  const drop = useCallback(() => {
    if (over) {
      if (drag) onLanes(moveEntry(lanes, drag, over))
      else if (libDragRef) onAddRef(over.lane, libDragRef, over.index)
    }
    endDrag()
  }, [drag, over, libDragRef, lanes, onLanes, onAddRef, endDrag])

  // Keyboard reorder: move a step up/down, crossing into the adjacent track at a
  // boundary, so ordering never requires a pointer.
  const moveByKey = useCallback(
    (lane: number, index: number, direction: -1 | 1) => {
      if (direction === -1) {
        if (index > 0) onLanes(moveEntry(lanes, { lane, index }, { lane, index: index - 1 }))
        else if (lane > 0) onLanes(moveEntry(lanes, { lane, index }, { lane: lane - 1, index: lanes[lane - 1].entries.length }))
      } else {
        if (index < lanes[lane].entries.length - 1) onLanes(moveEntry(lanes, { lane, index }, { lane, index: index + 2 }))
        else if (lane < lanes.length - 1) onLanes(moveEntry(lanes, { lane, index }, { lane: lane + 1, index: 0 }))
      }
    },
    [lanes, onLanes],
  )

  if (lanes.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-[12px] text-[color:var(--text-muted)]">No tracks yet.</p>
        <p className="mt-1 text-[12px] text-[color:var(--text-disabled)]">
          Add a track, then drop backlog items and epics into it to set the order.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-4 pt-3">
      {lanes.map((lane, laneIndex) => (
        <TrackSection
          key={laneIndex}
          lane={lane}
          laneIndex={laneIndex}
          laneCount={lanes.length}
          eligibility={eligibility[laneIndex]}
          refDisplay={refDisplay}
          danglingRefs={danglingRefs}
          cycleRefs={cycleRefs}
          pickerOptions={pickerOptions}
          itemsByProjectKey={itemsByProjectKey}
          projectNameByKey={projectNameByKey}
          showProjectTag={showProjectTag}
          lanes={lanes}
          drag={drag}
          over={over}
          dropActive={Boolean(drag) || Boolean(libDragRef)}
          onDragStart={(index) => setDrag({ lane: laneIndex, index })}
          onDragOverIndex={(index) => setOver({ lane: laneIndex, index })}
          onDrop={drop}
          onDragEnd={endDrag}
          onMoveByKey={moveByKey}
          onAddRef={onAddRef}
          onLanes={onLanes}
          onRemoveTrack={onRemoveTrack}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

function TrackSection({
  lane,
  laneIndex,
  laneCount,
  eligibility,
  refDisplay,
  danglingRefs,
  cycleRefs,
  pickerOptions,
  itemsByProjectKey,
  projectNameByKey,
  showProjectTag,
  lanes,
  drag,
  over,
  dropActive,
  onDragStart,
  onDragOverIndex,
  onDrop,
  onDragEnd,
  onMoveByKey,
  onAddRef,
  onLanes,
  onRemoveTrack,
  onNavigate,
}: {
  lane: RoadmapLane
  laneIndex: number
  laneCount: number
  eligibility: ReturnType<typeof nextEligible>[number] | undefined
  refDisplay: Map<string, RoadmapRefDisplay>
  danglingRefs: Set<string>
  cycleRefs: Set<string>
  pickerOptions: ReturnType<typeof entryPickerOptionsMulti>
  itemsByProjectKey: Map<ProjectKey, ReadonlyArray<BacklogItem>>
  projectNameByKey: Map<ProjectKey, string>
  showProjectTag: boolean
  lanes: RoadmapLane[]
  drag: DragState
  over: DropTarget
  // A drag (step or library row) is in flight, so this track should accept drops.
  dropActive: boolean
  onDragStart: (index: number) => void
  onDragOverIndex: (index: number) => void
  onDrop: () => void
  onDragEnd: () => void
  onMoveByKey: (lane: number, index: number, direction: -1 | 1) => void
  onAddRef: (laneIndex: number, ref: string, index?: number) => void
  onLanes: (next: RoadmapLane[]) => void
  onRemoveTrack: (index: number) => void
  onNavigate: (itemId: string) => void
}): JSX.Element {
  const listRef = useRef<HTMLOListElement | null>(null)

  const handleDragOver = (event: React.DragEvent): void => {
    if (!dropActive) return
    const list = listRef.current
    if (!list) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    onDragOverIndex(computeInsertIndex(list, event.clientY))
  }

  const showDrop = dropActive && over && over.lane === laneIndex

  return (
    <section
      className="rounded-[7px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
      aria-label={`${lane.title} track`}
    >
      <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-2.5 py-2">
        <TrackTitleInput value={lane.title} onChange={(next) => onLanes(renameLane(lanes, laneIndex, next))} />
        <TrackFrontier eligibility={eligibility} refDisplay={refDisplay} />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <AddStepButton pickerOptions={pickerOptions} lane={lane} onAdd={(ref) => onAddRef(laneIndex, ref)} />
          {laneIndex < laneCount - 1 ? (
            <TrackIconButton label="Merge into the track below" onClick={() => onLanes(mergeLaneDown(lanes, laneIndex))}>
              <MergeGlyph />
            </TrackIconButton>
          ) : null}
          <TrackIconButton label="Remove track" onClick={() => onRemoveTrack(laneIndex)}>
            <TrashGlyph />
          </TrackIconButton>
        </div>
      </div>

      <ol
        ref={listRef}
        className="flex flex-col px-2 py-2"
        onDragOver={handleDragOver}
        onDrop={(event) => {
          event.preventDefault()
          onDrop()
        }}
      >
        {lane.entries.length === 0 ? (
          <li className="list-none px-1.5 py-2 text-[12px] text-[color:var(--text-disabled)]">
            {showProjectTag ? 'No steps yet — drag work in, or use “Add step”.' : 'No steps yet — use “Add step”.'}
          </li>
        ) : (
          lane.entries.map((entry, entryIndex) => {
            const entryItems = itemsByProjectKey.get(entry.projectKey) ?? []
            return (
              <li key={`${entry.ref}:${entryIndex}`} className="list-none">
                {showDrop && over?.index === entryIndex ? <DropIndicator /> : null}
                <StepRow
                  entry={entry}
                  position={entryIndex + 1}
                  refDisplay={refDisplay}
                  danglingRefs={danglingRefs}
                  cycleRefs={cycleRefs}
                  entryItems={entryItems}
                  projectName={showProjectTag && entry.projectKey ? projectNameByKey.get(entry.projectKey) : undefined}
                  dragging={drag?.lane === laneIndex && drag.index === entryIndex}
                  onDragStart={() => onDragStart(entryIndex)}
                  onDragEnd={onDragEnd}
                  onMoveUp={() => onMoveByKey(laneIndex, entryIndex, -1)}
                  onMoveDown={() => onMoveByKey(laneIndex, entryIndex, 1)}
                  onRemove={() => onLanes(removeEntry(lanes, laneIndex, entryIndex))}
                  onSplitAbove={entryIndex > 0 ? () => onLanes(splitLane(lanes, laneIndex, entryIndex)) : undefined}
                  onResync={
                    entry.kind === 'epic'
                      ? () => onLanes(resyncEpicEntry(entryItems, lanes, laneIndex, entryIndex))
                      : undefined
                  }
                  onNavigate={onNavigate}
                />
              </li>
            )
          })
        )}
        {showDrop && over?.index === lane.entries.length ? <DropIndicator /> : null}
      </ol>
    </section>
  )
}

function TrackTitleInput({ value, onChange }: { value: string; onChange: (next: string) => void }): JSX.Element {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Track name"
      placeholder="Track name"
      className="min-w-0 flex-1 bg-transparent text-[12px] font-semibold text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus-visible:ring-0"
    />
  )
}

// The per-track frontier readout ("up next"), derived from nextEligible. One dot
// (the single status idiom) plus a plain word and the step title.
function TrackFrontier({
  eligibility,
  refDisplay,
}: {
  eligibility: ReturnType<typeof nextEligible>[number] | undefined
  refDisplay: Map<string, RoadmapRefDisplay>
}): JSX.Element | null {
  if (!eligibility) return null
  const { word, tone } = REASON_PRESENTATION[eligibility.reason]
  const frontierRef = eligibility.eligibleRef ?? eligibility.frontierRef
  const title = frontierRef ? refDisplay.get(frontierRef)?.title : undefined
  return (
    <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-[color:var(--text-muted)] sm:inline-flex">
      <StatusDot tone={tone} label={word} />
      <span>{word}</span>
      {title ? <TruncatedText as="span" text={title} className="max-w-[12rem] text-[color:var(--text-subtle)]" /> : null}
    </span>
  )
}

function StepRow({
  entry,
  position,
  refDisplay,
  danglingRefs,
  cycleRefs,
  entryItems,
  projectName,
  dragging,
  onDragStart,
  onDragEnd,
  onMoveUp,
  onMoveDown,
  onRemove,
  onSplitAbove,
  onResync,
  onNavigate,
}: {
  entry: RoadmapEntry
  position: number
  refDisplay: Map<string, RoadmapRefDisplay>
  danglingRefs: Set<string>
  cycleRefs: Set<string>
  // The backlog scan of THIS entry's project, so an aliased epic's drift reconciles
  // against its own project's membership, not the home project's.
  entryItems: ReadonlyArray<BacklogItem>
  // The project a cross-project step belongs to, shown as a quiet tag. Undefined for
  // home-project steps and in single-project mode (no tag).
  projectName?: string
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
  onSplitAbove?: () => void
  onResync?: () => void
  onNavigate: (itemId: string) => void
}): JSX.Element {
  const display = refDisplay.get(entry.ref)
  const dangling = danglingRefs.has(entry.ref)
  const inCycle = cycleRefs.has(entry.ref)
  const drift = entry.kind === 'epic' ? epicEntryDrift(entryItems, entry) : null

  return (
    <div
      data-step="true"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={`group rounded border border-transparent transition-colors hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--bg-hover)] ${
        dragging ? 'opacity-50' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-2 px-1.5 py-1.5">
        <button
          type="button"
          aria-label={`Reorder ${display?.title ?? entry.ref}. Use arrow up and down to move.`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              onMoveUp()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              onMoveDown()
            }
          }}
          className="interactive inline-flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-[color:var(--text-disabled)] transition-colors hover:text-[color:var(--text-muted)] focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
        >
          <GripGlyph />
        </button>
        <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-[color:var(--text-disabled)]">{position}</span>

        {dangling ? (
          <Tooltip content={`No backlog item matches “${entry.ref}”. Remove the stale step or create the item.`} placement="top" wrapperClassName="inline-flex min-w-0 flex-1">
            <span
              tabIndex={0}
              role="note"
              aria-label={`${entry.ref}: unknown item, no matching backlog file`}
              className="min-w-0 flex-1 truncate rounded px-1 py-0.5 font-mono text-[12px] text-[color:var(--text-disabled)] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
            >
              Unknown · {entry.ref}
            </span>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={() => onNavigate(entry.ref)}
            className="interactive inline-flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:text-[color:var(--text-strong)]"
          >
            {entry.kind === 'epic' ? <EpicGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" /> : null}
            {display?.displayId ? (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--text-muted)]">{display.displayId}</span>
            ) : null}
            <TruncatedText as="span" text={display?.title ?? entry.ref} className="min-w-0 flex-1" />
            {projectName ? (
              <span className="shrink-0 max-w-[9rem] truncate text-[10.5px] text-[color:var(--text-subtle)]" title={projectName}>
                {projectName}
              </span>
            ) : null}
            {entry.kind === 'epic' ? (
              <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
                {entry.children.length} {entry.children.length === 1 ? 'item' : 'items'}
              </span>
            ) : null}
          </button>
        )}

        {inCycle ? (
          <Tooltip content="This step is part of an ordering loop." placement="top">
            <span aria-label="In an ordering loop" role="img" className="shrink-0">
              <StatusDot tone="warn" />
            </span>
          </Tooltip>
        ) : null}

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {onSplitAbove ? (
            <StepIconButton label="Split the track above this step" onClick={onSplitAbove}>
              <SplitGlyph />
            </StepIconButton>
          ) : null}
          <StepIconButton label={`Remove ${display?.title ?? entry.ref}`} onClick={onRemove}>
            <CloseGlyph />
          </StepIconButton>
        </div>
      </div>

      {entry.kind === 'epic' && entry.children.length > 0 ? (
        <EpicChildren
          childRefs={entry.children}
          projectKey={entry.projectKey}
          refDisplay={refDisplay}
          danglingRefs={danglingRefs}
          onNavigate={onNavigate}
        />
      ) : null}
      {drift ? <DriftAffordance drift={drift} onResync={onResync} /> : null}
    </div>
  )
}

function EpicChildren({
  childRefs,
  projectKey,
  refDisplay,
  danglingRefs,
  onNavigate,
}: {
  childRefs: string[]
  // The parent epic's project — a child inherits it unless authored with its own
  // `alias:`, so the child's display key is the child resolved against this project.
  projectKey: ProjectKey
  refDisplay: Map<string, RoadmapRefDisplay>
  danglingRefs: Set<string>
  onNavigate: (itemId: string) => void
}): JSX.Element {
  return (
    <ul className="ml-[2.15rem] flex flex-col gap-0.5 border-l border-[color:var(--border-subtle)] pb-1.5 pl-2">
      {childRefs.map((child, index) => {
        const resolvedRef = child.includes(':') ? child : authoredRef(projectKey, child)
        const display = refDisplay.get(resolvedRef)
        const dangling = danglingRefs.has(child)
        return (
          <li key={`${child}:${index}`} className="min-w-0">
            {dangling ? (
              <span role="note" aria-label={`${child}: unknown item`} className="block truncate py-0.5 font-mono text-[11px] text-[color:var(--text-disabled)]">
                Unknown · {child}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(resolvedRef)}
                className="interactive flex min-w-0 items-center gap-1.5 rounded py-0.5 text-left text-[11px] text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
              >
                {display?.displayId ? (
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[color:var(--text-subtle)]">{display.displayId}</span>
                ) : null}
                <TruncatedText as="span" text={display?.title ?? child} className="min-w-0" />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// The static-plan drift affordance: a calm, plain-human note that the epic's
// membership moved since it was snapshotted, with one-click re-sync (T3
// roadmapEpicDrift set difference).
function DriftAffordance({
  drift,
  onResync,
}: {
  drift: { gained: string[]; removed: string[] }
  onResync?: () => void
}): JSX.Element {
  const parts: string[] = []
  if (drift.gained.length > 0) parts.push(`${drift.gained.length} new ${drift.gained.length === 1 ? 'item' : 'items'}`)
  if (drift.removed.length > 0) parts.push(`${drift.removed.length} removed`)
  return (
    <div className="mx-1.5 mb-1.5 flex items-center gap-2 rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2 py-1">
      <StatusDot tone="accent" />
      <span className="min-w-0 flex-1 text-[11px] text-[color:var(--text-muted)]">
        This epic has {parts.join(' and ')} since you added it.
      </span>
      {onResync ? (
        <button
          type="button"
          onClick={onResync}
          className="interactive shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--bg-hover)]"
        >
          Update
        </button>
      ) : null}
    </div>
  )
}

function AddStepButton({
  pickerOptions,
  lane,
  onAdd,
}: {
  pickerOptions: ReturnType<typeof entryPickerOptionsMulti>
  lane: RoadmapLane
  onAdd: (ref: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const selectedValues = useMemo(() => lane.entries.map((entry) => entry.ref), [lane.entries])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Add a step"
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="min-w-[19rem] p-1"
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          onClick={togglePopover}
          className="interactive inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
        >
          <PlusGlyph />
          Add step
        </button>
      )}
    >
      <BacklogItemSearchPicker
        options={pickerOptions}
        selectedValues={selectedValues}
        ariaLabel="Search backlog items and epics"
        noOptionsMessage="No backlog items."
        multiple
        resultRole="listbox"
        onSelect={(option) => onAdd(option.value)}
      />
    </Popover>
  )
}

// ---- Library rail (cross-project planning) ---------------------------------

// The planning rail: every project's backlog, grouped and searchable, the source
// of drag-in work (mockup §3). A row drags into a track, or adds to the first track
// on click/Enter (the keyboard path). A placed row dims rather than disappears, so
// the author always sees the whole backlog. Groups and epics collapse locally.
function LibraryRail({
  groups,
  query,
  onQuery,
  firstLaneIndex,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  groups: RoadmapLibraryGroup[]
  query: string
  onQuery: (next: string) => void
  // The lane a click/Enter adds to (the first track), or null when there is none.
  firstLaneIndex: number | null
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  // Collapsed projects and expanded epics, keyed by their stable ids. A project is
  // open by default; an epic is collapsed (its children are a peek, not the default).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())
  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }
  const canAdd = firstLaneIndex !== null

  return (
    <aside
      aria-label="Backlog library"
      className="flex w-[264px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-3"
    >
      <div className="relative shrink-0">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[color:var(--text-disabled)]">
          <SearchGlyph />
        </span>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search all backlogs…"
          aria-label="Search all project backlogs"
          className="h-7 w-full rounded border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] pl-7 pr-2 text-[12px] text-[color:var(--text-default)] outline-none placeholder:text-[color:var(--text-disabled)] focus-visible:border-[color:var(--border-focus)] focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5">
        {groups.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-[color:var(--text-subtle)]">
            {query.trim() ? 'No matching backlog work.' : 'No backlog work to plan yet.'}
          </p>
        ) : (
          groups.map((group) => {
            const groupKey = group.projectKey ?? '(home)'
            const isOpen = !collapsed.has(groupKey)
            return (
              <div key={groupKey} className="min-w-0">
                <button
                  type="button"
                  onClick={() => setCollapsed((set) => toggle(set, groupKey))}
                  aria-expanded={isOpen}
                  className="interactive flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left transition-colors hover:bg-[color:var(--bg-hover)]"
                >
                  <ChevronGlyph className={isOpen ? 'rotate-90' : ''} />
                  <TruncatedText
                    as="span"
                    text={group.projectName}
                    className="min-w-0 flex-1 text-[12px] font-semibold text-[color:var(--text-strong)]"
                  />
                  <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-disabled)]">
                    {group.entries.length}
                  </span>
                </button>
                {isOpen ? (
                  <ul className="mb-1 ml-2 flex flex-col gap-0.5">
                    {group.entries.map((entry) => (
                      <li key={entry.ref} className="min-w-0">
                        <LibraryRow
                          entry={entry}
                          canAdd={canAdd}
                          expanded={expandedEpics.has(entry.ref)}
                          onToggleEpic={() => setExpandedEpics((set) => toggle(set, entry.ref))}
                          onAdd={() => onAdd(entry.ref)}
                          onDragStart={() => onDragStart(entry.ref)}
                          onDragEnd={onDragEnd}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <p className="shrink-0 border-t border-[color:var(--border-subtle)] pt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
        Grouped by project. Placed work is dimmed. Drag an epic to run all of its items as one sequence.
      </p>
    </aside>
  )
}

function LibraryRow({
  entry,
  canAdd,
  expanded,
  onToggleEpic,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  entry: RoadmapLibraryEntry
  canAdd: boolean
  expanded: boolean
  onToggleEpic: () => void
  onAdd: () => void
  onDragStart: () => void
  onDragEnd: () => void
}): JSX.Element {
  const draggable = !entry.planned && canAdd
  // The row is a draggable container holding real controls (an add button, and for
  // epics a peek toggle) — not a button-role div wrapping a button, so screen readers
  // and keyboard focus stay unambiguous while drag stays the pointer affordance.
  return (
    <>
      <div
        draggable={draggable}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'copy'
          // A minimal payload keeps the native drag image; the ref rides React state.
          event.dataTransfer.setData('text/plain', entry.ref)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        className={`group flex h-7 min-w-0 items-center gap-1.5 rounded pr-1.5 text-[12px] transition-colors ${
          entry.planned ? 'opacity-40' : `cursor-grab hover:bg-[color:var(--bg-hover)]`
        }`}
      >
        {entry.kind === 'epic' ? (
          <button
            type="button"
            aria-label={expanded ? `Hide items in ${entry.title}` : `Show items in ${entry.title}`}
            aria-expanded={expanded}
            onClick={onToggleEpic}
            className="interactive ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[color:var(--text-disabled)] hover:text-[color:var(--text-muted)]"
          >
            <ChevronGlyph className={expanded ? 'rotate-90' : ''} />
          </button>
        ) : (
          <span aria-hidden="true" className="ml-1 shrink-0 text-[color:var(--text-disabled)] opacity-0 transition-opacity group-hover:opacity-100">
            <GripGlyph />
          </span>
        )}
        <button
          type="button"
          disabled={!draggable}
          onClick={onAdd}
          aria-label={
            entry.planned
              ? `${entry.title} — already in the plan`
              : `Add ${entry.title}${entry.kind === 'epic' ? ` (${entry.children.length} items)` : ''} to the plan`
          }
          className="interactive flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded text-left text-[color:var(--text-default)] outline-none disabled:cursor-default focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
        >
          {entry.kind === 'epic' ? <EpicGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" /> : null}
          {entry.displayId ? (
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[color:var(--text-subtle)]">{entry.displayId}</span>
          ) : null}
          <TruncatedText as="span" text={entry.title} className="min-w-0 flex-1" />
          {entry.kind === 'epic' ? (
            <span className="shrink-0 text-[10.5px] tabular-nums text-[color:var(--text-subtle)]">
              {entry.children.length}
            </span>
          ) : null}
        </button>
      </div>
      {entry.kind === 'epic' && expanded ? (
        <ul className="ml-6 mb-0.5 flex flex-col gap-0.5 border-l border-[color:var(--border-subtle)] pl-2">
          {entry.children.length === 0 ? (
            <li className="py-0.5 text-[11px] text-[color:var(--text-disabled)]">No items in this epic yet.</li>
          ) : (
            entry.children.map((child) => (
              <li key={child.ref} className="flex min-w-0 items-center gap-1.5 py-0.5 text-[11px] text-[color:var(--text-muted)]">
                {child.displayId ? (
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-[color:var(--text-subtle)]">{child.displayId}</span>
                ) : null}
                <TruncatedText as="span" text={child.title} className="min-w-0" />
              </li>
            ))
          )}
        </ul>
      ) : null}
    </>
  )
}

// ---- Small shared chrome ---------------------------------------------------

function DropIndicator(): JSX.Element {
  return <div aria-hidden="true" className="my-0.5 h-[2px] rounded-full bg-[color:var(--accent-primary)]" />
}

function computeInsertIndex(list: HTMLOListElement, clientY: number): number {
  const rows = list.querySelectorAll('[data-step="true"]')
  for (let i = 0; i < rows.length; i += 1) {
    const rect = rows[i].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return rows.length
}

function TrackIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="interactive inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
      >
        {children}
      </button>
    </Tooltip>
  )
}

function StepIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="interactive inline-flex h-5 w-5 items-center justify-center rounded text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
      >
        {children}
      </button>
    </Tooltip>
  )
}

// ---- Presentation maps + glyphs --------------------------------------------

const REASON_PRESENTATION: Record<RoadmapLaneReason, { word: string; tone: Tone }> = {
  eligible: { word: 'Up next', tone: 'accent' },
  in_progress: { word: 'In progress', tone: 'accent' },
  awaiting_merge: { word: 'Waiting to merge', tone: 'warn' },
  blocked: { word: 'Blocked', tone: 'warn' },
  lane_complete: { word: 'All done', tone: 'good' },
  dangling: { word: 'Unknown item', tone: 'error' },
  unknown_project: { word: 'Unknown project', tone: 'error' },
  empty: { word: 'No steps yet', tone: 'neutral' },
}

function statusTone(status: BacklogItem['status']): Tone {
  switch (status) {
    case 'completed':
      return 'good'
    case 'in_progress':
      return 'accent'
    case 'needs_input':
      return 'warn'
    case 'archived':
      return 'neutral'
    default:
      return 'neutral'
  }
}

function RoadmapGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.6 4H9a2 2 0 0 1 2 2v.4M10.4 8H7a2 2 0 0 0-2 2v.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function EpicGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 2.4 13.4 5 8 7.6 2.6 5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M3 7.6 8 10.1 13 7.6M3 10.1 8 12.6 13 10.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function GripGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="icon-xs">
      <circle cx="6" cy="4" r="1" />
      <circle cx="10" cy="4" r="1" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="10" cy="12" r="1" />
    </svg>
  )
}

function SearchGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <circle cx="7" cy="7" r="3.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.6 9.6 13 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ChevronGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`icon-xs shrink-0 transition-transform ${className ?? ''}`}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CloseGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function TrashGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M3.5 4.5h9M6.5 4.5V3.5a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M5 4.5l.5 8a1 1 0 0 0 1 .95h3a1 1 0 0 0 1-.95l.5-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MergeGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M5 2.5v3.2a3 3 0 0 0 3 3h3M11 8.7l2 0M8 13.5l0-3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 7.2 12.8 8.7 10.5 10.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SplitGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M8 2.5v11M4 6l4-3.5L12 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8h-8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 2.5v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
