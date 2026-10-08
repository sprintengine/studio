import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import { KeepAwakeSetting } from './KeepAwakeSetting'

// Settings → General, "Keep the computer awake while agents work": the value
// main holds, written back through main.

type Api = {
  getKeepAwake: () => Promise<boolean | null>
  setKeepAwake: (enabled: boolean) => Promise<boolean | null>
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
    getKeepAwake: async () => true,
    setKeepAwake: async (enabled) => {
      writes.push(enabled)
      return enabled
    },
  })
  await act(async () => root.render(<KeepAwakeSetting />))
  assert.match(container.textContent ?? '', /Keep the computer awake while agents work/)
  assert.equal(toggle()?.getAttribute('aria-checked'), 'true')
  await act(async () => toggle()!.click())
  assert.deepEqual(writes, [false])
  assert.equal(toggle()?.getAttribute('aria-checked'), 'false')
})

test('a write main refuses puts the switch back', async () => {
  install({
    getKeepAwake: async () => true,
    setKeepAwake: async () => {
      throw new Error('main is gone')
    },
  })
  await act(async () => root.render(<KeepAwakeSetting />))
  await act(async () => toggle()!.click())
  assert.equal(toggle()?.getAttribute('aria-checked'), 'true')
})

test('a client whose machine is not this one shows nothing', async () => {
  install({ getKeepAwake: async () => null, setKeepAwake: async () => null })
  await act(async () => root.render(<KeepAwakeSetting />))
  assert.equal(container.textContent, '')
})
