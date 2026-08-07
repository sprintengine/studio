// The sprint-chaining action's own field group (item 2042): the backlog item the
// chained sprint starts from, and the team that staffs it.
//
// A field group beside `TriggerFields` and `AgentFields`, on the same contract:
// the editor owns the form state and the one save path, and this renders the two
// dedicated pickers the `sprint-engine-start` action earns instead of the
// generic free-text inputs. The editor's generic config loop skips both keys.

import { useMemo } from 'react'

import { Field, GhostButton, Select, type SelectItem } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { BacklogItemSearchPicker, type BacklogItemSearchOption } from '../../backlog/BacklogItemSearchPicker'
import { useBacklogScan } from '../../workspace/newWorkspace/useBacklogScan'
import type { SprintEngineRoster } from '../../../types/workspace'

// Stable empty fallback so the saved-teams selector doesn't churn refs per render.
const EMPTY_SAVED_TEAMS: SprintEngineRoster[] = []

export function SprintStartFields({
  active,
  workspaceRoot,
  backlogItem,
  team,
  onPatchConfig,
}: {
  /** The selected action is `sprint-engine-start`. The backlog scan is gated on
   *  this rather than on the group being mounted, so an action that consumes
   *  neither field never scans. */
  active: boolean
  workspaceRoot: string
  backlogItem: string | undefined
  team: string | undefined
  onPatchConfig: (patch: Record<string, string>) => void
}): JSX.Element | null {
  const backlogScan = useBacklogScan(active ? workspaceRoot : null)
  const backlogOptions = useMemo((): BacklogItemSearchOption[] =>
    backlogScan.result.items
      // The action chains from leaf items (epic launches bundle children — a
      // wizard flow), so epics are not offered.
      .filter((item) => !item.relativePath.startsWith('backlog/epics/'))
      .map((item) => ({
        id: item.id,
        value: item.relativePath,
        title: item.title,
        displayId: item.displayId,
        searchText: item.relativePath,
      })),
  [backlogScan.result.items])
  const sprintSavedTeams = useWorkspaceStore(
    (s) => s.appSettings.sprintEngineRoleSettings?.savedRosters ?? EMPTY_SAVED_TEAMS,
  )
  const sprintTeamItems: SelectItem[] = useMemo(() => {
    // The empty option resolves like the sprint wizard does (the last team you
    // used there, else the built-in default) — the label must say so, not
    // promise a fixed "default roster" the resolver doesn't deliver.
    const items: SelectItem[] = [{ value: '', label: 'Last used team' }]
    for (const saved of sprintSavedTeams) items.push({ value: saved.name, label: saved.name })
    const stored = team?.trim()
    if (stored && !items.some((item) => item.value === stored)) {
      items.push({ value: stored, label: `${stored} — missing`, tone: 'warn' })
    }
    return items
  }, [sprintSavedTeams, team])

  if (!active) return null

  return (
    <>
      {/* No `htmlFor`: the row is a composite — the chosen item with a
          Clear button, above a search picker — not one labellable
          control, and the picker names itself. Passing one put the id
          on the wrapper div, where a `<label for>` cannot reach. */}
      <Field
        label="Start from backlog item"
        required
        help="The chained sprint plans and works this item on the refreshed base branch."
      >
        <div className="flex flex-col gap-1.5">
          {backlogItem ? (
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-micro text-[color:var(--text-muted)]">
                {backlogItem}
              </code>
              <GhostButton
                type="button"
                onClick={() => onPatchConfig({ backlogItem: '' })}
                className="h-6 shrink-0 px-2 text-micro"
              >
                Clear
              </GhostButton>
            </div>
          ) : null}
          <BacklogItemSearchPicker
            options={backlogOptions}
            selectedValues={backlogItem ? [backlogItem] : []}
            onSelect={(option) => onPatchConfig({ backlogItem: option.value })}
            ariaLabel="Backlog item to start the next sprint from"
            noOptionsMessage={backlogScan.isScanning ? 'Scanning the backlog…' : 'No backlog items found.'}
            resultRole="listbox"
          />
        </div>
      </Field>
      <Field
        label="Team"
        htmlFor="automation-sprint-start-team"
        help="Saved team that staffs the chained sprint. “Last used team” resolves like the sprint wizard: the team you last picked there, else the built-in default."
      >
        <Select
          ariaLabel="Saved team for the chained sprint"
          value={team?.trim() || ''}
          onChange={(value) => onPatchConfig({ team: value })}
          items={sprintTeamItems}
        />
      </Field>
      <p className="text-micro leading-relaxed text-[color:var(--text-subtle)]">
        Starts a new sprint each time the watched sprint finishes and lands. Deleting
        and recreating the watched sprint counts as a fresh landing, so it starts again.
        To stop two chained automations from restarting each other, chains default to
        “Run once, then pause” — turn that off below to keep it firing.
      </p>
    </>
  )
}
