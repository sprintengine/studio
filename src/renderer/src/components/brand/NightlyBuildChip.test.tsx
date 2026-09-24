import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { AppUpdateChannel, AppUpdateState, AppUpdateTrack } from '../../../../shared/electron-api'
import { NightlyBuildChip, nightlyChipTooltip } from './NightlyBuildChip'

// The Nightly chip beside the wordmark: shown only when main says the BUILD is
// a nightly, whatever channel the updater has been pointed at since, with a
// tooltip naming the version and the channel it follows.

const NIGHTLY = '0.6.0-nightly.20260923.41'

type Api = {
  updateGetState: () => Promise<AppUpdateState>
  onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
}

let root: Root
let container: HTMLElement
let dom: JSDOM
let push: ((state: AppUpdateState) => void) | null

function stateFor(version: string, buildChannel: AppUpdateTrack, channel: AppUpdateChannel): AppUpdateState {
  return {
    status: 'idle',
    version,
    channel,
    buildChannel,
    packaged: channel !== 'dev',
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
  }
}

function install(initial: AppUpdateState) {
  const api: Api = {
    updateGetState: async () => initial,
    onUpdateStateChanged: (cb) => {
      push = cb
      return () => {
        push = null
      }
    },
  }
  ;(window as unknown as { api: Api }).api = api
}

async function mount() {
  await act(async () => {
    root.render(<NightlyBuildChip />)
  })
}

async function hoverTooltip(): Promise<string | null> {
  const chip = container.querySelector('span.app-no-drag')
  assert.ok(chip, 'the chip renders')
  await act(async () => {
    chip.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
  return dom.window.document.querySelector('[role="tooltip"]')?.textContent ?? null
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.navigator = dom.window.navigator
  g.HTMLElement = dom.window.HTMLElement
  g.Node = dom.window.Node
  g.MouseEvent = dom.window.MouseEvent
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.getComputedStyle = dom.window.getComputedStyle
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  push = null
})

afterEach(async () => {
  await act(async () => root.unmount())
})

test('a stable build wears no chip', async () => {
  install(stateFor('0.5.2', 'stable', 'stable'))
  await mount()
  assert.equal(container.textContent, '')
})

test('a stable build following nightly is still not labelled a nightly', async () => {
  install(stateFor('0.5.2', 'stable', 'nightly'))
  await mount()
  assert.equal(container.textContent, '')
})

test('a nightly build wears the chip, and its tooltip names the version and the channel', async () => {
  install(stateFor(NIGHTLY, 'nightly', 'nightly'))
  await mount()
  assert.equal(container.textContent, 'Nightly')
  const tip = await hoverTooltip()
  assert.equal(tip, `Nightly build ${NIGHTLY}. Updates from the nightly channel.`)
})

test('a nightly switched to stable keeps the chip and says it now follows stable', async () => {
  install(stateFor(NIGHTLY, 'nightly', 'nightly'))
  await mount()
  await act(async () => push?.(stateFor(NIGHTLY, 'nightly', 'stable')))
  assert.equal(container.textContent, 'Nightly')
  const tip = await hoverTooltip()
  assert.match(tip ?? '', /Following the stable channel/)
  assert.match(tip ?? '', new RegExp(NIGHTLY.replace(/\./g, '\\.')))
})

test('the tooltip copy for each channel the updater can report', () => {
  const identity = (channel: AppUpdateChannel) => ({ version: NIGHTLY, buildChannel: 'nightly' as const, channel })
  assert.equal(nightlyChipTooltip(identity('nightly')), `Nightly build ${NIGHTLY}. Updates from the nightly channel.`)
  assert.equal(
    nightlyChipTooltip(identity('stable')),
    `Nightly build ${NIGHTLY}. Following the stable channel: the next stable release replaces it.`,
  )
  assert.equal(
    nightlyChipTooltip(identity('dev')),
    `Nightly build ${NIGHTLY}. A development build; it does not update itself.`,
  )
})
