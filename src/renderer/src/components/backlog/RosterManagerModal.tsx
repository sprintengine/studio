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
import { useEffect, useMemo, useRef } from 'react'

import { FocusTrap, GhostButton, PrimaryButton } from '../ui'
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

  const dialogRef = useRef<HTMLDivElement>(null)

  // Initial focus and focus restore — the contract every dialog in the app
  // keeps (MC-2109). No dependencies, so a re-created `onClose` cannot re-run
  // focus and drag the keyboard back to the dialog shell mid-edit.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      const node = dialogRef.current
      if (!node || node.contains(document.activeElement)) return
      node.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // Escape is not optional now that the surface traps the keyboard: a trap with
  // no way out IS the bug, and this dialog had no key close of its own. It
  // yields to a nested surface that already handled the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // House rule: `.overlay-scrim`, never backdrop-filter — backdrop-blur drops
    // the surface to ~10fps. The door substrate portals this above the
    // scrolling editor rather than nesting it inside. The modal layer comes
    // from the token, like every other overlay (MC-2109).
    <div className="overlay-scrim fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6">
      <FocusTrap>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Manage rosters"
          tabIndex={-1}
          className="flex max-h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-modal)] outline-none"
        >
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
        </div>
      </FocusTrap>
    </div>
  )
}
