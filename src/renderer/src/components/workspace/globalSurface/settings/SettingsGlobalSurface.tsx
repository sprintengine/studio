import React from 'react'

import { useWorkspaceStore } from '../../../../store/workspaceStore'

// The Settings door. Settings was a centred modal over the app it configures —
// the one surface in the product that dimmed everything and trapped focus to
// show a list and a form. It is a door now (owner, 2026-07-30): the categories
// replace the sidebar rail, the content takes the card region, and the name
// rides the app strip, the same as every other door. The cog at the foot of the
// sidebar still opens it.
//
// Store-wired so SettingsPanel stays a plain component: this reads the request
// that opened the door (which category, and whether the caller asked for an
// update check) and hands back the way out.
const SettingsPanel = React.lazy(() => import('../../../settings/SettingsPanel'))

export default function SettingsGlobalSurface(): JSX.Element {
  const request = useWorkspaceStore((state) => state.settingsOverlay)
  const openSettingsOverlay = useWorkspaceStore((state) => state.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((state) => state.closeSettingsOverlay)

  return (
    <SettingsPanel
      chrome="door"
      initialTab={request.initialTab}
      checkForUpdatesRequestId={request.checkForUpdatesRequestId ?? undefined}
      // A settings deep-link from inside settings (a section pointing at
      // another) re-requests the door rather than stacking anything.
      onOpenSettingsTab={(tabId) => openSettingsOverlay({ initialTab: tabId })}
      onClose={closeSettingsOverlay}
    />
  )
}
