import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { AppNotification, DiagnosticLogEntry } from '../types/workspace'

const NOTIFICATION_STORAGE_KEY = 'sprintengine-notifications'
const MAX_NOTIFICATIONS = 120

// The rail sections whose badge counts something that is not a notification:
// Extensions counts the hosted cards published since its home was last looked
// at. Kept here rather than in appSettings because it is the same kind of fact
// as `read` — what this person has seen — and it persists alongside it.
type RailSeenSection = 'extensions'

// Sources that no longer exist. A notification persisted before its source was
// removed has nothing left to open and no rail section to be read from, so it is
// dropped when the store loads rather than sitting in the bell forever. The
// in-tree Sprint Engine published as `sprintengine` until it was removed
// (2026-09-16), and Automations as `automations` until scheduled agents
// replaced it (2026-09-30).
const RETIRED_NOTIFICATION_SOURCES: ReadonlySet<string> = new Set(['sprintengine', 'automations'])

type PersistedNotificationState = Pick<
  NotificationStore,
  'notifications' | 'sectionSeenAt' | 'dismissedUpdates' | 'filedModuleNotificationIds'
>

// How many delivered module-notification ids are remembered. The main kernel
// keeps its last 50 for a window that boots late (shared/modules/notifications.ts),
// so remembering twice that is enough to never file one of them twice — and a
// row the person cleared does not come back with the next window.
const MAX_FILED_MODULE_NOTIFICATION_IDS = 100

// How many dismissed updates are remembered. A key names one version
// (`settingsUpdateBadges.ts`), so the list only ever needs the few that are
// still outstanding; the oldest fall off rather than growing for ever.
const MAX_DISMISSED_UPDATES = 50

export function dropRetiredNotifications(notifications: unknown): AppNotification[] {
  if (!Array.isArray(notifications)) return []
  return notifications.filter(
    (notification): notification is AppNotification =>
      Boolean(notification) &&
      typeof notification === 'object' &&
      !RETIRED_NOTIFICATION_SOURCES.has(String((notification as { source?: unknown }).source)),
  )
}

// The persist `merge`: the stored state over the initial one, less any
// notification from a retired source.
export function mergePersistedNotificationState<T extends PersistedNotificationState>(
  persisted: unknown,
  current: T,
): T {
  if (!persisted || typeof persisted !== 'object') return current
  const stored = persisted as Partial<PersistedNotificationState>
  return {
    ...current,
    ...stored,
    notifications: dropRetiredNotifications(stored.notifications ?? current.notifications),
    dismissedUpdates: Array.isArray(stored.dismissedUpdates)
      ? stored.dismissedUpdates.filter((key): key is string => typeof key === 'string')
      : current.dismissedUpdates,
    filedModuleNotificationIds: Array.isArray(stored.filedModuleNotificationIds)
      ? stored.filedModuleNotificationIds.filter((id): id is string => typeof id === 'string')
      : current.filedModuleNotificationIds,
  }
}

