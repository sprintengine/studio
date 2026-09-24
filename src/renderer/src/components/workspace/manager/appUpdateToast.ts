// The app-update toast: one toast, re-shown in place through the update's
// steps, so the person always sees where the update is and what they can do.
//
//   available    "X is available"       Later · Download       (owner ruling 2026-09-24:
//                                                               nothing downloads until asked,
//                                                               unless automatic download is on)
//   downloading  "Downloading X" + %     —
//   ready        "X is ready"           Later · Restart to update
//   installing   "Installing update"    Restart to update, busy (the press went through)
//   refused      "Update not installed" Later · Restart to update, and why
//
// and, at the start after an update, "Updated to X" or "Update to X did not
// install". The toast spec (design-system/components/toast) records the action
// row's consumers; this is the second.
//
// Later, and the toast's own Dismiss, are also the person saying "not now" to
// this version at this step, so they clear the update's badges on the Settings
// gear and on General (owner ruling 2026-09-25). The step is part of what was
// dismissed: waving off the offer does not wave off "ready to restart" when the
// download lands later, which is news of its own. Dismissing the downloading
// toast only hides it — the person asked for that download.

import type { AppUpdateInstallOutcome, AppUpdateState } from '../../../../../shared/electron-api'
import { publishDiagnosticSync } from '../../../utils/diagnostics'
import { updateAvailableNotice, updateReadyNotice } from '../../../utils/feedNotifications'
import { appUpdateKey, type AppUpdateStage } from '../../../utils/settingsUpdateBadges'
import { useNotificationStore } from '../../../store/notificationStore'
import { showToast, useToastStore } from '../../../store/toastStore'

export const APP_UPDATE_TOAST_ID = 'app-update:ready'
// How the last update went: its own toast, so it never replaces an offer the
// start-up check made in the same breath.
export const APP_UPDATE_OUTCOME_TOAST_ID = 'app-update:outcome'

const APP_NAME = 'SprintEngine Studio'

type Phase = 'available' | 'downloading' | 'ready' | 'installing' | 'refused'

// Which step the toast is showing, when it is showing one. Progress only ever
// updates a toast the person is still looking at: dismissed, it stays gone.
let phase: Phase | null = null
// Installing needs an administrator (main's `installRequiresAdmin`), so the
// installing toast says Windows will ask.
let installNeedsAdmin = false
// An update is offered once per version per window, not on every hourly check.
const offeredVersions = new Set<string>()
// The version the ready toast is about, for a refused restart's Later.
let readyVersion: string | null = null

function toastIsShowing(): boolean {
  return useToastStore.getState().toasts.some((toast) => toast.id === APP_UPDATE_TOAST_ID)
}

function dismiss(): void {
  phase = null
  useToastStore.getState().dismissToast(APP_UPDATE_TOAST_ID)
}

/** Record "not now" for this version at this step: its Settings badges clear. */
function dismissUpdate(version: string | null, stage: AppUpdateStage): () => void {
  return () => useNotificationStore.getState().dismissUpdate(appUpdateKey(version, stage))
}

/** Later: "not now", and the toast goes. */
function later(version: string | null, stage: AppUpdateStage) {
  const notNow = dismissUpdate(version, stage)
  return {
    id: 'later',
    label: 'Later',
    run: () => {
      notNow()
      dismiss()
    },
  }
}

/** Resolves after the browser has painted what was just rendered. */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

export function showAppUpdateAvailableToast(state: Pick<AppUpdateState, 'updateVersion'>): void {
  const key = state.updateVersion ?? ''
  if (offeredVersions.has(key)) return
  offeredVersions.add(key)
  const notice = updateAvailableNotice(APP_NAME, state.updateVersion)
  publishDiagnosticSync({
    level: 'info',
    source: 'update',
    title: notice.title,
    message: notice.description,
    navigationTarget: { kind: 'settings', ref: 'general' },
  })
  phase = 'available'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'accent',
    title: notice.title,
    description: notice.description,
    autoDismissMs: false,
    onDismissPressed: dismissUpdate(state.updateVersion, 'offer'),
    actions: [
      later(state.updateVersion, 'offer'),
      {
        id: 'download',
        label: 'Download',
        primary: true,
        run: () => {
          void downloadUpdateFromToast(state.updateVersion)
        },
      },
    ],
  })
}

function downloadingTitle(version: string | null): string {
  return version ? `Downloading ${APP_NAME} ${version}` : `Downloading the ${APP_NAME} update`
}

export async function downloadUpdateFromToast(version: string | null): Promise<void> {
  const api = window.api
  if (typeof api.updateDownload !== 'function') return
  phase = 'downloading'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'neutral',
    title: downloadingTitle(version),
    description: 'Starting…',
    autoDismissMs: false,
  })
  try {
    const result = await api.updateDownload()
    if (result.ok) return
    showDownloadFailed(version, result.message)
  } catch (error) {
    showDownloadFailed(version, error instanceof Error ? error.message : String(error))
  }
}

function showDownloadFailed(version: string | null, message: string): void {
  phase = 'refused'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'warn',
    title: 'The update did not download',
    description: message,
    onDismissPressed: dismissUpdate(version, 'offer'),
    actions: [
      later(version, 'offer'),
      {
        id: 'download',
        label: 'Try again',
        primary: true,
        run: () => {
          void downloadUpdateFromToast(version)
        },
      },
    ],
  })
}

