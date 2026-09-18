import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// What matters about this menu is timing no markup snapshot can reach: a second
// click landing before React has disabled the trigger, and a failure on the
// direct path — where no menu was ever open to say so. So this suite stands up
// a real DOM and clicks the way a person does.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = NoopResizeObserver

let failures = 0
function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`)
    })
    .catch((error) => {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    })
}

function liveAgent(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    processAlive: true,
    kind: 'agent',
    cli: 'claude-code',
    agentId: `agent-${sessionId}`,
    workspaceId: 'w1',
    visible: true,
  }
}

// The flow module reads `window.api.terminalList()`; the menu reads nothing
// else of the bridge.
function stubSessions(sessions: Record<string, unknown>[]): void {
  ;(dom.window as unknown as { api: unknown }).api = {
    terminalList: async () => sessions,
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { UseSkillInAgentMenu } = await import('./UseSkillInAgentMenu')

  type Props = Parameters<typeof UseSkillInAgentMenu>[0]

  function mount(props: Props): {
    trigger: () => HTMLButtonElement
    menuItems: () => HTMLButtonElement[]
    click: (element: Element | undefined) => Promise<void>
    clickTwice: (element: Element | undefined) => Promise<void>
    unmount: () => void
  } {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<UseSkillInAgentMenu {...props} />)
    })
    // The trigger is this mount's own; the surface is portaled to <body>, so
    // rows are queried from there — one menu is open at a time in these tests.
    const query = <T extends Element>(selector: string): T[] =>
      [...dom.window.document.body.querySelectorAll(selector)] as unknown as T[]
    const view = {
      trigger: () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!,
      menuItems: () => query<HTMLButtonElement>('[data-menu-item="true"]'),
      click: async (element: Element | undefined) => {
        assert.ok(element, 'element to click exists')
        await act(async () => {
          element!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        })
      },
      // Both clicks inside ONE act, before any state React might set between
      // them has been flushed to the DOM — the double-click a person makes.
      clickTwice: async (element: Element | undefined) => {
        assert.ok(element, 'element to click exists')
        await act(async () => {
          element!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
          element!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
        })
      },
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
    return view
  }

  await run('the direct path runs the round trip once for a double-click', async () => {
    stubSessions([liveAgent('only')])
    const used: string[] = []
    const view = mount({
      skillName: 'Backlog',
      directWhenSingle: true,
      onUse: async (session) => {
        used.push(session.sessionId)
        await flush()
        return null
      },
    })
    await view.clickTwice(view.trigger())
    await act(async () => {
      await flush()
      await flush()
    })
    assert.deepEqual(used, ['only'], 'one install, one paste')
    assert.equal(view.menuItems().length, 0, 'and no menu: one agent was not a question')
    view.unmount()
  })

  await run('a direct use that fails opens the menu around the message', async () => {
    stubSessions([liveAgent('only')])
    const view = mount({
      skillName: 'Backlog',
      directWhenSingle: true,
      onUse: async () => 'That agent is no longer running. Pick another.',
    })
    await view.click(view.trigger())
    await act(async () => {
      await flush()
      await flush()
    })
    const menu = dom.window.document.body.querySelector('[role="menu"]')
    assert.ok(menu, 'the menu is open: the failure had nowhere else to be said')
    assert.match(menu!.textContent ?? '', /no longer running/, 'and it says why')
    view.unmount()
  })

  await run('two agents is a question: the direct path opens the menu with both', async () => {
    stubSessions([liveAgent('a'), liveAgent('b')])
    const used: string[] = []
    const view = mount({
      skillName: 'Backlog',
      directWhenSingle: true,
      onUse: async (session) => {
        used.push(session.sessionId)
        return null
      },
    })
    await view.click(view.trigger())
    await act(async () => {
      await flush()
    })
    assert.deepEqual(used, [], 'nothing was pasted anywhere')
    // A row reads "<label><cli>": the CLI rides in the row's trailing slot.
    assert.deepEqual(
      view.menuItems().map((item) => item.textContent),
      ['agent-aclaude-code', 'agent-bclaude-code'],
      'each agent by name, in list order, with its CLI beside it',
    )
    // A row does the work, once, and the menu closes behind it.
    await view.clickTwice(view.menuItems()[1])
    await act(async () => {
      await flush()
    })
    assert.deepEqual(used, ['b'])
    assert.equal(dom.window.document.body.querySelector('[role="menu"]'), null, 'closed on success')
    view.unmount()
  })

  await run('without directWhenSingle the click only opens the menu', async () => {
    stubSessions([liveAgent('only')])
    const used: string[] = []
    const view = mount({
      skillName: 'Backlog',
      onUse: async (session) => {
        used.push(session.sessionId)
        return null
      },
    })
    await view.click(view.trigger())
    await act(async () => {
      await flush()
    })
    assert.deepEqual(used, [], "the Installed inventory's menu has always opened first")
    assert.equal(view.menuItems().length, 1)
    view.unmount()
  })

  if (failures > 0) {
    console.error(`${failures} failing`)
    process.exit(1)
  }
  console.log('UseSkillInAgentMenu.test.tsx ok')
}

void main()
