// The roster-editing surface (MC-2065), extracted from RosterManagerModal so
// every host mounts the SAME editor instead of a lookalike — today the New
// sprint dialog's second screen (MC-2062).
//
// Shell-free BY CONTRACT: no dialog role, no aria-modal, no scrim. Hosts own
// all chrome — the dialog host is itself a modal, and nesting two aria-modal
// surfaces breaks focus containment. And like the modal before it, this file
// contributes NO roster state of its own: everything flows through the
// useRosterEditor result it is handed. If it ever needs some, the boundary in
// useRosterEditor was drawn wrong.
import { useId, useState } from 'react'

import { EmptyState, FOCUS_RING_CLASS, InlineNotice, Input, PrimaryButton } from '../ui'
import { SprintEngineRosterPanel } from '../workspace/newWorkspace/SprintEngineRosterPanel'
import type { useRosterEditor } from '../workspace/newWorkspace/useRosterEditor'
import { NO_ROLES_ROSTER_NAME, sprintEngineRosterNameTaken } from '../workspace/newWorkspace/savedRosters'

export function RosterEditor({
  editor,
  className,
}: {
  /** The one state seam: a host mounts useRosterEditor and hands the result over. */
  editor: ReturnType<typeof useRosterEditor>
  className?: string
}): JSX.Element {
  // Transient input for the rail's create box — form state, not roster state.
  const [newName, setNewName] = useState('')
  // Two editors can be live at once (a wizard open behind a modal), so the
  // label target cannot be a fixed id.
  const newNameId = useId()
  const trimmedNewName = newName.trim()
  const nameCollides = sprintEngineRosterNameTaken(editor.rosters, trimmedNewName)
  const canCreate = trimmedNewName.length > 0 && !nameCollides

  return (
    <div className={`flex min-h-0 flex-1${className ? ` ${className}` : ''}`}>
      <div className="flex w-[220px] shrink-0 flex-col border-r border-[color:var(--border-default)]">
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {editor.rosters.length === 0 ? (
            <EmptyState density="list" title="No saved rosters yet." />
          ) : (
            editor.rosters.map((entry) => {
              const staffed = Object.values(entry.roleCounts).filter((count) => (count ?? 0) > 0).length
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={entry.id === editor.selectedRosterId}
                  onClick={() => editor.onSelectRoster(entry.id)}
                  // Selection is neutral: the selected fill and a title lift, never
                  // the accent — that is spent on "New roster" below.
                  className={`interactive flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-meta ${FOCUS_RING_CLASS} ${
                    entry.id === editor.selectedRosterId
                      ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                      : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
                    {staffed}
                  </span>
                </button>
              )
            })
          )}
        </div>
        {/* Padding separates the create box from the list above — no hairline
            inside a dialog-hosted surface. */}
        <div className="shrink-0 p-1.5 pt-2">
          <label className="sr-only" htmlFor={newNameId}>New roster name</label>
          <Input
            id={newNameId}
            size="sm"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New roster name"
            aria-invalid={nameCollides || undefined}
          />
          {nameCollides ? (
            <InlineNotice tone="error" className="mt-1.5">
              {trimmedNewName.toLowerCase() === NO_ROLES_ROSTER_NAME.toLowerCase()
                ? `“${NO_ROLES_ROSTER_NAME}” is the built-in default and cannot be reused.`
                : `A roster named “${trimmedNewName}” already exists.`}
            </InlineNotice>
          ) : null}
          <PrimaryButton
            className="mt-1.5 w-full"
            disabled={!canCreate}
            onClick={() => {
              if (!canCreate) return
              editor.onSaveRoster(trimmedNewName)
              setNewName('')
            }}
          >
            New roster
          </PrimaryButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* The wizard's roster panel, unchanged, driven by the same hook.
            Role rows only (MC-2064): configuring a roster is picking roles,
            so there is no formation control here. */}
        <SprintEngineRosterPanel
          roleCounts={editor.roleCounts}
          roleCliDefaults={editor.roleCliDefaults}
          roleModelOverrides={editor.roleModelOverrides}
          onSetRoleCount={editor.onSetRoleCount}
          onSetRoleCli={editor.onSetRoleCli}
          onSetRoleModel={editor.onSetRoleModel}
          cliOptions={editor.cliOptions}
          registry={editor.registry}
          registryStatus={editor.registryStatus}
          disabledRoleIds={editor.disabledRoleIds}
          rosterDisabled={editor.rosterDisabled}
          hasExistingTeam={false}
          rosters={editor.rosters}
          selectedRosterId={editor.selectedRosterId}
          selectedRosterDirty={editor.selectedRosterDirty}
          onSelectRoster={editor.onSelectRoster}
          onSaveRoster={editor.onSaveRoster}
          onUpdateRoster={editor.onUpdateRoster}
          onRenameRoster={editor.onRenameRoster}
          onDeleteRoster={editor.onDeleteRoster}
        />
      </div>
    </div>
  )
}
