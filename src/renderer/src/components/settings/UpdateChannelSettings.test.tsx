import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { AppUpdateCheckResult, AppUpdateTrack } from '../../../../shared/electron-api'
import { UpdateChannelSettings } from './UpdateChannelSettings'

// Settings → General, the update channel row: it reads the channel main
// resolved, writes a pick back through main, and hands the state that check
// produced to the version row above it.

type Api = {
  updateGetChannel: () => Promise<{ channel: AppUpdateTrack; chosen: boolean }>
  updateSetChannel: (channel: AppUpdateTrack) => Promise<AppUpdateCheckResult>
}

let root: Root
let container: HTMLElement
let setCalls: AppUpdateTrack[]
let results: AppUpdateCheckResult[]

function install(api: Api) {
  ;(window as unknown as { api: Api }).api = api
}

function resultFor(channel: AppUpdateTrack): AppUpdateCheckResult {
  return {
    ok: true,
    message: 'SprintEngine is up to date.',
    state: {
      status: 'not_available',
      version: '0.5.2',
      channel,
      packaged: true,
      updateVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseNotesUrl: null,
      downloaded: false,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null,
    },
  }
}

async function mount() {
  await act(async () => {
    root.render(<UpdateChannelSettings onResult={(result) => results.push(result)} />)
  })
}

const radio = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((el) => el.textContent === label)!

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.navigator = dom.window.navigator
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.Node = dom.window.Node
  g.MouseEvent = dom.window.MouseEvent
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.getComputedStyle = dom.window.getComputedStyle
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  setCalls = []
  results = []
})

afterEach(async () => {
  await act(async () => root.unmount())
})

test('shows the channel main resolved, with the sentence for that channel', async () => {
  install({
    updateGetChannel: async () => ({ channel: 'nightly', chosen: false }),
    updateSetChannel: async (channel) => resultFor(channel),
  })
  await mount()
  const group = container.querySelector('[role="radiogroup"]')!
  assert.equal(group.getAttribute('aria-label'), 'Update channel')
  assert.equal(radio('Nightly').getAttribute('aria-checked'), 'true')
  assert.equal(radio('Stable').getAttribute('aria-checked'), 'false')
  const help = container.querySelector(`#${group.getAttribute('aria-describedby')}`)!
  assert.match(help.textContent ?? '', /^Nightly gets the newest changes from main/)
})

test('picking a channel saves it through main and hands back the state its check produced', async () => {
  install({
    updateGetChannel: async () => ({ channel: 'stable', chosen: false }),
    updateSetChannel: async (channel) => {
      setCalls.push(channel)
      return resultFor(channel)
    },
  })
  await mount()
  await act(async () => radio('Nightly').click())
  assert.deepEqual(setCalls, ['nightly'])
  assert.equal(results.length, 1)
  assert.equal(results[0].state.channel, 'nightly')
  assert.equal(radio('Nightly').getAttribute('aria-checked'), 'true')
  assert.match(container.textContent ?? '', /Nightly gets the newest changes/)

  // Picking the channel already selected is not another check.
  await act(async () => radio('Nightly').click())
  assert.deepEqual(setCalls, ['nightly'])
  await act(async () => radio('Stable').click())
  assert.deepEqual(setCalls, ['nightly', 'stable'])
  assert.match(container.textContent ?? '', /Stable gets a release once it has already run as a nightly/)
})

test('a pick main refuses goes back to the channel that was showing', async () => {
  install({
    updateGetChannel: async () => ({ channel: 'stable', chosen: true }),
    updateSetChannel: async () => {
      throw new Error('refused')
    },
  })
  await mount()
  await act(async () => radio('Nightly').click())
  assert.equal(radio('Stable').getAttribute('aria-checked'), 'true')
  assert.equal(results.length, 0)
})
