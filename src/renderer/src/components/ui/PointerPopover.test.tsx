import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('PointerPopover', async () => {
  // The portal-propagation contract. `PointerPopover` renders into `<body>`, but
  // it stays a React CHILD of whatever opened it, and React propagates events
  // through the REACT tree rather than the DOM tree. Every consumer opens this
  // surface from inside something that already has handlers — a list row, a tab —
  // so without the seal, a press inside the card also drove the thing behind it.
  //
  // This is behaviour a markup snapshot cannot check, so it drives the real
  // component in a real DOM.

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
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { PointerPopover } = await import('./PointerPopover')

    let failures = 0
    function run(name: string, fn: () => void): void {
      try {
        fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    }

    // What the host would hear if the seal were missing. Each name is a real
    // defect that shipped through this leak: click selected the row behind the
    // card, mousedown's middle button closed the chat it was describing,
    // dblclick started a rename, contextmenu put the row's menu over the card,
    // and keydown drove the sidebar's roving tree focus.
    const heard: string[] = []

    function mount(): { host: HTMLElement; unmount: () => void } {
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      act(() =>
        root.render(
          <div
            onClick={() => heard.push('click')}
            onDoubleClick={() => heard.push('dblclick')}
            onMouseDown={() => heard.push('mousedown')}
            onContextMenu={() => heard.push('contextmenu')}
            onKeyDown={() => heard.push('keydown')}
          >
            <PointerPopover x={10} y={10} ariaLabel="Card" popupRole="dialog" onClose={() => {}}>
              <button type="button" data-testid="inner">
                Copy
              </button>
            </PointerPopover>
          </div>,
        ),
      )
      return {
        host,
        unmount: () => {
          act(() => root.unmount())
          host.remove()
        },
      }
    }

    const mounted = mount()
    const inner = dom.window.document.querySelector('[data-testid="inner"]') as HTMLElement
    assert.ok(inner, 'the surface rendered its content')

    // Cleared per case, so one leaking handler fails exactly its own assertion
    // instead of every assertion after it.
    const fire = (event: Event): void => {
      heard.length = 0
      act(() => {
        inner.dispatchEvent(event)
      })
    }
    const mouse = (type: string, init: MouseEventInit = {}) =>
      new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init })

    run('a click inside the card never reaches the opener', () => {
      fire(mouse('click'))
      assert.deepEqual(heard, [], 'clicking a control in the card must not also select the row behind it')
    })

    run('a press inside the card never reaches the opener', () => {
      fire(mouse('mousedown', { button: 1 }))
      assert.deepEqual(heard, [], 'a middle-click in the card must not close the chat it is describing')
    })

    run('selecting a word inside the card does not start a rename', () => {
      fire(mouse('dblclick'))
      assert.deepEqual(heard, [], 'a double-click is text selection here, not the opener’s gesture')
    })

    run('a right-click inside the card does not open the opener’s context menu', () => {
      fire(mouse('contextmenu'))
      assert.deepEqual(heard, [], 'the row’s menu must not land on top of the card')
    })

    run('keys pressed inside the card do not drive the surface behind it', () => {
      fire(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }))
      assert.deepEqual(heard, [], 'arrow keys in the card must not move the list’s roving focus')
    })

    run('the surface is still portaled to the body and named', () => {
      const surface = dom.window.document.querySelector('[role="dialog"][aria-label="Card"]')
      assert.ok(surface, 'the surface carries its popup role and required label')
      assert.equal(surface?.parentElement, dom.window.document.body, 'and it lives at the end of <body>')
    })

    mounted.unmount()
    process.exit(failures === 0 ? 0 : 1)
  }

  const suiteRun = main()

  await suiteRun
})
