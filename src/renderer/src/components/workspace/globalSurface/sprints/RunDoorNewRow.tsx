import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { listAutomationProjectFolders } from '../../../../utils/automationsEntry'
import { BacklogItemSearchPicker, type BacklogItemSearchOption } from '../../../backlog/BacklogItemSearchPicker'
import { GhostButton, PrimaryButton, Select, Textarea, type SelectItem } from '../../../ui'
import { FOCUS_RING_CLASS } from '../../../ui/tokens'
import { useBacklogScan } from '../../newWorkspace/useBacklogScan'
import { buildNewSprintSource, epicPickKey } from '../../newSprint/newSprintModel'
import { isBacklogEpicPath } from '../../../../utils/backlogEpics'
import type { SprintEngineRoster } from '../../../../types/workspace'
import { noteSprintDoorDraft, requestNewSprint } from './sprintDoorRequests'
import type { RunDoorDefinition } from './runDoorCopy'

// The `+` at the end of a door's list, and what it opens (item 2470, mockup
// Frame 1).
//
// It opens INLINE, on the row where the plus was. A modal is for interrupting
// somebody, and somebody who just pressed new is not being interrupted (owner
// ruling R7) — so the row becomes the form, in place, and pressing Escape or
// Cancel turns it back into the row with focus back on it. Nothing here traps
// focus: the form is part of the rail's own list, Tab leaves it the way it
// leaves any other control, and the only thing that changes on cancel is that
// the plus is a plus again.
//
// It also creates nothing. Each door asks for the one thing it is about and
// hands the answer to the EXISTING creation path through `sprintDoorRequests`:
//
//   • Sprints asks which work to run, and builds its answer with
//     `buildNewSprintSource` — byte for byte the source a Backlog row's "Run a
//     Sprint" builds, so the run that comes out is the run that path produces.
//   • Workflows asks for a goal and a roster, and hands both over as the door
//     draft the New sprint dialog opens on. A workflow plans from something
//     written down, so the goal becomes the title of the item that dialog's own
//     capture writes — the existing path, opened on what was already said.
//
// A second creation path would mean a second set of rules about connectors,
// isolation, rosters and backlog links, which is exactly what "no new creation
// logic" forbids.

const EMPTY_ROSTERS: SprintEngineRoster[] = []

