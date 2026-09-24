// The toast that says an app update has downloaded, and restarting into it.

import type { AppUpdateState } from '../../../../../shared/electron-api'
import { publishDiagnosticSync } from '../../../utils/diagnostics'
import { updateReadyNotice } from '../../../utils/feedNotifications'
import { appUpdateKey } from '../../../utils/settingsUpdateBadges'
import { useNotificationStore } from '../../../store/notificationStore'
import { showToast, useToastStore } from '../../../store/toastStore'

// The second toast with an action row (owner ruling 2026-09-23, recorded in
// design-system/components/toast): the update is already on disk, so the only
// question left is when to restart, and asking it where the person is working
// means they never have to go looking for the installer. It stays until answered. Later loses nothing:
// the update installs at the next quit, and the bell row and the Settings
// version row both keep saying it is ready.
//
// Later (or Dismiss) is also the person saying "not now" to this version, so it
// clears the update's badges on the Settings gear and on General (owner ruling
// 2026-09-25). The version row keeps its Restart to update; a newer release
// badges again.
export const APP_UPDATE_TOAST_ID = 'app-update:ready'

export function showAppUpdateReadyToast(state: Pick<AppUpdateState, 'updateVersion'>): void {
  const notice = updateReadyNotice('SprintEngine Studio', state.updateVersion)
  const dismissUpdate = (): void => useNotificationStore.getState().dismissUpdate(appUpdateKey(state.updateVersion))
  publishDiagnosticSync({
    level: 'info',
    source: 'update',
    title: notice.title,
    message: notice.description,
    navigationTarget: { kind: 'settings', ref: 'general' },
  })
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'good',
    title: notice.title,
    description: notice.description,
    autoDismissMs: false,
    onDismissPressed: dismissUpdate,
    actions: [
      {
        id: 'later',
        label: 'Later',
        run: () => {
          dismissUpdate()
          useToastStore.getState().dismissToast(APP_UPDATE_TOAST_ID)
        },
      },
      {
        id: 'restart',
        label: 'Restart to update',
        primary: true,
        run: () => {
          void restartToUpdateFromToast()
        },
      },
    ],
  })
}

export async function restartToUpdateFromToast(): Promise<void> {
  const api = window.api
  if (typeof api.updateQuitAndInstall !== 'function') return
  showToast({ id: APP_UPDATE_TOAST_ID, tone: 'neutral', title: 'Restarting to update…', autoDismissMs: false })
  try {
    const result = await api.updateQuitAndInstall()
    if (result.ok) return
    showToast({
      id: APP_UPDATE_TOAST_ID,
      tone: 'warn',
      title: 'Could not restart to update',
      description: result.message,
    })
  } catch (error) {
    showToast({
      id: APP_UPDATE_TOAST_ID,
      tone: 'warn',
      title: 'Could not restart to update',
      description: error instanceof Error ? error.message : String(error),
    })
  }
}
