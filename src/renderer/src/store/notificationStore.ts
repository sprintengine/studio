import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { AppNotification, DiagnosticLogEntry } from '../types/workspace'

const NOTIFICATION_STORAGE_KEY = 'multicode-notifications'
const MAX_NOTIFICATIONS = 120

type NotificationPredicate = (notification: AppNotification) => boolean

interface NotificationStore {
  notifications: AppNotification[]
  addNotification: (entry: DiagnosticLogEntry) => AppNotification
  markRead: (id: string) => void
  markAllRead: () => void
  clearAll: () => void
  /** Mark every notification matching `predicate` as read. Used by scoped
   *  surfaces (e.g. a single Sprint Engine run's Activity tab) that must not
   *  touch notifications belonging to other workspaces or sources. */
  markReadWhere: (predicate: NotificationPredicate) => void
  /** Remove every notification matching `predicate`. Same scoping rationale as
   *  `markReadWhere`. */
  clearWhere: (predicate: NotificationPredicate) => void
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    immer((set) => ({
      notifications: [],

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

      clearAll: () =>
        set((state) => {
          state.notifications = []
        }),

      markReadWhere: (predicate) =>
        set((state) => {
          state.notifications.forEach((notification) => {
            if (predicate(notification)) notification.read = true
          })
        }),

      clearWhere: (predicate) =>
        set((state) => {
          state.notifications = state.notifications.filter(
            (notification) => !predicate(notification),
          )
        }),
    })),
    {
      name: NOTIFICATION_STORAGE_KEY,
      version: 1,
    }
  )
)
