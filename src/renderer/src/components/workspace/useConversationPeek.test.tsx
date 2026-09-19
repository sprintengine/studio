import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('useConversationPeek', async () => {
  // The caching and one-card-at-a-time contract behind the peek. None of this is
  // visible in markup: which session is read, how often, and what a close throws
  // away. So this drives the hook in a real DOM against a counted stub of the
  // preload call.
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
    source: 'transcript'
    first: null
    since: []
    images: []
  }

  const reads: string[] = []
  let answer: (sessionId: string) => Promise<Peek> = async (sessionId) => ({
    sessionId,
    source: 'transcript',
    first: null,
    since: [],
    images: [],
  })

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

    await run('the card opens on the terminal it was given', async () => {
      reads.length = 0
      const mounted = mount(DS)
      act(() => hook!.openNow())
      await settle()
      assert.equal(hook!.peek?.sessionId, DS, 'the session it was handed is the one on screen')
      assert.deepEqual(reads, [DS], 'exactly one read, for the terminal on screen')
      mounted.unmount()
    })

    await run('moving to another agent line reads that agent', async () => {
      reads.length = 0
      const mounted = mount(DS)
      act(() => hook!.openNow())
      await settle()
      mounted.moveTo(LL)
      await settle()
      assert.equal(hook!.peek?.sessionId, LL, 'the card is the agent the pointer is on')
      assert.deepEqual(reads, [DS, LL], 'and that agent’s conversation is read')
      mounted.unmount()
    })

    await run('a terminal already viewed is not read again while the card is open', async () => {
      reads.length = 0
      const mounted = mount(DS)
      act(() => hook!.openNow())
      await settle()
      mounted.moveTo(LL)
      await settle()
      mounted.moveTo(DS)
      await settle()
      mounted.moveTo(LL)
      await settle()
      assert.deepEqual(
        reads,
        [DS, LL],
        'sweeping back up the row’s agent lines is instant and never re-streams a transcript',
      )
      mounted.unmount()
    })

    await run('the body is never blank: a terminal not yet read is loading, not unreadable', async () => {
      const mounted = mount(DS)
      act(() => hook!.openNow())
      assert.equal(hook!.loading, true, 'the very first frame already says it is reading')
      // Read through a snapshot: `assert.equal` narrows what it is handed, and
      // narrowing `hook!.peek` to null here would make the post-settle read below
      // impossible to type.
      const inFlight = hook!
      assert.equal(inFlight.peek, null, 'with nothing to show yet')
      await settle()
      assert.equal(hook!.loading, false, 'and it settles')
      assert.equal(hook!.peek?.sessionId, DS)
      mounted.unmount()
    })

    await run('a read that fails settles rather than spinning forever', async () => {
      answer = async () => {
        throw new Error('main said no')
      }
      const mounted = mount(DS)
      act(() => hook!.openNow())
      await settle()
      assert.equal(hook!.loading, false, 'no endless skeleton')
      assert.equal(hook!.peek, null, 'and the card falls back to saying so')
      answer = async (sessionId) => ({ sessionId, source: 'transcript', first: null, since: [], images: [] })
      mounted.unmount()
    })

    await run('closing drops the answers, so re-opening reads fresh', async () => {
      reads.length = 0
      const mounted = mount(DS)
      act(() => hook!.openNow())
      await settle()
      mounted.moveTo(LL)
      await settle()
      mounted.moveTo(DS)
      act(() => hook!.closeNow())
      act(() => hook!.openNow())
      await settle()
      assert.deepEqual(
        reads,
        [DS, LL, DS],
        'the conversation is re-read — the last visit’s messages may have moved on since',
      )
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

    process.exit(failures === 0 ? 0 : 1)
  }

  const suiteRun = main()

  await suiteRun
})
