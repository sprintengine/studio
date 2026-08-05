// The roster manager (MC-1880): the ONE door behind the Horizon roster
// picker's single "Manage rosters…" action. Since MC-2065 it is shell plus
// editor: this file owns the modal chrome (scrim, dialog, header, footer) and
// mounts the shared shell-free `RosterEditor` — the same surface the New
// sprint dialog hosts as its second screen — driven by the very same
// `useRosterEditor()` seam (MC-1879).
//
// Reuse over lookalikes is the point: this file contributes NO roster state of
// its own. If it ever needs some, the boundary in useRosterEditor was drawn
// wrong.
//
// Editing here is GLOBAL — a roster is shared with the New sprint dialog and
// with every other horizon — and the modal says so plainly rather than implying
// a horizon-local copy.
import { useMemo } from 'react'

import { GhostButton, PrimaryButton } from '../ui'
import { Modal } from '../ui/Modal'
import { RosterEditor } from './RosterEditor'
import { useRosterEditor } from '../workspace/newWorkspace/useRosterEditor'
import { selectAgentCliCatalog } from '../workspace/newWorkspace/cliRuntimeOptions'
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

  const selected = roster.rosters.find((entry) => entry.id === roster.selectedRosterId) ?? null

  return (
    // `Modal` owns the shell: the scrim (never backdrop-filter — backdrop-blur
    // drops the surface to ~10fps), the modal layer, the focus trap, Escape,
    // focus restore, and the geometry. This file kept private copies of all of
    // those, down to its own `rounded-lg` and `border-default`, and gained
    // click-outside close by giving them up (MC-2110). The door substrate
    // portals this above the scrolling editor rather than nesting it inside.
    <Modal open onClose={onClose} label="Manage rosters" size="wide" layout="panel">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
        <h2 className="text-heading font-semibold text-[color:var(--text-strong)]">Rosters</h2>
        <p className="mt-1 text-meta text-[color:var(--text-muted)]">
          Rosters are shared. Editing one here changes it everywhere it is used — in the
          New sprint dialog and in every horizon.
        </p>
      </header>

      <RosterEditor editor={roster} />

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
    </Modal>
  )
}
