import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateState } from '../../../../../shared/electron-api'
import { useToastStore } from '../../../store/toastStore'

const diagnostics = vi.hoisted(() => ({ published: [] as Array<{ title: string; source: string }> }))
vi.mock('../../../utils/diagnostics', () => ({
  publishDiagnosticSync: (input: { title: string; source: string }) => {
    diagnostics.published.push(input)
  },
}))

const {
  APP_UPDATE_OUTCOME_TOAST_ID,
  APP_UPDATE_TOAST_ID,
  createAppUpdateToastDriver,
  resetAppUpdateToastForTests,
  showAppUpdateOutcomeToast,
  showAppUpdateReadyToast,
} = await import('./appUpdateToast')

const anyGlobal = globalThis as unknown as { window?: unknown }
let installs = 0
let downloads = 0
let answer: () => Promise<AppUpdateCheckResult>
let downloadAnswer: () => Promise<AppUpdateCheckResult>
// What the toast looked like at the moment main was asked to install.
let toastWhenMainWasAsked: ReturnType<typeof toast>

function ok(message = 'Restarting to install update.'): Promise<AppUpdateCheckResult> {
  return Promise.resolve({ ok: true, state: {} as AppUpdateState, message })
}

function state(patch: Partial<AppUpdateState>): AppUpdateState {
  return {
    status: 'idle',
    version: '0.5.2',
    channel: 'stable',
    buildChannel: 'stable',
    packaged: true,
    updateVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseNotesUrl: null,
    downloaded: false,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    autoDownload: false,
    installRequiresAdmin: false,
    installOutcome: null,
    ...patch,
  }
}

beforeEach(() => {
  installs = 0
  downloads = 0
  answer = () => ok()
  downloadAnswer = () => ok('Update ready to install.')
  toastWhenMainWasAsked = undefined
  diagnostics.published.length = 0
  resetAppUpdateToastForTests()
  useToastStore.setState({ toasts: [] })
  anyGlobal.window = {
    api: {
      updateQuitAndInstall: () => {
        installs += 1
        toastWhenMainWasAsked = toast()
        return answer()
      },
      updateDownload: () => {
        downloads += 1
        return downloadAnswer()
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

function actions() {
  return toast()?.actions?.map(({ id, label, primary, busy }) => ({
    id,
    label,
    primary: primary === true,
    busy: busy === true,
  }))
}

function press(actionId: string): void {
  const action = toast()?.actions?.find((entry) => entry.id === actionId)
  assert.ok(action, `the toast offers ${actionId}`)
  action.run()
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a found update is offered once, with Download, and nothing downloads until pressed', async () => {
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'checking' }))
  drive(state({ status: 'available', updateVersion: '0.7.0' }))
  assert.equal(toast()?.title, 'SprintEngine Studio 0.7.0 is available')
  assert.equal(toast()?.autoDismissMs, false)
  assert.deepEqual(actions(), [
    { id: 'later', label: 'Later', primary: false, busy: false },
    { id: 'download', label: 'Download', primary: true, busy: false },
  ])
  assert.equal(downloads, 0)
  assert.deepEqual(
    diagnostics.published.map(({ title }) => title),
    ['SprintEngine Studio 0.7.0 is available'],
  )

  // The hourly check finds the same version again: not a second toast.
  press('later')
  drive(state({ status: 'checking' }))
  drive(state({ status: 'available', updateVersion: '0.7.0' }))
  assert.equal(toast(), undefined)
})

test('with automatic download on, the found update is not offered; its ready toast follows', () => {
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'available', updateVersion: '0.7.0', autoDownload: true }))
  assert.equal(toast(), undefined)
  drive(state({ status: 'downloading', updateVersion: '0.7.0', autoDownload: true }))
  assert.equal(toast(), undefined, 'a download nobody pressed for runs quietly')
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true, autoDownload: true }))
  assert.equal(toast()?.title, 'SprintEngine Studio 0.7.0 is ready')
})

test('Download shows the download’s progress on the same toast, then the restart question', async () => {
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'available', updateVersion: '0.7.0' }))
  press('download')
  assert.equal(downloads, 1)
  assert.equal(toast()?.title, 'Downloading SprintEngine Studio 0.7.0')
  assert.equal(toast()?.actions, undefined)
  drive(
    state({
      status: 'downloading',
      updateVersion: '0.7.0',
      progress: { percent: 41.6, transferred: 1, total: 1, bytesPerSecond: 1 },
    }),
  )
  assert.equal(toast()?.description, '42% downloaded')
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true }))
  assert.equal(toast()?.title, 'SprintEngine Studio 0.7.0 is ready')
})

test('a download that fails says why and offers to try again', async () => {
  downloadAnswer = () => Promise.resolve({ ok: false, state: {} as AppUpdateState, message: 'socket hang up' })
  createAppUpdateToastDriver()(state({ status: 'available', updateVersion: '0.7.0' }))
  press('download')
  await settle()
  assert.equal(toast()?.tone, 'warn')
  assert.equal(toast()?.description, 'socket hang up')
  press('download')
  assert.equal(downloads, 2)
})

