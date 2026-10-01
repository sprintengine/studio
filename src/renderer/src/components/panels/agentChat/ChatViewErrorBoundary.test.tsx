import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'

// A chat that throws while rendering stops in its own pane: the rest of the
// window stays drawn, the pane says what happened, and Reload chat draws it
// again. Moving the pane to another chat starts clean.

test('a chat that throws stops in its pane, says so, and draws again on Reload chat', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { ChatViewErrorBoundary } = await import('./ChatViewErrorBoundary')
    let broken = true
    function Chat({ name }: { name: string }) {
      if (broken) throw new Error(`a reply nobody expected\nat ${name}`)
      return createElement('p', null, `chat ${name}`)
    }
    function Window({ chat }: { chat: string }) {
      return createElement(
        'main',
        null,
        createElement('nav', null, 'sidebar'),
        createElement(ChatViewErrorBoundary, { chatKey: chat, children: createElement(Chat, { name: chat }) }),
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Window, { chat: 'one' })))
    expect(host.textContent).toContain('sidebar')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('This chat hit a problem and stopped.')
    expect(host.textContent).toContain('a reply nobody expected')
    expect(host.textContent).not.toContain('at one')
    broken = false
    const reload = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reload chat')!
    await act(async () => reload.click())
    expect(host.textContent).toContain('chat one')
    // A failure in one chat does not follow the pane to the next.
    broken = true
    await act(async () => root.render(createElement(Window, { chat: 'two' })))
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    broken = false
    await act(async () => root.render(createElement(Window, { chat: 'three' })))
    expect(host.textContent).toContain('chat three')
    await act(async () => root.unmount())
  } finally {
    quiet.mockRestore()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
