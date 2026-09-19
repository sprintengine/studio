import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('Modal.repaintPause', async () => {
  // The wiring between the dialog and the terminal panes, driven in a real DOM.
  //
  // A modal over a streaming terminal costs `repaint rate x covered area`: the
  // compositor redoes the covered region every time the pane invalidates it, and
  // a pane invalidates it on every PTY chunk. `Modal` therefore holds the
  // repaint-pause signal for as long as it is on screen, and the xterm output
  // queue withholds writes while it does.
  //
  // The failure this file exists to make impossible is the opposite one: a hold
  // that outlives its dialog freezes every terminal in the product with no way
  // back short of a reload. The last case here rips the dialog out of the
  // document WITHOUT letting React clean up, which is what a thrown render or an
  // error boundary looks like from the store's side, and asserts the pause heals
  // itself.

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

  const suiteRun = main()

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { Modal } = await import('./Modal')
    const {
      isTerminalRepaintPaused,
      resetTerminalRepaintPauseForTests,
      runTerminalRepaintPauseWatchdogForTests,
      terminalRepaintPauseDebugState,
    } = await import('../../utils/terminalRepaintPause')

    let failures = 0
    function run(name: string, fn: () => void): void {
      resetTerminalRepaintPauseForTests()
      try {
        fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    }

    function mount(open: boolean): { setOpen: (next: boolean) => void; host: HTMLElement; unmount: () => void } {
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      const render = (isOpen: boolean) => {
        act(() => {
          root.render(
            // `children` is a required prop on `Modal`, so it goes IN the props
            // rather than as a `createElement` rest argument — the rest form
            // never satisfies a required `children`.
            React.createElement(Modal, {
              open: isOpen,
              onClose: () => {},
              label: 'Test dialog',
              children: React.createElement('p', null, 'body'),
            }),
          )
        })
      }
      render(open)
      return {
        host,
        setOpen: render,
        unmount: () => {
          act(() => root.unmount())
          host.remove()
        },
      }
    }

    run('an open dialog pauses terminal output, and closing it resumes', () => {
      assert.equal(isTerminalRepaintPaused(), false, 'nothing paused with no dialog')

      const dialog = mount(true)
      assert.equal(isTerminalRepaintPaused(), true, 'the open dialog holds the pause')

      dialog.setOpen(false)
      assert.equal(isTerminalRepaintPaused(), false, 'closing releases it')

      // And re-opening the same instance takes a fresh hold.
      dialog.setOpen(true)
      assert.equal(isTerminalRepaintPaused(), true)
      dialog.unmount()
      assert.equal(isTerminalRepaintPaused(), false, 'unmounting releases it')
    })

    run('a dialog that never renders takes no hold', () => {
      const dialog = mount(false)
      assert.equal(isTerminalRepaintPaused(), false)
      assert.equal(terminalRepaintPauseDebugState().holdCount, 0)
      dialog.unmount()
    })

    run('stacked dialogs resume only when the last one closes', () => {
      const outer = mount(true)
      const inner = mount(true)
      assert.equal(terminalRepaintPauseDebugState().holdCount, 2)

      inner.unmount()
      assert.equal(isTerminalRepaintPaused(), true, 'the outer dialog still covers the panes')

      outer.unmount()
      assert.equal(isTerminalRepaintPaused(), false)
    })

    run('a dialog torn out of the document without cleanup cannot freeze the terminals', () => {
      const dialog = mount(true)
      assert.equal(isTerminalRepaintPaused(), true)

      // React still believes the tree is mounted, so no cleanup runs and the
      // release is never called — the shape of a thrown render or a swallowed
      // subtree. The node is simply gone from the document.
      dialog.host.remove()
      assert.equal(isTerminalRepaintPaused(), true, 'still held until the watchdog looks')

      runTerminalRepaintPauseWatchdogForTests()
      assert.equal(isTerminalRepaintPaused(), false, 'the orphaned hold is reclaimed')
      assert.equal(terminalRepaintPauseDebugState().holdCount, 0)

      act(() => {
        /* leave the detached root alone; nothing else asserts on it */
      })
    })

    resetTerminalRepaintPauseForTests()
    if (failures > 0) {
      console.error(`${failures} failing`)
      process.exit(1)
    }
    console.log('Modal.repaintPause.test.tsx: ok')
  }

  await suiteRun
})
