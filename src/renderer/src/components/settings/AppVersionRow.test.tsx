// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { AppUpdateState } from '../../../../shared/electron-api'
import { AppVersionRow, appVersionRowAction, formatUpdateStatus } from './AppVersionRow'

// Settings ▸ General's version row (owner ruling 2026-09-25): the current
// version; when an update exists, its version and Download; then the download's
// progress; then Restart to update.

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: 'not_available',
    version: '0.6.0',
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
    ...over,
  }
}

let root: Root
let host: HTMLDivElement
let calls: string[]

beforeEach(() => {
  calls = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(value: AppUpdateState | null, pending = false): Promise<void> {
  await act(async () =>
    root.render(
      <AppVersionRow
        state={value}
        pending={pending}
        onCheck={() => calls.push('check')}
        onDownload={() => calls.push('download')}
        onRestart={() => calls.push('restart')}
        onOpenReleaseNotes={() => calls.push('notes')}
      />,
    ),
  )
}

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === name || button.getAttribute('aria-label') === name,
  )

test('up to date: the current version, and a check', async () => {
  await render(state())
  expect(host.textContent).toContain('SprintEngine Studio 0.6.0')
  expect(host.textContent).toContain('Stable · up to date')
  expect(buttonNamed('Download')).toBeUndefined()
  await act(async () => buttonNamed('Check for updates')!.click())
  expect(calls).toEqual(['check'])
})

test('available: the new version beside the current one, and Download', async () => {
  await render(state({ status: 'available', updateVersion: '0.7.0' }))
  expect(host.textContent).toContain('SprintEngine Studio 0.6.0')
  expect(host.textContent).toContain('0.7.0 available')
  const download = buttonNamed('Download')!
  expect(download.getAttribute('aria-label')).toBe('Download SprintEngine Studio 0.7.0')
  await act(async () => download.click())
  expect(calls).toEqual(['download'])
  expect(host.querySelector('[role="progressbar"]')).toBe(null)
})

test('downloading: the progress, and nothing to press', async () => {
  await render(
    state({
      status: 'downloading',
      updateVersion: '0.7.0',
      progress: { percent: 41.6, transferred: 1, total: 2, bytesPerSecond: 1 },
    }),
  )
  const bar = host.querySelector('[role="progressbar"]')!
  expect(bar.getAttribute('aria-valuenow')).toBe('42')
  expect(bar.getAttribute('aria-label')).toBe('Downloading SprintEngine Studio 0.7.0')
  expect(host.textContent).toContain('downloading 0.7.0 · 42%')
  expect(buttonNamed('Download')).toBeUndefined()
  expect(buttonNamed('Restart to update')).toBeUndefined()
})

test('downloaded: Restart to update', async () => {
  await render(state({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' }))
  expect(host.textContent).toContain('0.7.0 ready to install')
  expect(host.querySelector('[role="progressbar"]')).toBe(null)
  await act(async () => buttonNamed('Restart to update')!.click())
  expect(calls).toEqual(['restart'])
})

test('an action already asked for stays pressed until main answers', async () => {
  await render(state({ status: 'available', updateVersion: '0.7.0' }), true)
  expect(buttonNamed('Download')!.disabled).toBe(true)
})

test('the steps as data', () => {
  expect(appVersionRowAction(null)).toBe('check')
  expect(appVersionRowAction(state({ packaged: false, status: 'available' }))).toBe('none')
  expect(appVersionRowAction(state({ status: 'error', errorMessage: 'offline' }))).toBe('check')
  expect(formatUpdateStatus(state({ status: 'error', errorMessage: 'offline' }))).toBe('offline')
  expect(formatUpdateStatus(state({ packaged: false }))).toBe('unpackaged build')
})
