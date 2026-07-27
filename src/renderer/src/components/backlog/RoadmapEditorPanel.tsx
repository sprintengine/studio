import { useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  GhostButton,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  LIFECYCLE_LABEL,
  LifecycleGlyph,
  Popover,
  SegmentedControl,
  StatusDot,
  Tooltip,
  TruncatedText,
  useConfirmDialog,
  type SelectItem,
} from '../ui'
import type { Tone } from '../ui/tokens'
import type { BacklogItem } from '../../utils/backlog'
import {
  nextEligible,
  validateRoadmap,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapLane,
  type RoadmapLaneReason,
  type RoadmapPolicy,
} from '../../../../shared/backlog/roadmap'
import { BACKLOG_STATUS_LABEL, BacklogEpicHeaderContent, BacklogRowContent } from './BacklogRow'
import { BacklogFilterMenu } from './BacklogFilterMenu'
import { BacklogItemSearchPicker } from './BacklogItemSearchPicker'
import {
  epicProgressBySlug,
} from '../../utils/backlogEpics'
import {
  type BacklogSort,
  type BacklogView,
} from '../../utils/backlogTriage'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  addLane,
  addLibraryEntry,
  authoredRef,
  entryPickerOptionsMulti,
  epicEntryDrift,
  mergeLaneDown,
  moveEntry,
  refDisplayMapMulti,
  removeEntry,
  removeLane,
  renameLane,
  resyncEpicEntry,
  roadmapItemStatesMulti,
  setEntryRoster,
  splitAuthoredRef,
  splitLane,
  type RoadmapProjectItems,
  type RoadmapRefDisplay,
} from './roadmapAuthoring'
import { useRoadmapPlanDraft } from './useRoadmapPlanDraft'
import { resolveEntryRoster, type ProjectKey } from '../../../../shared/backlog/roadmap'
import type { SprintEngineRoster } from '../../types/workspace'
import { NO_ROLES_ROSTER_NAME } from '../workspace/newWorkspace/savedRosters'
import { RosterMenu } from './RosterMenu'
// The rail's group model moved to the Horizon backlog source (MC-1923); the
// editor renders the same models until MC-1926 deletes it.
import { buildLibraryGroupModels, type LibraryGroupModel } from '../panels/roadmapBoard/HorizonBacklogSource'
import { RosterManagerModal } from './RosterManagerModal'
import { roadmapMemberLifecycle, roadmapMembersDone } from '../panels/roadmapBoard/roadmapMemberLifecycle'

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

  // Baseline, working copy and autosave all live in the shared hook (MC-1924),
  // so this editor and the plan column that replaces it persist through ONE path.
  const {
    draft,
    dirty,
    saving,
    saveError,
    update: setDraft,
    setLanes,
    setPolicy,
    save: handleSave,
  } = useRoadmapPlanDraft({
    path: roadmapItem.path,
    relativePath: roadmapItem.relativePath,
    sourceContent: roadmapItem.sourceContent,
    onSaved,
  })

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

  // The library rail's search + lens + sort — the same Backlog toolbar idiom
  // (InboxSearchInput + BacklogFilterMenu over the shared triage logic) as the
  // Backlog door, so planning filters work exactly like the Backlog. The default
  // 'active' lens hides completed/archived work — finished epics are not
  // plannable and only clutter the rail (switch the lens to see them).
  const [libraryQuery, setLibraryQuery] = useState('')
  const [libraryView, setLibraryView] = useState<BacklogView>('active')
  const [librarySort, setLibrarySort] = useState<BacklogSort>('best')
  // The refs already placed in the plan (top-level steps): placed rows dim and
  // stop being draggable, live off the DRAFT so a row dims the instant it lands.
  const plannedRefs = useMemo(() => {
    const set = new Set<string>()
    for (const lane of draft.lanes) for (const entry of lane.entries) set.add(entry.ref)
    return set
  }, [draft.lanes])
  // A library drag in flight, shared so a track can accept the drop (the rail and
  // the tracks live in one tree, so React state is the transport — no dataTransfer).
  const [libDrag, setLibDrag] = useState<{ ref: string } | null>(null)

  const confirmRemoveTrack = useCallback(
    async (laneIndex: number) => {
      const lane = draft.lanes[laneIndex]
      const hasSteps = lane && lane.entries.length > 0
      if (hasSteps) {
        const ok = await dialog.confirm({
          title: 'Remove this track?',
          body: `“${lane.title}” has ${lane.entries.length} ${lane.entries.length === 1 ? 'step' : 'steps'}. Removing the track drops them from the horizon (the backlog items stay).`,
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

  // MC-1880: the picker shows what each roster STAFFS, so it needs the records,
  // not bare names — a name alone is not enough to choose between rosters. The
  // useShallow treatment matters more with objects, not less: the array is
  // rebuilt on every store read, so a shallow compare is what keeps the memo
  // below (and the menu) referentially stable.
  const savedRosters = useWorkspaceStore(
    useShallow((s) => s.appSettings.sprintEngineRoleSettings?.savedRosters ?? []),
  )

  // The roster manager is a modal over the door surface, not a nested panel in
  // the scrolling editor.
  const [rosterManagerOpen, setRosterManagerOpen] = useState(false)

  const title = draft.title ?? roadmapItem.title
  const statusLabel = BACKLOG_STATUS_LABEL[roadmapItem.status] ?? roadmapItem.status

  return (
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-surface)]">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The surface-hosted editor rides the door's lifted top bar (back +
              name + status live there); only the standalone mount draws its own
              breadcrumb cluster. */}
          {showBack ? (
            <>
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
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                <RoadmapGlyph className="icon-sm text-[color:var(--text-subtle)]" />
                Horizon
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                <StatusDot tone={statusTone(roadmapItem.status)} label={statusLabel} />
                {statusLabel}
              </span>
            </>
          ) : null}
          <div className="min-w-0 flex-1">
            <TitleField value={title} onChange={(next) => setDraft((d) => ({ ...d, title: next || undefined }))} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Autosave state, not a button: edits persist themselves. */}
            <span aria-live="polite" className="text-[11px] text-[color:var(--text-subtle)]">
              {saving ? 'Saving…' : dirty ? 'Unsaved edits…' : 'Saved'}
            </span>
            <Tooltip content="Open the horizon file">
              <IconButton aria-label="Open horizon file" onClick={() => onOpenInEditor(roadmapItem)}>
                <FileGlyph />
              </IconButton>
            </Tooltip>
          </div>
        </div>
        <PolicyBar
          policy={draft.policy}
          rosters={savedRosters}
          onChange={setPolicy}
          onManageRosters={() => setRosterManagerOpen(true)}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {showLibrary ? (
          <LibraryRail
            projects={projectsInput}
            plannedRefs={plannedRefs}
            query={libraryQuery}
            onQuery={setLibraryQuery}
            view={libraryView}
            onView={setLibraryView}
            sort={librarySort}
            onSort={setLibrarySort}
            canAdd={draft.lanes.length > 0}
            onAdd={(ref) => addRef(0, ref)}
            onDragStart={(ref) => setLibDrag({ ref })}
            onDragEnd={() => setLibDrag(null)}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {saveError ? (
            <div className="px-4 pt-3">
              <InlineNotice
                tone="error"
                title="Your latest edits couldn’t be saved."
                detail={saveError}
                action={
                  <GhostButton size="xs" onClick={() => void handleSave()} disabled={saving}>
                    Try again
                  </GhostButton>
                }
              />
            </div>
          ) : null}
          {validation.hasCycle ? (
            <div className="px-4 pt-3">
              <InlineNotice tone="warn">
                Some steps must run before themselves — an ordering loop. Reorder them or remove a
                prerequisite so the horizon can run start to finish.
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
            staffing={{
              rosters: savedRosters,
              policyRoster: draft.policy.roster,
              onManageRosters: () => setRosterManagerOpen(true),
            }}
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

      {rosterManagerOpen ? (
        <RosterManagerModal
          // The horizon's home project supplies the role registry. A horizon can
          // span projects, but rosters are a global user preference, so the
          // registry only decides which ROWS are offered.
          workspaceRoot={projectsInput[0]?.path ?? null}
          onClose={() => setRosterManagerOpen(false)}
          onRosterChosen={(name) => {
            // Creating or picking a roster here returns to Horizon with it
            // selected and written to `policy.roster` through the same autosave
            // + policyDiff path the menu uses — frontmatter only, body untouched.
            setPolicy({ roster: name })
            setRosterManagerOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

// ---- Title + policy --------------------------------------------------------

function TitleField({ value, onChange }: { value: string; onChange: (next: string) => void }): JSX.Element {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Horizon name"
      placeholder="Horizon name"
      className="w-full bg-transparent text-[15px] font-semibold text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus-visible:ring-0"
    />
  )
}

// The execution policies, in plain human terms: what happens after a step
// finishes, who merges delivered work, and which saved roster staffs each sprint.
// (`policy.concurrency` is parsed and preserved but the orchestrator does not
// honor it yet — it serializes to one active run per repo — so no editing
// control is shown for it. See the backlog item for real per-repo concurrency.)
//
// MC-1880 removed the "Last used roster" sentinel entirely. It was the honest
// name for a dishonest default: an unset roster resolved through whatever the
// sprint wizard last touched, so a horizon could staff step 3 differently from
// step 1 for reasons nothing on this screen showed. "No roles" (MC-1876) is the
// deterministic replacement.
function PolicyBar({
  policy,
  rosters,
  onChange,
  onManageRosters,
}: {
  policy: RoadmapPolicy
  // The user's saved rosters, as records — the menu shows what each one staffs.
  rosters: ReadonlyArray<SprintEngineRoster>
  onChange: (patch: Partial<RoadmapPolicy>) => void
  onManageRosters: () => void
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
      {/* MC-1882: the label says SCOPE. This is the default for steps that do
          not override it, not a hard setting for the whole horizon. */}
      <PolicyControl label="Default roster">
        <RosterMenu
          rosters={rosters}
          selectedName={policy.roster ?? null}
          onSelect={(name) => onChange({ roster: name })}
          onManageRosters={onManageRosters}
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

// Everything a step row needs to show and change its staffing (MC-1882),
// bundled so the roster does not add four separate props at every level of the
// track tree. `policyRoster` is the horizon's default — the value a step falls
// back to — NOT the step's own; resolution is always `resolveEntryRoster`.
type StepStaffing = {
  rosters: ReadonlyArray<SprintEngineRoster>
  policyRoster: string | undefined
  onManageRosters: () => void
}

type DragState = { lane: number; index: number } | null
type DropTarget = { lane: number; index: number } | null

// Stable React keys for the tracks. RoadmapLane carries no id, so a naive
// key={laneIndex} makes React reuse the wrong DOM when a track is added, removed,
// split, or merged — the classic index-key reconciliation bug. This derives a key
// from the track's content (its step refs, order-independent so an in-track
// reorder doesn't remount it; its title for an empty track), disambiguating any
// genuine duplicates with an occurrence suffix so keys stay unique.
function laneKeys(lanes: ReadonlyArray<RoadmapLane>): string[] {
  const seen = new Map<string, number>()
  return lanes.map((lane) => {
    const base =
      lane.entries.length > 0
        ? `refs:${[...lane.entries.map((entry) => entry.ref)].sort().join('|')}`
        : `empty:${lane.title}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}#${count}`
  })
}

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
  staffing,
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
  staffing: StepStaffing
  onAddRef: (laneIndex: number, ref: string, index?: number) => void
  onLanes: (next: RoadmapLane[]) => void
  onRemoveTrack: (index: number) => void
  onNavigate: (itemId: string) => void
}): JSX.Element {
  const [drag, setDrag] = useState<DragState>(null)
  const [over, setOver] = useState<DropTarget>(null)
  // Keyboard reorder has no visible drag to follow, so each move is announced to a
  // polite live region for screen readers.
  const [announcement, setAnnouncement] = useState('')

  const laneKeyList = useMemo(() => laneKeys(lanes), [lanes])

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
  // boundary, so ordering never requires a pointer. Each successful move is
  // announced ("Moved <step> to position N of M in <track>.") for screen readers.
  const moveByKey = useCallback(
    (lane: number, index: number, direction: -1 | 1) => {
      const moved = lanes[lane]?.entries[index]
      if (!moved) return
      let dest: { lane: number; index: number } | null = null
      if (direction === -1) {
        if (index > 0) dest = { lane, index: index - 1 }
        else if (lane > 0) dest = { lane: lane - 1, index: lanes[lane - 1].entries.length }
      } else {
        if (index < lanes[lane].entries.length - 1) dest = { lane, index: index + 2 }
        else if (lane < lanes.length - 1) dest = { lane: lane + 1, index: 0 }
      }
      if (!dest) return
      const next = moveEntry(lanes, { lane, index }, dest)
      onLanes(next)
      const title = refDisplay.get(moved.ref)?.title ?? moved.ref
      for (const target of next) {
        const pos = target.entries.findIndex((entry) => entry.ref === moved.ref)
        if (pos >= 0) {
          setAnnouncement(`Moved ${title} to position ${pos + 1} of ${target.entries.length} in ${target.title}.`)
          break
        }
      }
    },
    [lanes, onLanes, refDisplay],
  )

  if (lanes.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-[12px] text-[color:var(--text-muted)]">No tracks yet.</p>
        {/* Vocabulary in place (global-surfaces epic): a first-time planner can
            read what a track and a step are without leaving the surface. */}
        <p className="mx-auto mt-1 max-w-[52ch] text-[12px] leading-5 text-[color:var(--text-disabled)]">
          A track is a lane of steps that run in order, one sprint at a time; tracks run side by side. A step is one
          backlog item or epic. Add a track, then drop work into it to set the order.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-4 pt-3">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {lanes.map((lane, laneIndex) => (
        <TrackSection
          key={laneKeyList[laneIndex]}
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
          staffing={staffing}
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
  staffing,
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
  staffing: StepStaffing
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
    // The drop effect must be one the drag source allowed, or the browser marks
    // the target invalid and never fires `drop`: a step reorder drags with
    // effectAllowed 'move', a library row with 'copy' (the backlog keeps its
    // item). This mismatch was exactly the rail-drag-refused bug.
    event.dataTransfer.dropEffect = drag ? 'move' : 'copy'
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
                  staffing={staffing}
                  onSetRoster={(roster) => onLanes(setEntryRoster(lanes, laneIndex, entryIndex, roster))}
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
  staffing,
  onSetRoster,
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
  staffing: StepStaffing
  // Set (or clear, with undefined) THIS step's roster override.
  onSetRoster: (roster: string | undefined) => void
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
              // done/total, so a collapsed epic step reads its progress without
              // expanding (MC-1902) — the same count the Horizon board shows,
              // through the same predicate.
              <span
                className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]"
                title={`One sprint delivers all ${entry.children.length} ${entry.children.length === 1 ? 'item' : 'items'} in this step`}
              >
                {roadmapMembersDone(
                  entry.children.map((child) => refDisplay.get(child.includes(':') ? child : authoredRef(entry.projectKey, child))?.status),
                )}
                /{entry.children.length} {entry.children.length === 1 ? 'item' : 'items'}
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

        {/* MC-1882: the roster is both the display and the control — always in
            the tab order, never hidden behind hover, so an override is readable
            and changeable without a pointer. Display resolution goes through
            `resolveEntryRoster`, the same function the orchestrator staffs with,
            so the row and the launch agree by construction. */}
        <RosterMenu
          variant="row"
          ariaLabel={`Roster for ${display?.title ?? entry.ref}`}
          rosters={staffing.rosters}
          selectedName={resolveEntryRoster(entry, { roster: staffing.policyRoster }) ?? null}
          inherit={{
            selected: !entry.roster,
            resolvedLabel: staffing.policyRoster?.trim() || NO_ROLES_ROSTER_NAME,
            onChoose: () => onSetRoster(undefined),
          }}
          onSelect={(name) => onSetRoster(name ?? NO_ROLES_ROSTER_NAME)}
          onManageRosters={staffing.onManageRosters}
        />

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
                {/* The member's LIVE lifecycle, from the backlog scan — glyphs,
                    never tone dots (standing ruling), and the same mapping the
                    Horizon board's track rows use (MC-1902). */}
                <LifecycleGlyph
                  state={roadmapMemberLifecycle(display?.status)}
                  label={LIFECYCLE_LABEL[roadmapMemberLifecycle(display?.status)]}
                  className="shrink-0"
                />
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

// The lens/sort option lists — the Backlog door's labels, restated over the same
// shared triage behavior (matchesBacklogView / compareBacklogItems).
const LIBRARY_VIEW_ITEMS: SelectItem<BacklogView>[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All items' },
  { value: 'epics', label: 'Epics' },
  { value: 'quick_wins', label: 'Quick wins' },
  { value: 'strategic_bets', label: 'Strategic bets' },
  { value: 'defer', label: 'Defer candidates' },
  { value: 'unestimated', label: 'Unestimated' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

const LIBRARY_SORT_ITEMS: SelectItem<BacklogSort>[] = [
  { value: 'best', label: 'Best' },
  { value: 'recent', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
]

// The planning rail: every project's backlog through the SAME components the
// Backlog surfaces use — InboxSearchInput + BacklogFilterMenu on top, epic
// grouping and BacklogRowContent/BacklogEpicHeaderContent rows (status glyphs,
// progress meters and badges come with them) — so filtering, sorting, and status
// reading here work exactly like the Backlog. Rail-specific behavior on top: a
// row drags into a track (or click/Enter adds to the first track), and placed
// work dims rather than disappears so the author always sees the whole backlog.
function LibraryRail({
  projects,
  plannedRefs,
  query,
  onQuery,
  view,
  onView,
  sort,
  onSort,
  canAdd,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  projects: RoadmapProjectItems[]
  plannedRefs: ReadonlySet<string>
  query: string
  onQuery: (next: string) => void
  view: BacklogView
  onView: (next: BacklogView) => void
  sort: BacklogSort
  onSort: (next: BacklogSort) => void
  // False when the plan has no track yet — nothing can be added.
  canAdd: boolean
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  // Collapsed projects and epics, keyed stably. A project is open by default; an
  // epic starts COLLAPSED — in a planning rail the epic is the step, its members
  // are a peek (deliberately tighter than the Backlog's expanded default).
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())
  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }
  const now = useMemo(() => Date.now(), [])

  return (
    <aside
      aria-label="Backlog library"
      className="flex w-[300px] shrink-0 flex-col border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2.5">
        <InboxSearchInput
          value={query}
          onChange={onQuery}
          placeholder="Search all backlogs…"
          ariaLabel="Search all project backlogs"
        />
        <BacklogFilterMenu
          view={view}
          sort={sort}
          group="by_epic"
          viewItems={LIBRARY_VIEW_ITEMS}
          sortItems={LIBRARY_SORT_ITEMS}
          groupItems={[]}
          onViewChange={onView}
          onSortChange={onSort}
          onGroupChange={() => undefined}
          defaultView="active"
          defaultSort="best"
          defaultGroup="by_epic"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {projects.map((project) => (
          <LibraryProjectSection
            key={project.projectKey ?? '(home)'}
            project={project}
            plannedRefs={plannedRefs}
            query={query}
            view={view}
            sort={sort}
            canAdd={canAdd}
            now={now}
            collapsed={collapsedProjects.has(project.projectKey ?? '(home)')}
            onToggleCollapsed={() => setCollapsedProjects((set) => toggle(set, project.projectKey ?? '(home)'))}
            expandedEpics={expandedEpics}
            onToggleEpic={(key) => setExpandedEpics((set) => toggle(set, key))}
            onAdd={onAdd}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>

      <p className="shrink-0 border-t border-[color:var(--border-subtle)] px-3 pt-2 pb-2.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
        Placed work is dimmed. Drag an epic in to deliver all of its items as one step.
      </p>
    </aside>
  )
}

function LibraryProjectSection({
  project,
  plannedRefs,
  query,
  view,
  sort,
  canAdd,
  now,
  collapsed,
  onToggleCollapsed,
  expandedEpics,
  onToggleEpic,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  project: RoadmapProjectItems
  plannedRefs: ReadonlySet<string>
  query: string
  view: BacklogView
  sort: BacklogSort
  canAdd: boolean
  now: number
  collapsed: boolean
  onToggleCollapsed: () => void
  expandedEpics: ReadonlySet<string>
  onToggleEpic: (key: string) => void
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element | null {
  const groups = useMemo(
    () => buildLibraryGroupModels(project, plannedRefs, query, view, sort),
    [project, plannedRefs, query, view, sort],
  )
  const progressBySlug = useMemo(() => epicProgressBySlug([...project.items]), [project.items])
  const rowCount = groups.reduce((sum, model) => sum + model.children.length + (model.headerRef ? 1 : 0), 0)
  // A project with nothing under the current lens/search drops out entirely —
  // never an empty header the author must scroll past.
  if (rowCount === 0) return null
  return (
    <section aria-label={`${project.projectName} backlog`} className="min-w-0">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="interactive sticky top-0 z-10 flex h-7 w-full min-w-0 items-center gap-1.5 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 text-left transition-colors hover:bg-[color:var(--bg-hover)]"
      >
        <ChevronGlyph className={collapsed ? '' : 'rotate-90'} />
        <TruncatedText
          as="span"
          text={project.projectName}
          className="min-w-0 flex-1 text-[12px] font-semibold text-[color:var(--text-strong)]"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-disabled)]">{rowCount}</span>
      </button>
      {collapsed ? null : (
        <ul className="flex flex-col py-0.5">
          {groups.map((model) => {
            const epicKey = `${model.key}`
            const epicExpanded = expandedEpics.has(epicKey)
            return (
              <li key={model.key} className="min-w-0">
                {model.group.kind !== 'none' ? (
                  <LibraryEpicHeader
                    model={model}
                    collapsed={!epicExpanded}
                    progress={model.group.slug ? progressBySlug.get(model.group.slug) : undefined}
                    canAdd={canAdd}
                    onToggle={() => onToggleEpic(epicKey)}
                    onAdd={onAdd}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                  />
                ) : null}
                {model.group.kind === 'none' || epicExpanded ? (
                  <ul className={model.group.kind === 'none' ? '' : 'pb-0.5'}>
                    {model.children.map((child) => (
                      <LibraryItemRow
                        key={child.ref}
                        item={child.item}
                        itemRef={child.ref}
                        planned={child.planned}
                        indented={model.group.kind !== 'none'}
                        canAdd={canAdd}
                        now={now}
                        onAdd={onAdd}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// An epic group header: the shared Backlog header row (glyph, title, progress
// meter, collapse chevron), made a plan affordance — click/Enter adds the epic
// as ONE step, drag carries it into a track.
function LibraryEpicHeader({
  model,
  collapsed,
  progress,
  canAdd,
  onToggle,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  model: LibraryGroupModel
  collapsed: boolean
  progress: { done: number; total: number } | undefined
  canAdd: boolean
  onToggle: () => void
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const addable = model.headerRef !== null && !model.headerPlanned && canAdd
  return (
    <div
      role="button"
      tabIndex={addable ? 0 : -1}
      aria-label={
        model.headerPlanned
          ? `${model.group.title} — already in the plan`
          : `Add the epic ${model.group.title} to the plan as one step`
      }
      aria-disabled={!addable}
      draggable={addable}
      onDragStart={(event) => {
        if (!model.headerRef) return
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('text/plain', model.headerRef)
        onDragStart(model.headerRef)
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (addable && model.headerRef) onAdd(model.headerRef)
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && addable && model.headerRef) {
          event.preventDefault()
          onAdd(model.headerRef)
        } else if (event.key === 'ArrowRight' && collapsed) {
          // Keyboard member peek — the chevron itself is tabIndex -1, so the
          // header carries expand/collapse (the tree-view arrow idiom).
          event.preventDefault()
          onToggle()
        } else if (event.key === 'ArrowLeft' && !collapsed) {
          event.preventDefault()
          onToggle()
        }
      }}
      className={`px-3 py-1 transition-colors ${
        model.headerPlanned ? 'opacity-40' : 'cursor-grab hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      <BacklogEpicHeaderContent group={model.group} collapsed={collapsed} onToggleCollapse={onToggle} progress={progress} />
    </div>
  )
}

// One addable item row: the shared Backlog row content (status glyph, id, title,
// badges) inside an add button; drag carries the ref into a track.
function LibraryItemRow({
  item,
  itemRef,
  planned,
  indented,
  canAdd,
  now,
  onAdd,
  onDragStart,
  onDragEnd,
}: {
  item: BacklogItem
  itemRef: string
  planned: boolean
  indented: boolean
  canAdd: boolean
  now: number
  onAdd: (ref: string) => void
  onDragStart: (ref: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const addable = !planned && canAdd
  return (
    <li
      draggable={addable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('text/plain', itemRef)
        onDragStart(itemRef)
      }}
      onDragEnd={onDragEnd}
      className="min-w-0 list-none"
    >
      <button
        type="button"
        disabled={!addable}
        onClick={() => onAdd(itemRef)}
        aria-label={planned ? `${item.title} — already in the plan` : `Add ${item.title} to the plan`}
        className={`interactive block w-full text-left ${indented ? 'pl-6 pr-3' : 'px-3'} py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary-soft)] ${
          planned ? 'opacity-40' : 'cursor-grab hover:bg-[color:var(--bg-hover)]'
        }`}
      >
        <BacklogRowContent item={item} now={now} plainTitle />
      </button>
    </li>
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

// The Horizon mark: a sun setting on the horizon line (matches the door glyph).
function RoadmapGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M4.8 11 a3.2 3.2 0 0 1 6.4 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M2 11 H14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M8 5.4 V3.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M4.2 6.8 3.2 5.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M11.8 6.8 12.8 5.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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
