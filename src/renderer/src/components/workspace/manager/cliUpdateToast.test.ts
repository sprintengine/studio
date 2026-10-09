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

const { CLI_UPDATE_PROGRESS_INTERVAL_MS, holdCliUpdateToasts, showCliUpdateToast } = await import('./cliUpdateToast')

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

// First run: an onboarding card holds the update offers back, because in a
// small window the toast corner is where the card's own buttons are.
test('an update that arrives while onboarding holds them waits, and is offered on release', () => {
  const release = holdCliUpdateToasts()
  showCliUpdateToast(ADVISORY)
  assert.equal(toast(), undefined, 'nothing lands on the card')
  assert.equal(opened.diagnostics.length, 1, 'the bell still has it')
  release()
  assert.equal(toast()?.title, 'Update available: Codex 0.41.0')
  assert.equal(opened.diagnostics.length, 1, 'and is not told twice')
})

test('an offer already showing when onboarding begins is taken down and made again after', () => {
  showCliUpdateToast(ADVISORY)
  assert.ok(toast())
  const release = holdCliUpdateToasts()
  assert.equal(toast(), undefined)
  release()
  assert.ok(toast()?.actions?.some((action) => action.id === 'update'))
})

test('holds nest, and a release called twice counts once', () => {
  const first = holdCliUpdateToasts()
  const second = holdCliUpdateToasts()
  showCliUpdateToast(ADVISORY)
  first()
  first()
  assert.equal(toast(), undefined, 'the second hold still stands')
  second()
  assert.ok(toast())
})

// While the update runs, the toast carries the updater's newest line: main
// streams the output on the install channel, and the toast follows it.
function streamingUpdate() {
  const listeners = new Set<(chunk: string) => void>()
  let settle: (result: unknown) => void = () => {}
  const api = (anyGlobal.window as { api: Record<string, unknown> }).api
  api.cliUpdate = () =>
    new Promise((resolve) => {
      settle = resolve
    })
  api.onCliInstallOutput = (cli: string, listener: (chunk: string) => void) => {
    assert.equal(cli, 'codex')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    emit: (chunk: string) => {
      for (const listener of listeners) listener(chunk)
    },
    listening: () => listeners.size,
    settle: async (result: unknown) => {
      settle(result)
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    },
  }
}

const FAILED = { ok: false, cli: 'codex', installed: true, version: '0.40.0', resolvedPath: null, log: '' }

test('a running update shows the newest output line, at most four times a second', async () => {
  vi.useFakeTimers()
  try {
    const update = streamingUpdate()
    showCliUpdateToast(ADVISORY)
    toast()
      ?.actions?.find((action) => action.id === 'update')
      ?.run()
    assert.equal(toast()?.title, 'Updating Codex…')
    assert.equal(toast()?.description, undefined)

    update.emit('\x1b[1m$ npm install -g @openai/codex@latest\x1b[0m\n')
    vi.advanceTimersByTime(0)
    assert.equal(toast()?.description, '$ npm install -g @openai/codex@latest', 'the first line shows at once')

    update.emit('fetch  10%')
    update.emit('\rfetch  60%')
    assert.equal(toast()?.description, '$ npm install -g @openai/codex@latest', 'the next waits out the interval')
    vi.advanceTimersByTime(CLI_UPDATE_PROGRESS_INTERVAL_MS)
    assert.equal(toast()?.description, 'fetch 60%', 'and then shows the newest, not each frame')

    await update.settle({ ...FAILED, ok: true, version: '0.41.0', error: null })
    assert.equal(toast()?.title, 'Codex updated to 0.41.0')
    assert.equal(update.listening(), 0, 'the toast stops listening when the update settles')
    update.emit('late output\n')
    vi.advanceTimersByTime(CLI_UPDATE_PROGRESS_INTERVAL_MS)
    assert.equal(toast()?.title, 'Codex updated to 0.41.0')
  } finally {
    vi.useRealTimers()
  }
})

test('a failed update keeps the last thing the updater said', async () => {
  const update = streamingUpdate()
  showCliUpdateToast(ADVISORY)
  toast()
    ?.actions?.find((action) => action.id === 'update')
    ?.run()
  update.emit('npm error code EACCES\nnpm error path /usr/local/lib/node_modules\n')
  await update.settle({ ...FAILED, error: null })
  assert.equal(toast()?.title, 'Codex did not update')
  assert.equal(
    toast()?.description,
    'The update did not finish. Last output: npm error path /usr/local/lib/node_modules',
  )
})

test('progress does not bring back an updating toast the person dismissed', async () => {
  vi.useFakeTimers()
  try {
    const update = streamingUpdate()
    showCliUpdateToast(ADVISORY)
    toast()
      ?.actions?.find((action) => action.id === 'update')
      ?.run()
    useToastStore.getState().dismissToast('cli-update:codex')
    update.emit('still going\n')
    vi.advanceTimersByTime(CLI_UPDATE_PROGRESS_INTERVAL_MS)
    assert.equal(toast(), undefined)
    await update.settle({ ...FAILED, ok: true, version: '0.41.0', error: null })
  } finally {
    vi.useRealTimers()
  }
})
