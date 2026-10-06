import assert from 'node:assert/strict'

// An auxiliary window's appearance after it opens.
//
// It hydrates its settings once, so a theme or window material changed in a
// workspace window afterwards used to leave it frozen on the old one. It now
// adopts each save the workspace window makes — without writing the adopted
// settings back — and tells main nothing of its copy: a push as it mounted
// would re-save and re-apply that copy over a change it had not heard of.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, test } from 'vitest'

const SETTINGS_KEY = 'sprintengine-app-settings'

let dom: JSDOM
const settingsWrites: string[] = []
const mainPushes: string[] = []

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/?aux=diff',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  const setItem = dom.window.localStorage.setItem.bind(dom.window.localStorage)
  dom.window.Storage.prototype.setItem = function (key: string, value: string) {
    if (key === SETTINGS_KEY) settingsWrites.push(value)
    setItem(key, value)
  }
  domWindow.api = new Proxy(
    {
      platform: 'darwin',
      setColorScheme: () => {
        mainPushes.push('color-scheme')
        return Promise.resolve()
      },
      setWindowMaterial: () => {
        mainPushes.push('window-material')
        return Promise.resolve()
      },
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)
      },
    },
  )
})

test('an aux window follows the theme a workspace window saves, and writes and pushes nothing', async () => {
  const { useWorkspaceStore, flushWorkspaceSettingsWrite } = await import('../../store/workspaceStore')
  const { useAppTheme } = await import('../../hooks/useAppTheme')
  const { followStoredSettings } = await import('./auxSettingsWrite')

  function AuxRoot() {
    useAppTheme({ mirrorToMain: false })
    React.useEffect(() => followStoredSettings(), [])
    return null
  }
  const root = createRoot(dom.window.document.createElement('div') as unknown as Element)
  await act(async () => {
    root.render(React.createElement(AuxRoot))
  })
  assert.deepEqual(mainPushes, [], 'mounting tells main nothing')
  const before = useWorkspaceStore.getState().appSettings
  assert.notEqual(before.appearance.theme, 'light')

  // The workspace window saves a change to the theme.
  const saved = {
    state: { appSettings: { ...before, appearance: { ...before.appearance, theme: 'light' } } },
    version: 1,
  }
  const raw = JSON.stringify(saved)
  dom.window.localStorage.setItem(SETTINGS_KEY, raw)
  settingsWrites.length = 0
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: SETTINGS_KEY, newValue: raw }))
  })

  assert.equal(useWorkspaceStore.getState().appSettings.appearance.theme, 'light', 'the window adopts it')
  assert.equal(dom.window.document.documentElement.getAttribute('data-theme'), 'light', 'and wears it')
  flushWorkspaceSettingsWrite()
  assert.deepEqual(settingsWrites, [], 'what it adopted is not written back')
  assert.deepEqual(mainPushes, [], 'nor pushed to main')

  // Another key changing is none of its business.
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'something-else', newValue: '{}' }))
  })
  assert.equal(useWorkspaceStore.getState().appSettings.appearance.theme, 'light')
  act(() => root.unmount())
})
