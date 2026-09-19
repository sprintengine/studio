import assert from 'node:assert/strict'

import type { AppNotification } from '../types/workspace'
import { test } from 'vitest'

test('notificationStore', async () => {
  // Notifications persist to localStorage, so one published by a source that has
  // since been removed (the in-tree Sprint Engine's `sprintengine`) would sit in
  // the bell forever. The store drops them when it loads. The storage is seeded
  // before the store module is imported, so this exercises the real rehydrate.

  const STORAGE_KEY = 'multicode-notifications'

  function notification(id: string, source: string): AppNotification {
    return {
      id,
      level: 'info',
      source,
      title: id,
      message: id,
      timestamp: '2026-09-01T00:00:00.000Z',
      read: false,
    } as unknown as AppNotification
  }

  const backing = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return backing.size
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => void backing.delete(key),
    setItem: (key: string, value: string) => void backing.set(key, value),
  }
  // zustand's persist reads `window.localStorage`.
  ;(globalThis as unknown as { window: { localStorage: Storage } }).window = { localStorage: storage }
  backing.set(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      state: {
        notifications: [
          notification('keep-terminal', 'terminal'),
          notification('drop-sprint', 'sprintengine'),
          notification('keep-automations', 'automations'),
        ],
        sectionSeenAt: { extensions: '2026-09-02T00:00:00.000Z' },
      },
    }),
  )

  async function main(): Promise<void> {
    const { useNotificationStore, dropRetiredNotifications, mergePersistedNotificationState } =
      await import('./notificationStore')

    // --- the real rehydrate drops the retired source, keeps everything else ---
    await useNotificationStore.persist.rehydrate()
    const state = useNotificationStore.getState()
    assert.deepEqual(
      state.notifications.map((n) => n.id),
      ['keep-terminal', 'keep-automations'],
      'a persisted sprintengine notification is dropped on load',
    )
    assert.deepEqual(state.sectionSeenAt, { extensions: '2026-09-02T00:00:00.000Z' }, 'other persisted state survives')
    assert.equal(typeof state.addNotification, 'function', 'actions survive the merge')

    // --- the pure helpers ---
    assert.deepEqual(dropRetiredNotifications(undefined), [], 'a missing list reads as empty')
    assert.deepEqual(
      dropRetiredNotifications([null, notification('a', 'sprintengine')]),
      [],
      'junk and retired rows go',
    )
    const current = { notifications: [], sectionSeenAt: {} }
    assert.equal(mergePersistedNotificationState(null, current), current, 'nothing stored keeps the initial state')

    console.log('notificationStore.test.ts: ok')
  }

  const suiteRun = main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )

  await suiteRun
})