const PLUS_ICON = (
  <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

// The rail's own dashed New row, at the END of the list rather than the top of
// it. Same shape as `SurfaceRailHeader`'s, deliberately: one affordance means
// one appearance, wherever in the column it sits.
const NEW_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md border border-dashed border-[color:var(--border-default)] px-2 py-1.5 text-left text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'

export function RunDoorNewRow({
  door,
  /** The project the rail's lens is narrowed to, if any — the row starts there. */
  projectFilter,
}: {
  door: RunDoorDefinition
  projectFilter: string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const plusRef = useRef<HTMLButtonElement | null>(null)
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLDivElement | null>(null)

  // Closing returns focus to the plus, so cancelling never drops the operator
  // at the top of the document. Opening moves it into the first field, which is
  // what makes the row usable from the keyboard at all.
  const close = useCallback(() => {
    setOpen(false)
    plusRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const node = firstFieldRef.current
    if (node instanceof HTMLTextAreaElement) node.focus()
    else node?.querySelector('input')?.focus()
  }, [open])

  if (!open) {
    return (
      <div className="px-1 pt-1">
        <button
          ref={plusRef}
          type="button"
          onClick={() => setOpen(true)}
          className={`${NEW_ROW_CLASS} ${FOCUS_RING_CLASS}`}
        >
          {PLUS_ICON}
          {door.newRowLabel}
        </button>
      </div>
    )
  }

  return (
    <div
      className="mt-1 flex flex-col gap-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-2"
      onKeyDown={(event) => {
        // Escape closes the row and nothing else. It does not reach the door
        // behind it, which would close the surface out from under an operator
        // who only meant to abandon a form.
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <p className="px-0.5 text-micro font-medium text-[color:var(--text-muted)]">{door.newRowPrompt}</p>
      {door.id === 'workflows' ? (
        <WorkflowsNewRowFields door={door} firstFieldRef={firstFieldRef} onDone={close} />
      ) : (
        <SprintNewRowFields
          door={door}
          projectFilter={projectFilter}
          firstFieldRef={firstFieldRef}
          onDone={close}
        />
      )}
      <div className="flex justify-end">
        <GhostButton type="button" onClick={close} className="h-6 px-2 text-micro">
          Cancel
        </GhostButton>
      </div>
    </div>
  )
}

// ── Workflows: a goal, and the roster that will do it ────────────────────────
// The whole form, per the mockup — the architect works out the rest, and the
// plan it writes is the thing you review.
function WorkflowsNewRowFields({
  door,
  firstFieldRef,
  onDone,
}: {
  door: RunDoorDefinition
  firstFieldRef: React.MutableRefObject<HTMLTextAreaElement | HTMLDivElement | null>
  onDone: () => void
}): JSX.Element {
  const [goal, setGoal] = useState('')
  const [rosterId, setRosterId] = useState('')
  const rosters = useWorkspaceStore(
    (state) => state.appSettings.sprintEngineRoleSettings?.savedRosters ?? EMPTY_ROSTERS,
  )
  // The empty option resolves the way the dialog itself resolves an unstated
  // roster — the one you last used there — so the label says that rather than
  // promising a fixed default the resolver does not deliver.
  const rosterItems: SelectItem[] = useMemo(
    () => [
      { value: '', label: 'Last used roster' },
      ...rosters.map((roster) => ({ value: roster.id, label: roster.name })),
    ],
    [rosters],
  )

  const start = (): void => {
    const trimmed = goal.trim()
    if (!trimmed) return
    noteSprintDoorDraft({ goal: trimmed, rosterId: rosterId || null })
    requestNewSprint(undefined, 'workflows')
    onDone()
  }

  return (
    <>
      <Textarea
        ref={firstFieldRef as React.MutableRefObject<HTMLTextAreaElement | null>}
        value={goal}
        rows={3}
        placeholder="e.g. Rebuild the settings screen"
        aria-label={door.newRowPrompt}
        onChange={(event) => setGoal(event.target.value)}
      />
      <Select
        ariaLabel="Roster for this workflow"
        value={rosterId}
        items={rosterItems}
        onChange={setRosterId}
      />
      <PrimaryButton type="button" disabled={goal.trim().length === 0} onClick={start}>
        {door.newRowSubmitLabel}
      </PrimaryButton>
    </>
  )
}

// ── Sprints: the work you already have ───────────────────────────────────────
// Backlog items and epics. No roster to choose, because nothing is being routed
// by kind — which is the whole difference between the two doors.
function SprintNewRowFields({
  door,
  projectFilter,
  firstFieldRef,
  onDone,
}: {
  door: RunDoorDefinition
  projectFilter: string | null
  firstFieldRef: React.MutableRefObject<HTMLTextAreaElement | HTMLDivElement | null>
  onDone: () => void
}): JSX.Element {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const projects = useMemo(() => listAutomationProjectFolders(workspaces), [workspaces])
  const [projectRoot, setProjectRoot] = useState<string>(
    () => projectFilter ?? projects[0]?.folderPath ?? '',
  )
  const scan = useBacklogScan(projectRoot || null)
  const options = useMemo(
    (): BacklogItemSearchOption[] =>
      scan.result.items.map((item) => ({
        id: item.id,
        value: item.relativePath,
        title: item.title,
        displayId: item.displayId,
        searchText: item.relativePath,
      })),
    [scan.result.items],
  )

  const pick = (option: BacklogItemSearchOption): void => {
    // An epic is picked by its epic key so the existing builder expands it to
    // its open children, exactly as the dialog's own list does.
    const pickedKey = isBacklogEpicPath(option.value)
      ? epicPickKey(option.value.replace(/^.*[\\/]/u, '').replace(/\.(md|html?)$/iu, ''))
      : option.value
    const source = buildNewSprintSource({
      workspaceRoot: projectRoot,
      pickedKeys: [pickedKey],
      items: scan.result.items,
    })
    if (!source) return
    requestNewSprint(source, 'sprints')
    onDone()
  }

  if (projects.length === 0) {
    return (
      <p className="px-0.5 text-micro leading-4 text-[color:var(--text-muted)]">
        Open a project to pick work from its backlog.
      </p>
    )
  }

  return (
    <>
      {projects.length > 1 ? (
        <Select
          ariaLabel="Project to take the work from"
          value={projectRoot}
          items={projects.map((project) => ({ value: project.folderPath, label: project.displayName }))}
          onChange={setProjectRoot}
        />
      ) : null}
      <div ref={firstFieldRef as React.MutableRefObject<HTMLDivElement | null>}>
        <BacklogItemSearchPicker
          options={options}
          onSelect={pick}
          ariaLabel={door.newRowPrompt}
          noOptionsMessage={scan.isScanning ? 'Scanning the backlog…' : 'No backlog items found.'}
          resultRole="listbox"
        />
      </div>
    </>
  )
}