test('a downloaded update asks to restart, stays until answered, and files a bell row', () => {
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  const shown = toast()
  assert.ok(shown)
  assert.equal(shown.title, 'SprintEngine Studio 0.5.3 is ready')
  assert.equal(shown.description, 'Restart now to update, or it installs the next time you quit.')
  assert.equal(shown.autoDismissMs, false)
  assert.deepEqual(actions(), [
    { id: 'later', label: 'Later', primary: false, busy: false },
    { id: 'restart', label: 'Restart to update', primary: true, busy: false },
  ])
  assert.deepEqual(
    diagnostics.published.map(({ title, source }) => ({ title, source })),
    [{ title: 'SprintEngine Studio 0.5.3 is ready', source: 'update' }],
  )
})

test('an update that needs an administrator says Windows will ask, and does not promise an install at quit', () => {
  showAppUpdateReadyToast({ updateVersion: '0.7.0', installRequiresAdmin: true })
  assert.equal(toast()?.description, 'Restart to update. Windows will ask for administrator permission.')
})

test('Later dismisses the toast and installs nothing now', () => {
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  press('later')
  assert.equal(toast(), undefined)
  assert.equal(installs, 0)
})

test('Restart to update shows the press at once, before main is asked, with the button busy', async () => {
  showAppUpdateReadyToast({ updateVersion: '0.5.3' })
  press('restart')
  // Synchronously, before main has been asked anything.
  assert.equal(installs, 0)
  assert.equal(toast()?.title, 'Installing update')
  assert.equal(toast()?.description, 'Studio will restart in a moment…')
  assert.deepEqual(actions(), [{ id: 'restart', label: 'Restarting…', primary: true, busy: true }])
  // A second press on the busy button does nothing.
  press('restart')
  await settle()
  assert.equal(installs, 1)
  assert.equal(toastWhenMainWasAsked?.title, 'Installing update', 'main was asked only after the toast said so')
})

test('a restart main refuses turns into a warning that says why, and can be pressed again', async () => {
  answer = () =>
    Promise.resolve({
      ok: false,
      state: {} as AppUpdateState,
      message: 'Windows did not get administrator permission, so the update was not installed.',
    })
  showAppUpdateReadyToast({ updateVersion: null, installRequiresAdmin: true })
  assert.equal(toast()?.title, 'SprintEngine Studio update is ready')
  press('restart')
  assert.equal(toast()?.description, 'Windows will ask for administrator permission, then Studio restarts.')
  await settle()
  assert.equal(toast()?.tone, 'warn')
  assert.equal(toast()?.title, 'Update not installed')
  assert.equal(toast()?.description, 'Windows did not get administrator permission, so the update was not installed.')
  press('restart')
  await settle()
  assert.equal(installs, 2)
})

test('the start after an update says how it went, beside any offer', () => {
  const outcome = () => useToastStore.getState().toasts.find((entry) => entry.id === APP_UPDATE_OUTCOME_TOAST_ID)
  createAppUpdateToastDriver()(state({ status: 'available', updateVersion: '0.8.0' }))
  showAppUpdateOutcomeToast({ kind: 'updated', version: '0.7.0', fromVersion: '0.6.0', message: null })
  assert.equal(outcome()?.tone, 'good')
  assert.equal(outcome()?.title, 'Updated to SprintEngine Studio 0.7.0')
  assert.equal(toast()?.title, 'SprintEngine Studio 0.8.0 is available', 'the offer is still there')
  showAppUpdateOutcomeToast({
    kind: 'failed',
    version: '0.7.0',
    fromVersion: '0.6.0',
    message: 'The installer did not finish, so SprintEngine Studio is still on 0.6.0.',
  })
  assert.equal(outcome()?.tone, 'warn')
  assert.equal(outcome()?.title, 'Update to 0.7.0 did not install')
  assert.equal(outcome()?.description, 'The installer did not finish, so SprintEngine Studio is still on 0.6.0.')
})

test('a refused install going back to downloaded is not announced as ready again', async () => {
  answer = () => Promise.resolve({ ok: false, state: {} as AppUpdateState, message: 'Declined.' })
  const drive = createAppUpdateToastDriver()
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true }))
  press('restart')
  // Main's state pushes arrive before its answer does.
  drive(state({ status: 'installing', updateVersion: '0.7.0', downloaded: true }))
  drive(state({ status: 'downloaded', updateVersion: '0.7.0', downloaded: true, errorMessage: 'Declined.' }))
  assert.equal(toast()?.title, 'Installing update')
  await settle()
  assert.equal(toast()?.title, 'Update not installed')
  assert.equal(
    diagnostics.published.filter(({ title }) => title === 'SprintEngine Studio 0.7.0 is ready').length,
    1,
    'one bell row for the ready update, not one per refusal',
  )
})
