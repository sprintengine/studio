import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { AppNotification, DiagnosticLogEntry, DiagnosticSource } from '../types/workspace'

const NOTIFICATION_STORAGE_KEY = 'multicode-notifications'
const MAX_NOTIFICATIONS = 120

// The rail sections whose badge counts something that is not a notification:
// Extensions counts the hosted cards published since its home was last looked
// at. Kept here rather than in appSettings because it is the same kind of fact
// as `read` — what this person has seen — and it persists alongside it.
type RailSeenSection = 'extensions'

interface NotificationStore {
  notifications: AppNotification[]
  sectionSeenAt: Partial<Record<RailSeenSection, string>>
  addNotification: (entry: DiagnosticLogEntry) => AppNotification
  markRead: (id: string) => void
  markAllRead: () => void
  /** Opening a rail section reads everything its badge was counting. */
  markReadBySources: (sources: ReadonlySet<DiagnosticSource>) => void
  /**
   * Opening a drawer row reads the rows it was counting. The caller says which
   * — the store does not know how news is attributed to rows, only that reading
   * is a flag flip over the ones the predicate picks.
   */
  markReadWhere: (predicate: (notification: AppNotification) => boolean) => void
  markSectionSeen: (section: RailSeenSection, at: string) => void
  clearAll: () => void
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    immer((set) => ({
      notifications: [],
      sectionSeenAt: {},

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

      markReadBySources: (sources) =>
        set((state) => {
          for (const notification of state.notifications) {
            if (!notification.read && sources.has(notification.source)) notification.read = true
          }
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

      clearAll: () =>
        set((state) => {
          state.notifications = []
        }),
    })),
    {
      name: NOTIFICATION_STORAGE_KEY,
      version: 1,
    }
  )
)
