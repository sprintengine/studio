import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { CliVersionAdvisory } from '../../../../../shared/electron-api'
import { useNotificationStore } from '../../../store/notificationStore'
import { useToastStore } from '../../../store/toastStore'

// The CLI-update toast's two ways out of the corner (owner ruling 2026-09-25):
// Settings opens Settings ▸ Agents on the machine the update is for; Dismiss is
// "not now" for this version on that machine and clears its badges. The timer
// is neither: a toast that left on its own was not dismissed by anyone.

const opened = vi.hoisted(() => ({
  requests: [] as unknown[],
  diagnostics: [] as unknown[],
  availabilityReads: [] as unknown[],
  advisoryReads: [] as unknown[],
}))
vi.mock('../../../utils/diagnostics', () => ({
  publishDiagnosticSync: (entry: unknown) => opened.diagnostics.push(entry),
}))
vi.mock('../../../store/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      pluginCatalogEntries: [{ id: 'codex', displayName: 'Codex' }],
      appSettings: {
        cliRuntimes: { codex: { command: '/opt/codex' } },
        hosts: { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/home/dev/bin/codex' }, env: {} } },
      },
      cliAvailability: { codex: { cli: 'codex', installed: true, resolvedPath: '/opt/codex', version: '0.40.0' } },
      openSettingsOverlay: (request: unknown) => opened.requests.push(request),
      refreshCliAvailability: async (options: unknown) => void opened.availabilityReads.push(options),
      refreshCliVersionAdvisories: async (options: unknown) => void opened.advisoryReads.push(options),
    }),
  },
}))

const { showCliUpdateToast } = await import('./cliUpdateToast')

const ADVISORY: CliVersionAdvisory = {
  cli: 'codex' as CliVersionAdvisory['cli'],
  hostId: 'local',
  status: 'behind_latest',
  currentVersion: '0.40.0',
  latestVersion: '0.41.0',
  updateCommand: null,
  checkedAt: '2026-09-25T00:00:00.000Z',
}

const anyGlobal = globalThis as unknown as { window?: unknown }

const updateCalls: unknown[][] = []

beforeEach(() => {
  opened.requests.length = 0
  opened.diagnostics.length = 0
  opened.availabilityReads.length = 0
  opened.advisoryReads.length = 0
  updateCalls.length = 0
  anyGlobal.window = {
    api: {
      platform: 'win32',
      cliUpdate: async (...args: unknown[]) => {
        updateCalls.push(args)
        return { ok: true, cli: 'codex', installed: true, version: '0.41.0', resolvedPath: null, log: '', error: null }
      },
    },
  }
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

const WSL_ADVISORY: CliVersionAdvisory = { ...ADVISORY, hostId: 'wsl:Ubuntu', currentVersion: '0.39.0' }
const wslToast = () => useToastStore.getState().toasts.find((entry) => entry.id === 'cli-update:wsl:Ubuntu:codex')

test('a WSL machine’s update is its own toast, names the machine, and opens Agents on it', () => {
  showCliUpdateToast(ADVISORY)
  showCliUpdateToast(WSL_ADVISORY)
  assert.ok(toast(), 'this PC’s toast stays')
  assert.equal(wslToast()?.title, 'Update available: Codex 0.41.0 (WSL: Ubuntu)')
  assert.deepEqual(
    (opened.diagnostics.at(-1) as { navigationTarget: unknown }).navigationTarget,
    { kind: 'settings', ref: 'agents@wsl:Ubuntu' },
    'the bell row lands on the machine too',
  )

  wslToast()
    ?.actions?.find((action) => action.id === 'settings')
    ?.run()
  assert.deepEqual(opened.requests, [{ initialTab: 'agents', agentsMachine: 'wsl:Ubuntu' }])

  showCliUpdateToast(WSL_ADVISORY)
  wslToast()?.onDismissPressed?.()
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, ['cli:wsl:Ubuntu|codex@0.41.0'])
})

test('Update runs on the machine the notice is for, then reads the recorded answer back', async () => {
  showCliUpdateToast(WSL_ADVISORY)
  await wslToast()
    ?.actions?.find((action) => action.id === 'update')
    ?.run()
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  assert.deepEqual(updateCalls, [['codex', { command: '/home/dev/bin/codex', hostId: 'wsl:Ubuntu' }]])
  assert.equal(wslToast()?.title, 'Codex (WSL: Ubuntu) updated to 0.41.0')
  assert.deepEqual(opened.availabilityReads, [], 'this PC’s list is not re-read for a WSL update')
  assert.deepEqual(opened.advisoryReads, [undefined], 'and nothing is forced')

  showCliUpdateToast(ADVISORY)
  await toast()
    ?.actions?.find((action) => action.id === 'update')
    ?.run()
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  assert.deepEqual(updateCalls[1], ['codex', { command: '/opt/codex' }])
  assert.deepEqual(opened.availabilityReads, [{ cliRuntimes: { codex: { command: '/opt/codex' } } }])
})
