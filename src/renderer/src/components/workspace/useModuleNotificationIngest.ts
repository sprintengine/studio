import { useEffect } from 'react'

import { getRendererHost } from '../../modules'
import { startModuleNotificationIngest } from '../../modules/module-notifications'
import { useNotificationStore } from '../../store/notificationStore'

/**
 * A capability module's `MainHost.notify`, filed into this window's bell while
 * the window's shell is mounted: live on the kernel's push channel, plus the
 * backlog it kept from before this window listened
 * (shared/modules/notifications.ts). Filed once per delivery id, so a row
 * heard live and read again, or cleared since, is not filed twice. Mounted by
 * the window that draws a bell, which is also what makes
 * `supports('notifications')` true in a renderer.
 */
export function useModuleNotificationIngest(): void {
  useEffect(() => {
    if (typeof window.api?.onModuleNotification !== 'function') return
    const host = getRendererHost()
    const listRecent = window.api.listRecentModuleNotifications
    const stop = startModuleNotificationIngest({
      subscribe: (cb) => window.api.onModuleNotification(cb),
      ...(typeof listRecent === 'function' ? { listRecent: () => listRecent() } : {}),
      file: (deliveryId, entry) => useNotificationStore.getState().fileModuleNotification(deliveryId, entry),
    })
    host.setModuleNotificationsWired(true)
    return () => {
      stop()
      host.setModuleNotificationsWired(false)
    }
  }, [])
}