/** Download progress, on the toast the person pressed Download on. */
export function showAppUpdateDownloadProgress(state: Pick<AppUpdateState, 'updateVersion' | 'progress'>): void {
  if (phase !== 'downloading' || !toastIsShowing()) return
  const percent = Math.max(0, Math.min(100, Math.round(state.progress?.percent ?? 0)))
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'neutral',
    title: downloadingTitle(state.updateVersion),
    description: `${percent}% downloaded`,
    autoDismissMs: false,
  })
}

function restartAction(busy: boolean) {
  return {
    id: 'restart',
    label: busy ? 'Restarting…' : 'Restart to update',
    primary: true,
    busy,
    run: () => {
      if (!busy) void restartToUpdateFromToast()
    },
  }
}

// It stays until answered: it appears once per downloaded version, and a
// restart prompt that times out while the person looks away is how an update
// ends up found by accident. Later loses nothing: the update installs at the
// next quit (unless it needs an administrator), and the bell row and the
// Settings version row both keep saying it is ready.
export function showAppUpdateReadyToast(state: Pick<AppUpdateState, 'updateVersion'> & Partial<AppUpdateState>): void {
  installNeedsAdmin = state.installRequiresAdmin === true
  const notice = updateReadyNotice(APP_NAME, state.updateVersion, installNeedsAdmin)
  publishDiagnosticSync({
    level: 'info',
    source: 'update',
    title: notice.title,
    message: notice.description,
    navigationTarget: { kind: 'settings', ref: 'general' },
  })
  phase = 'ready'
  readyVersion = state.updateVersion
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'good',
    title: notice.title,
    description: notice.description,
    autoDismissMs: false,
    onDismissPressed: dismissUpdate(state.updateVersion, 'ready'),
    actions: [later(state.updateVersion, 'ready'), restartAction(false)],
  })
}

/**
 * Restart to update. The toast says so BEFORE main is asked (owner ruling
 * 2026-09-24: the press must show at once), and main is only asked once that
 * has been painted: main's shutdown runs next, and the progress window takes
 * over from this toast.
 */
export async function restartToUpdateFromToast(): Promise<void> {
  const api = window.api
  if (typeof api.updateQuitAndInstall !== 'function') return
  phase = 'installing'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'neutral',
    title: 'Installing update',
    description: installNeedsAdmin
      ? 'Windows will ask for administrator permission, then Studio restarts.'
      : 'Studio will restart in a moment…',
    autoDismissMs: false,
    actions: [restartAction(true)],
  })
  await nextPaint()
  try {
    const result = await api.updateQuitAndInstall()
    if (result.ok) return
    showRestartRefused(result.message)
  } catch (error) {
    showRestartRefused(error instanceof Error ? error.message : String(error))
  }
}

function showRestartRefused(message: string): void {
  phase = 'refused'
  showToast({
    id: APP_UPDATE_TOAST_ID,
    tone: 'warn',
    title: 'Update not installed',
    description: message,
    onDismissPressed: dismissUpdate(readyVersion, 'ready'),
    actions: [later(readyVersion, 'ready'), restartAction(false)],
  })
}

/** How the last update went, once, at the start after it. */
export function showAppUpdateOutcomeToast(outcome: AppUpdateInstallOutcome): void {
  const title =
    outcome.kind === 'updated'
      ? `Updated to ${APP_NAME} ${outcome.version}`
      : `Update to ${outcome.version} did not install`
  const description =
    outcome.kind === 'updated'
      ? `${APP_NAME} was updated from ${outcome.fromVersion}.`
      : (outcome.message ?? `${APP_NAME} is still on ${outcome.fromVersion}.`)
  publishDiagnosticSync({
    level: outcome.kind === 'updated' ? 'info' : 'warning',
    source: 'update',
    title,
    message: description,
    navigationTarget: { kind: 'settings', ref: 'general' },
  })
  showToast({
    id: APP_UPDATE_OUTCOME_TOAST_ID,
    tone: outcome.kind === 'updated' ? 'good' : 'warn',
    title,
    description,
  })
}

/**
 * The whole toast, driven by main's update state. Called on every state push;
 * each step shows once, when it is reached.
 */
export function createAppUpdateToastDriver(): (state: AppUpdateState) => void {
  let last: AppUpdateState['status'] | null = null
  return (state) => {
    if (state.status === 'available' && last !== 'available' && !state.autoDownload) {
      showAppUpdateAvailableToast(state)
    }
    if (state.status === 'downloading') showAppUpdateDownloadProgress(state)
    // Not while an install is being asked for or was just refused: main puts a
    // refused install back to `downloaded` before its answer reaches the
    // toast, and that is not a fresh "ready".
    if (state.status === 'downloaded' && last !== 'downloaded' && phase !== 'refused' && phase !== 'installing') {
      showAppUpdateReadyToast(state)
    }
    last = state.status
  }
}

/** For tests: forget which versions were offered and what the toast shows. */
export function resetAppUpdateToastForTests(): void {
  phase = null
  installNeedsAdmin = false
  readyVersion = null
  offeredVersions.clear()
}
