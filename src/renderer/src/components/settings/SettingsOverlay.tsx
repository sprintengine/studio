import React, { useCallback } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Drawer } from '../ui'
import SettingsPanel from './SettingsPanel'

const SETTINGS_DRAWER_WIDTH = 540

export default function SettingsOverlay() {
  const overlay = useWorkspaceStore((s) => s.settingsOverlay)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)

  const handleOpenSettingsTab = useCallback(
    (tabId: string) => {
      openSettingsOverlay({ initialTab: tabId })
    },
    [openSettingsOverlay],
  )

  return (
    <Drawer
      open={overlay.open}
      onClose={closeSettingsOverlay}
      title="Settings"
      ariaLabel="Settings"
      width={SETTINGS_DRAWER_WIDTH}
    >
      <Drawer.Body className="!p-0">
        <SettingsPanel
          chrome="overlay"
          initialTab={overlay.initialTab}
          checkForUpdatesRequestId={overlay.checkForUpdatesRequestId ?? undefined}
          onOpenSettingsTab={handleOpenSettingsTab}
          onClose={closeSettingsOverlay}
        />
      </Drawer.Body>
    </Drawer>
  )
}
