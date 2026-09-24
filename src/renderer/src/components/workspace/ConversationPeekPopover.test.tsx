import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('ConversationPeekPopover', async () => {
  // The sidebar anchor's dismissal rules, which are not visible in markup and
  // which one regression already broke in the worst possible way: the card
  // appeared and vanished within a frame.
  //
  // The cause is worth stating, because the same shape will be reached for again.
  // `scroll` does not bubble, so a surface that wants to dismiss on scroll has to
  // listen in the CAPTURE phase to catch nested scrollers. Capture on `window`
  // sees every scroller in the document — including the card's own thread, which
  // scrolls itself to its newest message in a layout effect. The card therefore
  // dismissed itself one frame after opening, and a person scrolling the thread
  // by hand destroyed what they were reading.
  //
  // So the rule under test is: a scroll of the app BENEATH the card dismisses it;
  // a scroll that starts INSIDE it does not.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  ;(dom.window as unknown as { api: unknown }).api = {
    readConversationPeek: async (sessionId: string) => ({
      sessionId,
      source: 'live' as const,
      first: { id: 'm1', text: 'Fix the retry budget', at: Date.now() - 3_600_000, truncatedChars: 0 },
      since: [],
    }),
  }

  const identities = [
    {
      name: 'Retry budget for stalled runs',
      status: null,
      agent: {
        sessionId: 'session-1',
        cli: null,
        model: 'claude-opus-5',
        fileChanges: [],
        pullRequests: [],
        activeSubagents: 0,
        contextUsage: null,
      },
    },
  ]

  const failures: string[] = []
  function run(name: string, body: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
      .then(body)
      .then(() => {
        console.log(`ok - ${name}`)
      })
      .catch((error: unknown) => {
        failures.push(name)
        console.log(`not ok - ${name}`)
        console.log(`  ${(error as Error).message}`)
      })
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { ConversationPeekPopover } = await import('./ConversationPeekPopover')

    const document = dom.window.document

    // The anchor lives inside a `[data-row-key]` row, which is what the component
    // binds its hover to — the whole row, both lines, per the owner's ruling.
    async function openCard(): Promise<{ row: Element; cleanup: () => void }> {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          React.createElement(
            'div',
            { 'data-row-key': 'ws-1' },
            // `children` rides the props object: the popover declares it as a
            // required prop, and createElement's rest children do not satisfy one.
            React.createElement(ConversationPeekPopover, {
              identities,
              now: Date.now(),
              children: React.createElement('span', null, identities[0]!.name),
            }),
          ),
        )
      })
      const row = host.querySelector('[data-row-key]')
      assert.ok(row, 'the row rendered')
      await act(async () => {
        row!.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: false }))
      })
      // The dwell, then the read.
      await act(async () => {
        await sleep(400)
      })
      return {
        row: row!,
        cleanup: () => {
          act(() => root.unmount())
          host.remove()
        },
      }
    }

    const isOpen = (): boolean => Boolean(document.querySelector('[role="dialog"]'))

    await run('the card opens on a hover over the row and stays open', async () => {
      const { cleanup } = await openCard()
      assert.equal(isOpen(), true, 'the dwell elapsed and the card is up')
      cleanup()
    })

    await run('a scroll INSIDE the card does not dismiss it', async () => {
      const { cleanup } = await openCard()
      assert.equal(isOpen(), true, 'precondition: the card is up')
      const inside =
        document.querySelector('[role="dialog"]')!.querySelector('*') ?? document.querySelector('[role="dialog"]')!
      await act(async () => {
        // Exactly what the thread's own layout effect produces: a scroll event
        // whose target is inside the card. `scroll` does not bubble, so it is
        // dispatched on the element itself and reaches the listener by capture.
        inside.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }))
        await sleep(50)
      })
      assert.equal(isOpen(), true, 'the card survived its own thread scrolling')
      cleanup()
    })

    await run('a scroll of the app beneath the card DOES dismiss it', async () => {
      const { cleanup } = await openCard()
      assert.equal(isOpen(), true, 'precondition: the card is up')
      const scroller = document.createElement('div')
      document.body.appendChild(scroller)
      await act(async () => {
        scroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }))
        await sleep(50)
      })
      assert.equal(isOpen(), false, 'a row scrolling away takes its card with it')
      scroller.remove()
      cleanup()
    })

    if (failures.length > 0) {
      console.error(`\n${failures.length} failing: ${failures.join(', ')}`)
      process.exit(1)
    }
    console.log('\nConversationPeekPopover tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
