// The roster manager (MC-1880): the ONE door behind the Horizon roster
// picker's single "Manage rosters…" action. It lists every saved roster, and
// selecting one edits it in the very same `SprintEngineRosterPanel` the sprint
// wizard uses, driven by the very same `useRosterEditor()` seam (MC-1879).
//
// Reuse over lookalikes is the point: this file contributes NO roster state of
// its own. If it ever needs some, the boundary in useRosterEditor was drawn
// wrong.
//
// Editing here is GLOBAL — a roster is shared with the sprint wizard and with
// every other horizon — and the modal says so plainly rather than implying a
// horizon-local copy.
import { useMemo, useState } from 'react'

import { GhostButton, PrimaryButton } from '../ui'
import { SprintEngineRosterPanel } from '../workspace/newWorkspace/SprintEngineRosterPanel'
import { useRosterEditor } from '../workspace/newWorkspace/useRosterEditor'
import { selectAgentCliCatalog } from '../workspace/newWorkspace/cliRuntimeOptions'
import { NO_ROLES_ROSTER_NAME, sprintEngineRosterNameTaken } from '../workspace/newWorkspace/savedRosters'
import { useWorkspaceStore } from '../../store/workspaceStore'

export function RosterManagerModal({
  workspaceRoot,
  onClose,
  onRosterChosen,
}: {
  /** Project root the role registry is read from. */
  workspaceRoot: string | null
  onClose: () => void
  /** Creating or picking a roster here returns to Horizon with it selected. */
  onRosterChosen: (name: string) => void
}): JSX.Element {
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const appCliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)

  const cliOptions = useMemo(
    () => selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, appCliRuntimes, {
      map: cliAvailability,
      status: cliAvailabilityStatus,
    }, cliModelCatalog),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      appCliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
    ],
  )

  const roster = useRosterEditor({
    cliOptions,
    cliAvailabilityStatus,
    workspaceRoot,
  })

  const [newName, setNewName] = useState('')
  const trimmedNewName = newName.trim()
  const nameCollides = sprintEngineRosterNameTaken(roster.rosters, trimmedNewName)
  const canCreate = trimmedNewName.length > 0 && !nameCollides

  const selected = roster.rosters.find((entry) => entry.id === roster.selectedRosterId) ?? null

  return (
    // House rule: `.overlay-scrim`, never backdrop-filter — backdrop-blur drops
    // the surface to ~10fps. The door substrate portals this above the
    // scrolling editor rather than nesting it inside.
    <div className="overlay-scrim fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage rosters"
        className="flex max-h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-modal)]"
      >
        <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[color:var(--text-strong)]">Rosters</h2>
          <p className="mt-1 text-[12px] text-[color:var(--text-muted)]">
            Rosters are shared. Editing one here changes it everywhere it is used — in the
            sprint wizard and in every horizon.
          </p>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[220px] shrink-0 flex-col border-r border-[color:var(--border-default)]">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {roster.rosters.length === 0 ? (
                <p className="px-2 py-3 text-[12px] text-[color:var(--text-subtle)]">
                  No saved rosters yet.
                </p>
              ) : (
                roster.rosters.map((entry) => {
                  const staffed = Object.values(entry.roleCounts).filter((count) => (count ?? 0) > 0).length
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => roster.onSelectRoster(entry.id)}
                      className={`interactive flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] ${
                        entry.id === roster.selectedRosterId
                          ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
                          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">
                        {staffed}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
            <div className="shrink-0 border-t border-[color:var(--border-default)] p-1.5">
              <label className="sr-only" htmlFor="roster-manager-new-name">New roster name</label>
              <input
                id="roster-manager-new-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="New roster name"
                className="w-full rounded border border-[color:var(--border-default)] bg-transparent px-2 py-1 text-[12px] text-[color:var(--text-default)] outline-none placeholder:text-[color:var(--text-disabled)] focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
              />
              {nameCollides ? (
                <p className="mt-1 px-0.5 text-[11px] text-[color:var(--tone-error)]">
                  {trimmedNewName.toLowerCase() === NO_ROLES_ROSTER_NAME.toLowerCase()
                    ? `“${NO_ROLES_ROSTER_NAME}” is the built-in default and cannot be reused.`
                    : `A roster named “${trimmedNewName}” already exists.`}
                </p>
              ) : null}
              <PrimaryButton
                className="mt-1.5 w-full"
                disabled={!canCreate}
                onClick={() => {
                  if (!canCreate) return
                  roster.onSaveRoster(trimmedNewName)
                  setNewName('')
                }}
              >
                New roster
              </PrimaryButton>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* The wizard's roster panel, unchanged, driven by the same hook. */}
            <SprintEngineRosterPanel
              rosterMode={roster.rosterMode}
              onChangeRosterMode={roster.onChangeRosterMode}
              roleCounts={roster.roleCounts}
              roleCliDefaults={roster.roleCliDefaults}
              roleModelOverrides={roster.roleModelOverrides}
              onSetRoleCount={roster.onSetRoleCount}
              onSetRoleCli={roster.onSetRoleCli}
              onSetRoleModel={roster.onSetRoleModel}
              cliOptions={roster.cliOptions}
              registry={roster.registry}
              registryStatus={roster.registryStatus}
              disabledRoleIds={roster.disabledRoleIds}
              rosterDisabled={roster.rosterDisabled}
              hasExistingTeam={false}
              rosters={roster.rosters}
              selectedRosterId={roster.selectedRosterId}
              selectedRosterDirty={roster.selectedRosterDirty}
              onSelectRoster={roster.onSelectRoster}
              onSaveRoster={roster.onSaveRoster}
              onUpdateRoster={roster.onUpdateRoster}
              onRenameRoster={roster.onRenameRoster}
              onDeleteRoster={roster.onDeleteRoster}
              poolAgentCount={roster.poolAgentCount}
              onChangePoolAgentCount={roster.onChangePoolAgentCount}
            />
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[color:var(--border-default)] px-4 py-3">
          <GhostButton onClick={onClose}>Close</GhostButton>
          <PrimaryButton
            disabled={!selected}
            onClick={() => {
              if (!selected) return
              onRosterChosen(selected.name)
            }}
          >
            Use for this horizon
          </PrimaryButton>
        </footer>
      </div>
    </div>
  )
}
