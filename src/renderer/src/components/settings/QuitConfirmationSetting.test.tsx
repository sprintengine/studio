import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import { QuitConfirmationSetting } from './QuitConfirmationSetting'

// Settings → General, "Ask before quitting while agents are working": the
// value main holds, written back through main.

type Api = {
  getQuitConfirmation: () => Promise<boolean | null>
  setQuitConfirmation: (enabled: boolean) => Promise<boolean | null>
}

let root: Root
let container: HTMLElement

function install(api: Api) {
  ;(window as unknown as { api: Api }).api = api
}

const toggle = () => container.querySelector<HTMLElement>('[role="switch"]')

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
  g.getComputedStyle = dom.window.getComputedStyle
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

test('shows what main holds, and writes a flip back through main', async () => {
  const writes: boolean[] = []
  install({
    getQuitConfirmation: async () => true,
    setQuitConfirmation: async (enabled) => {
      writes.push(enabled)
      return enabled
    },
  })
  await act(async () => root.render(<QuitConfirmationSetting />))
  assert.match(container.textContent ?? '', /Ask before quitting while agents are working/)
  assert.equal(toggle()?.getAttribute('aria-checked'), 'true')
  await act(async () => toggle()!.click())
  assert.deepEqual(writes, [false])
  assert.equal(toggle()?.getAttribute('aria-checked'), 'false')
})

test('a client with no quit of its own shows nothing', async () => {
  install({ getQuitConfirmation: async () => null, setQuitConfirmation: async () => null })
  await act(async () => root.render(<QuitConfirmationSetting />))
  assert.equal(container.textContent, '')
})
