import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateState } from '../../../../../shared/electron-api'
import { useNotificationStore } from '../../../store/notificationStore'
import { useToastStore } from '../../../store/toastStore'

const diagnostics = vi.hoisted(() => ({ published: [] as Array<{ title: string; source: string }> }))
vi.mock('../../../utils/diagnostics', () => ({
  publishDiagnosticSync: (input: { title: string; source: string }) => {
    diagnostics.published.push(input)
  },
}))

const { APP_UPDATE_TOAST_ID, showAppUpdateReadyToast } = await import('./appUpdateToast')

const anyGlobal = globalThis as unknown as { window?: unknown }
let installs = 0
let answer: () => Promise<AppUpdateCheckResult>

function ready(message = 'Restarting to install update.'): Promise<AppUpdateCheckResult> {
  return Promise.resolve({ ok: true, state: {} as AppUpdateState, message })
}

beforeEach(() => {
  installs = 0
  answer = () => ready()
  diagnostics.published.length = 0
  useToastStore.setState({ toasts: [] })
  anyGlobal.window = {
    api: {
      updateQuitAndInstall: () => {
        installs += 1
        return answer()
      },
    },
  }
})

afterEach(() => {
  delete anyGlobal.window
})

function toast() {
  return useToastStore.getState().toasts.find((entry) => entry.id === APP_UPDATE_TOAST_ID)
}

function press(actionId: string): void {
  const action = toast()?.actions?.find((entry) => entry.id === actionId)
  assert.ok(action, `the toast offers ${actionId}`)
  action.run()
}

test('a downloaded update asks to restart, stays until answered, and files a bell row', () => {
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  const shown = toast()
  assert.ok(shown)
  assert.equal(shown.title, 'SprintEngine Studio 0.5.3 is ready')
  assert.equal(shown.autoDismissMs, false)
  assert.deepEqual(
    shown.actions?.map(({ id, label, primary }) => ({ id, label, primary: primary === true })),
    [
      { id: 'later', label: 'Later', primary: false },
      { id: 'restart', label: 'Restart to update', primary: true },
    ],
  )
  assert.deepEqual(
    diagnostics.published.map(({ title, source }) => ({ title, source })),
    [{ title: 'SprintEngine Studio 0.5.3 is ready', source: 'update' }],
  )
})

test('Later dismisses the toast and installs nothing now', () => {
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  press('later')
  assert.equal(toast(), undefined)
  assert.equal(installs, 0)
})

test('Later and Dismiss are "not now" for this version: its Settings badges clear', () => {
  useNotificationStore.setState({ dismissedUpdates: [] })
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  press('later')
  assert.deepEqual(useNotificationStore.getState().dismissedUpdates, ['app@0.5.3'])

  useNotificationStore.setState({ dismissedUpdates: [] })
  showAppUpdateReadyToast({ updateVersion: '0.5.4' })
  toast()?.onDismissPressed?.()
  assert.deepEqual(
    useNotificationStore.getState().dismissedUpdates,
    ['app@0.5.4'],
    'the toast’s own Dismiss says the same thing as Later',
  )
})

test('Restart to update installs, and the toast becomes the restart report without buttons', async () => {
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  press('restart')
  assert.equal(installs, 1)
  assert.equal(toast()?.title, 'Restarting to update…')
  assert.equal(toast()?.actions, undefined)
  await Promise.resolve()
  assert.equal(toast()?.tone, 'neutral')
})

test('a restart main refuses turns into a warning that says why', async () => {
  answer = () =>
    Promise.resolve({ ok: false, state: {} as AppUpdateState, message: 'No downloaded update is ready to install.' })
  showAppUpdateReadyToast({ updateVersion: null })
  assert.equal(toast()?.title, 'SprintEngine Studio update is ready')
  press('restart')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(toast()?.tone, 'warn')
  assert.equal(toast()?.title, 'Could not restart to update')
  assert.equal(toast()?.description, 'No downloaded update is ready to install.')
})
