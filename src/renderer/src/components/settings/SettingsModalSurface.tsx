import React, { type JSX } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'

// The Settings modal body (doors→modals, 2026-09-01). Settings was a centred
// modal, then a door (owner, 2026-07-30), and is a modal again (owner,
// 2026-09-01): the door's full-page takeover was heavyweight for flip-a-switch
// visits, and a modal keeps the workspace — terminals included — in place
// behind the flat scrim. The gear at the foot of the sidebar still opens it.
//
// Store-wired so SettingsPanel stays a plain component: this reads the request
// that opened the modal (which category, and whether the caller asked for an
// update check) and hands back the way out. The host Modal supplies the dialog
// shell and its accessible name; `chrome="overlay"` renders the shared
// surface-shell anatomy inside it, with the host's X as the close.
const SettingsPanel = React.lazy(() => import('./SettingsPanel'))

export default function SettingsModalSurface(): JSX.Element {
  const request = useWorkspaceStore((state) => state.settingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((state) => state.closeSettingsOverlay)

  return (
    <SettingsPanel
      chrome="overlay"
      initialTab={request.initialTab}
      checkForUpdatesRequestId={request.checkForUpdatesRequestId ?? undefined}
      agentsMachineRequest={request.agentsMachineRequest}
      onClose={closeSettingsOverlay}
    />
  )
}
