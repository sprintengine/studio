import { useMemo } from 'react'

import { LOCAL_HOST_ID } from '../../../../shared/execution-host'
import { useAppUpdateStore } from '../../store/appUpdateStore'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  outstandingAppUpdate,
  outstandingCliUpdates,
  settingsUpdateBadges,
  type SettingsUpdateBadges,
} from '../../utils/settingsUpdateBadges'

// The Settings update badges, read from the stores that already hold their
// facts: the CLI version advisories of every machine and this machine's
// detection (workspace store), the app update state (appUpdateStore), and what
// the person dismissed (notification store). One hook for the rail glyph, the
// Settings nav, the machine switcher and the CLI rows, so they are one
// derivation (settingsUpdateBadges.ts).
export function useSettingsUpdateBadges(): SettingsUpdateBadges {
  const advisories = useWorkspaceStore((s) => s.cliVersionAdvisories)
  const checkCliVersions = useWorkspaceStore((s) => s.checkCliVersions)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const appUpdateState = useAppUpdateStore((s) => s.state)
  const dismissed = useNotificationStore((s) => s.dismissedUpdates)

  return useMemo(() => {
    const cliUpdates = outstandingCliUpdates({
      advisories,
      checkCliVersions,
      // This machine's list reads the store's detection, so a stale advisory is
      // checked against it. A WSL machine's advisory is only ever `behind` for
      // a CLI main's own detection found there, and its list is not in the
      // store, so main's word is the one there is.
      installed: (hostId, cli) =>
        hostId !== LOCAL_HOST_ID || cliAvailability[cli as keyof typeof cliAvailability]?.installed === true,
      dismissed,
    })
    const appUpdate = outstandingAppUpdate({ state: appUpdateState, dismissed })
    return settingsUpdateBadges({ cliUpdates, appUpdate })
  }, [advisories, checkCliVersions, cliAvailability, appUpdateState, dismissed])
}
