import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('useConversationPeek', async () => {
  // The hover and one-card-at-a-time contract behind the peek. None of this is
  // visible in markup, so this drives the hook in a real DOM — against a counted
  // stub of the preload call the card USED to make, which it must not make any
  // more (2026-10-04): everything the card says rides its identity.
  //
  // The hook no longer owns a SELECTION (2026-09-09). One card is one agent, and
  // which agent is the shell's business: the sidebar reads the `data-peek-session`
  // of the line under the pointer and hands the hook that session id, which is
  // why the session a mounted hook is given can change while it is open.

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

  type Peek = {
    sessionId: string
    source: 'live'
    first: null
    since: []
  }

  const reads: string[] = []
  const answer = async (sessionId: string): Promise<Peek> => ({ sessionId, source: 'live', first: null, since: [] })

  ;(dom.window as unknown as { api: unknown }).api = {
    readConversationPeek: (sessionId: string) => {
      reads.push(sessionId)
      return answer(sessionId)
    },
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { useConversationPeek } = await import('./useConversationPeek')

    let failures = 0
    async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
      try {
        await fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    }

    type Hook = ReturnType<typeof useConversationPeek>
    // A slot per mount, rewritten on every render, so a test that holds two
    // anchors open at once reads each one's CURRENT state rather than a snapshot.
    type Slot = { current: Hook }
    let hook: Hook | null = null

    function Probe({ sessionId, slot }: { sessionId: string | null; slot: Slot }) {
      const value = useConversationPeek(sessionId)
      slot.current = value
      hook = value
      return null
    }

    function mount(sessionId: string | null) {
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      const slot = { current: null as unknown as Hook }
      act(() => root.render(<Probe sessionId={sessionId} slot={slot} />))
      return {
        slot,
        // The shell moving the card to another agent line: same mounted hook, a
        // different session id.
        moveTo: (next: string | null) => {
          act(() => root.render(<Probe sessionId={next} slot={slot} />))
        },
        unmount: () => {
          act(() => root.unmount())
          host.remove()
        },
      }
    }

    // Lets the read's promise settle and React apply the resulting state.
    const settle = async (): Promise<void> => {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    const DS = 'session-ds'
    const LL = 'session-ll'

    await run('opening reads nothing from main — the card is drawn from its identity', async () => {
      reads.length = 0
      const mounted = mount(DS)
      act(() => hook!.openNow())
      await settle()
      assert.equal(hook!.open, true, 'the card is up')
      mounted.moveTo(LL)
      await settle()
      assert.equal(hook!.open, true, 'and stays up as the pointer moves to another agent line')
      assert.deepEqual(reads, [], 'no conversation read, for either agent')
      mounted.unmount()
    })

    await run('a row with no session to describe never opens', async () => {
      const mounted = mount(null)
      act(() => hook!.openNow())
      await settle()
      assert.equal(hook!.open, false)
      mounted.unmount()
    })

    await run('only one peek is open at a time, across anchors', async () => {
      // Frame 3's ruling, and it cannot be enforced by either anchor alone: both
      // open on focus as well as hover, so focusing a tab and then hovering a
      // sidebar row is the sequence that put two cards on screen.
      const first = mount(DS)
      act(() => first.slot.current.openNow())
      await settle()
      assert.equal(first.slot.current.open, true, 'the first anchor is showing')

      const second = mount(LL)
      act(() => second.slot.current.openNow())
      await settle()
      assert.equal(second.slot.current.open, true, 'the newcomer opens')
      assert.equal(first.slot.current.open, false, 'and the one that was already up closed itself')

      second.unmount()
      first.unmount()
    })

    await run('an anchor that unmounts while open releases the latch', async () => {
      const first = mount(DS)
      act(() => first.slot.current.openNow())
      await settle()
      first.unmount()

      const second = mount(LL)
      act(() => second.slot.current.openNow())
      await settle()
      assert.equal(second.slot.current.open, true, 'a released latch never blocks the next card')
      second.unmount()
    })

    if (failures !== 0) process.exit(1)
  }

  const suiteRun = main()

  await suiteRun
})
