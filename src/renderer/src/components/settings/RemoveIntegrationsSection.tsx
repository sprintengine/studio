import React, { useState } from 'react'

import { OutlineButton } from '../ui'
import { RemoveIntegrationsDialog } from './RemoveIntegrationsDialog'
import { SettingCard, SettingsRow } from './SettingsAtoms'

/**
 * Settings ▸ General: the one place that takes back out everything Studio
 * wrote outside its own data — hooks and MCP entries in repositories, CLI
 * configuration, tailnet shares, worktree locks, the link handler, and what is
 * inside WSL distributions. Meant for just before an uninstall.
 */
export function RemoveIntegrationsSection(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <SettingCard className="mt-5">
      <SettingsRow
        label="Studio’s integrations"
        help="Hooks, MCP entries and settings Studio added to your repositories and agent CLIs. Remove them before you uninstall Studio."
      >
        <OutlineButton size="md" onClick={() => setOpen(true)}>
          Remove…
        </OutlineButton>
      </SettingsRow>
      <RemoveIntegrationsDialog
        open={open}
        onClose={() => setOpen(false)}
        onQuit={() => void window.api.integrationsQuitApp()}
      />
    </SettingCard>
  )
}
