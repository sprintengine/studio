import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

test('model picker can become locked after history hydration without changing hook order', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window, { api: { platform: 'darwin' } })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ModelPickerPill } = await import('./modelPicker')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const props = {
    label: 'Test model',
    open: false,
    groups: [],
    selectedProviderId: 'provider',
    selectedModelId: 'model',
    onOpenChange: () => undefined,
    onSelect: () => undefined,
    onBrowseProvider: () => undefined,
    onAddKey: () => undefined,
  }
  try {
    await act(async () => root.render(createElement(ModelPickerPill, { ...props, locked: false })))
    expect(host.querySelector('button')).not.toBeNull()
    await act(async () => root.render(createElement(ModelPickerPill, { ...props, locked: true })))
    expect(host.textContent).toBe('Test model')
    expect(host.querySelector('button')).toBeNull()
    await act(async () => root.render(createElement(ModelPickerPill, { ...props, locked: false })))
    expect(host.querySelector('button')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
