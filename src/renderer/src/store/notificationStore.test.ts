import assert from 'node:assert/strict'

import type { AppNotification } from '../types/workspace'
import { test } from 'vitest'

test('notificationStore', async () => {
  // Notifications persist to localStorage, so one published by a source that has
  // since been removed (the in-tree Sprint Engine's `sprintengine`) would sit in
  // the bell forever. The store drops them when it loads. The storage is seeded
  // before the store module is imported, so this exercises the real rehydrate.

  const STORAGE_KEY = 'sprintengine-notifications'

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
          notification('drop-automations', 'automations'),
          notification('keep-marketplace', 'marketplace'),
        ],
        sectionSeenAt: { extensions: '2026-09-02T00:00:00.000Z' },
      },
    }),
  )

  async function main(): Promise<void> {
    const {
      useNotificationStore,
      dropRetiredNotifications,
      dismissedUpdatesFromStorage,
      mergePersistedNotificationState,
    } = await import('./notificationStore')

    // --- the real rehydrate drops the retired source, keeps everything else ---
    await useNotificationStore.persist.rehydrate()
    const state = useNotificationStore.getState()
    assert.deepEqual(
      state.notifications.map((n) => n.id),
      ['keep-terminal', 'keep-marketplace'],
      'a persisted sprintengine or automations notification is dropped on load',
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
    const current = {
      notifications: [],
      sectionSeenAt: {},
      dismissedUpdates: [] as string[],
      filedModuleNotificationIds: [] as string[],
    }
    assert.equal(mergePersistedNotificationState(null, current), current, 'nothing stored keeps the initial state')
    assert.deepEqual(
      mergePersistedNotificationState({ dismissedUpdates: ['app@0.7.0', 3, null] }, current).dismissedUpdates,
      ['app@0.7.0'],
      'a stored dismissal survives, junk in the list does not',
    )
    assert.deepEqual(
      mergePersistedNotificationState({ notifications: [] }, current).dismissedUpdates,
      [],
      'a profile from before dismissals existed starts with none',
    )

    // --- dismissing an update ---
    useNotificationStore.setState({ dismissedUpdates: [] })
    useNotificationStore.getState().dismissUpdate('cli:codex@0.154.0')
    useNotificationStore.getState().dismissUpdate('cli:codex@0.154.0')
    assert.deepEqual(
      useNotificationStore.getState().dismissedUpdates,
      ['cli:codex@0.154.0'],
      'one version is dismissed once',
    )
    for (let index = 0; index < 60; index += 1) useNotificationStore.getState().dismissUpdate(`app@0.${index}.0`)
    const kept = useNotificationStore.getState().dismissedUpdates
    assert.equal(kept.length, 50, 'the list is bounded')
    assert.equal(kept.at(-1), 'app@0.59.0', 'the newest dismissal is kept')
    assert.equal(kept.includes('cli:codex@0.154.0'), false, 'and the oldest falls off')

    // Another window's dismissals, read from its storage write.
    assert.deepEqual(
      dismissedUpdatesFromStorage(JSON.stringify({ state: { dismissedUpdates: ['app@0.7.0:ready', 4] } })),
      ['app@0.7.0:ready'],
    )
    assert.equal(dismissedUpdatesFromStorage('not json'), null)
    assert.equal(dismissedUpdatesFromStorage(null), null)

    // --- a module's notification is filed once per delivery ---
    useNotificationStore.setState({ notifications: [], filedModuleNotificationIds: [] })
    const moduleEntry = { ...notification('module:k1-1', 'module'), read: undefined } as never
    assert.equal(useNotificationStore.getState().fileModuleNotification('k1-1', moduleEntry), true)
    assert.equal(
      useNotificationStore.getState().fileModuleNotification('k1-1', moduleEntry),
      false,
      'heard live and read again from the backlog: one row',
    )
    useNotificationStore.getState().clearAll()
    assert.equal(
      useNotificationStore.getState().fileModuleNotification('k1-1', moduleEntry),
      false,
      'a row the person cleared does not come back',
    )
    assert.equal(useNotificationStore.getState().notifications.length, 0)
    for (let index = 0; index < 120; index += 1) {
      useNotificationStore.getState().fileModuleNotification(`k2-${index}`, moduleEntry)
    }
    assert.equal(useNotificationStore.getState().filedModuleNotificationIds.length, 100, 'the id list is bounded')
    assert.equal(useNotificationStore.getState().notifications[0]?.read, false, 'a filed row is unread')

    console.log('notificationStore.test.ts: ok')
  }

  const suiteRun = main().then(
    () => undefined,
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )

  await suiteRun
})