interface NotificationStore {
  notifications: AppNotification[]
  sectionSeenAt: Partial<Record<RailSeenSection, string>>
  addNotification: (entry: DiagnosticLogEntry) => AppNotification
  markRead: (id: string) => void
  markAllRead: () => void
  /** Opening a rail section reads everything its badge was counting. */
  /**
   * Opening a drawer row reads the rows it was counting. The caller says which
   * — the store does not know how news is attributed to rows, only that reading
   * is a flag flip over the ones the predicate picks.
   */
  markReadWhere: (predicate: (notification: AppNotification) => boolean) => void
  markSectionSeen: (section: RailSeenSection, at: string) => void
  /**
   * The updates the person said "not now" to — a CLI's or the app's, one
   * version each (`cliUpdateKey` / `appUpdateKey` in settingsUpdateBadges.ts).
   * Kept beside `read` because it is the same kind of fact: what this person
   * has already been told. A dismissed update keeps its Update button and its
   * version line; only the badges that were pointing at it go (owner ruling
   * 2026-09-25). A newer version is a new key, so it badges again.
   */
  dismissedUpdates: string[]
  dismissUpdate: (key: string) => void
  /**
   * The module notifications this bell has already filed, by delivery id: a
   * window hears a row live and may read it again from the kernel's backlog
   * as it boots, and a row the person cleared must not come back either way.
   */
  filedModuleNotificationIds: string[]
  /**
   * File one delivered module notification, once. False when its delivery id
   * was filed before (live and again from the backlog, or cleared since).
   */
  fileModuleNotification: (deliveryId: string, entry: DiagnosticLogEntry) => boolean
  clearAll: () => void
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    immer((set) => ({
      notifications: [],
      sectionSeenAt: {},
      dismissedUpdates: [],
      filedModuleNotificationIds: [],

      addNotification: (entry) => {
        const notification: AppNotification = {
          ...entry,
          read: false,
        }

        set((state) => {
          state.notifications.unshift(notification)
          if (state.notifications.length > MAX_NOTIFICATIONS) {
            state.notifications.length = MAX_NOTIFICATIONS
          }
        })

        return notification
      },

      markRead: (id) =>
        set((state) => {
          const item = state.notifications.find((notification) => notification.id === id)
          if (item) item.read = true
        }),

      markAllRead: () =>
        set((state) => {
          state.notifications.forEach((notification) => {
            notification.read = true
          })
        }),

      markReadWhere: (predicate) =>
        set((state) => {
          for (const notification of state.notifications) {
            if (!notification.read && predicate(notification)) notification.read = true
          }
        }),

      markSectionSeen: (section, at) =>
        set((state) => {
          state.sectionSeenAt[section] = at
        }),

      dismissUpdate: (key) =>
        set((state) => {
          if (state.dismissedUpdates.includes(key)) return
          state.dismissedUpdates.push(key)
          if (state.dismissedUpdates.length > MAX_DISMISSED_UPDATES) {
            state.dismissedUpdates.splice(0, state.dismissedUpdates.length - MAX_DISMISSED_UPDATES)
          }
        }),

      fileModuleNotification: (deliveryId, entry) => {
        let filed = false
        set((state) => {
          if (state.filedModuleNotificationIds.includes(deliveryId)) return
          filed = true
          state.filedModuleNotificationIds.push(deliveryId)
          if (state.filedModuleNotificationIds.length > MAX_FILED_MODULE_NOTIFICATION_IDS) {
            state.filedModuleNotificationIds.splice(
              0,
              state.filedModuleNotificationIds.length - MAX_FILED_MODULE_NOTIFICATION_IDS,
            )
          }
          state.notifications.unshift({ ...entry, read: false })
          if (state.notifications.length > MAX_NOTIFICATIONS) {
            state.notifications.length = MAX_NOTIFICATIONS
          }
        })
        return filed
      },

      clearAll: () =>
        set((state) => {
          state.notifications = []
        }),
    })),
    {
      name: NOTIFICATION_STORAGE_KEY,
      version: 1,
      merge: mergePersistedNotificationState,
    },
  ),
)

// Another window dismissed an update: take its list, so its badges clear here
// too and this window's next write does not put the dismissal back. Only the
// dismissals — every window keeps its own copy of the bell as it always has.
export function dismissedUpdatesFromStorage(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: { dismissedUpdates?: unknown } }
    const list = parsed?.state?.dismissedUpdates
    return Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : null
  } catch {
    return null
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== NOTIFICATION_STORAGE_KEY) return
    const dismissed = dismissedUpdatesFromStorage(event.newValue)
    if (!dismissed) return
    const current = useNotificationStore.getState().dismissedUpdates
    const merged = [...new Set([...current, ...dismissed])]
    if (merged.length !== current.length) useNotificationStore.setState({ dismissedUpdates: merged })
  })
}
