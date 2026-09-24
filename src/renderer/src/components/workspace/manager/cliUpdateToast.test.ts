import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { CliVersionAdvisory } from '../../../../../shared/electron-api'
import { useNotificationStore } from '../../../store/notificationStore'
import { useToastStore } from '../../../store/toastStore'

// The CLI-update toast's two ways out of the corner (owner ruling 2026-09-25):
// Settings opens Settings ▸ Agents on This PC, whose version check the advisory
// came from; Dismiss is "not now" for this version and clears its badges. The
// timer is neither: a toast that left on its own was not dismissed by anyone.

const opened = vi.hoisted(() => ({ requests: [] as unknown[] }))
vi.mock('../../../utils/diagnostics', () => ({ publishDiagnosticSync: () => {} }))
vi.mock('../../../store/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      pluginCatalogEntries: [{ id: 'codex', displayName: 'Codex' }],
      openSettingsOverlay: (request: unknown) => opened.requests.push(request),
    }),
  },
}))

const { showCliUpdateToast } = await import('./cliUpdateToast')

const ADVISORY: CliVersionAdvisory = {
  cli: 'codex' as CliVersionAdvisory['cli'],
  status: 'behind_latest',
  currentVersion: '0.40.0',
  latestVersion: '0.41.0',
  updateCommand: null,
  checkedAt: '2026-09-25T00:00:00.000Z',
}

const anyGlobal = globalThis as unknown as { window?: unknown }

beforeEach(() => {
  opened.requests.length = 0
  anyGlobal.window = { api: {} }
  useToastStore.setState({ toasts: [] })
  useNotificationStore.setState({ dismissedUpdates: [] })
})

afterEach(() => {
  delete anyGlobal.window
})

const toast = () => useToastStore.getState().toasts.find((entry) => entry.id === 'cli-update:codex')

test('Settings opens Agents with This PC selected, not the machine the tab last showed', () => {
  showCliUpdateToast(ADVISORY)
  toast()
    ?.actions?.find((action) => action.id === 'settings')
    ?.run()
  assert.deepEqual(opened.requests, [{ initialTab: 'agents', agentsMachine: 'local' }])
  assert.equal(toast(), undefined, 'and the toast goes')
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, [], 'going to look is not dismissing')
})

test('pressing Dismiss clears this version’s badges; the toast timing out does not', () => {
  showCliUpdateToast(ADVISORY)
  useToastStore.getState().dismissToast('cli-update:codex')
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, [], 'the timer path dismisses nothing')

  showCliUpdateToast(ADVISORY)
  toast()?.onDismissPressed?.()
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, ['cli:codex@0.41.0'])
})
