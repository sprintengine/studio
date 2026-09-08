import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The selection and caching contract behind the roster (mockup frame 9). None
// of this is visible in markup: hover previews without committing, a press
// pins, the body follows whichever is in force, and each terminal is read at
// most once per opening. So this drives the hook in a real DOM against a
// counted stub of the preload call.

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

type Peek = { sessionId: string; source: 'transcript'; first: null; since: [] }

const reads: string[] = []
let answer: (sessionId: string) => Promise<Peek> = async (sessionId) => ({
  sessionId,
  source: 'transcript',
  first: null,
  since: [],
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

  function Probe({ defaultSessionId, slot }: { defaultSessionId: string | null; slot: Slot }) {
    const value = useConversationPeek(defaultSessionId)
    slot.current = value
    hook = value
    return null
  }

  function mount(defaultSessionId: string | null) {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)
    const slot = { current: null as unknown as Hook }
    act(() => root.render(<Probe defaultSessionId={defaultSessionId} slot={slot} />))
    return {
      slot,
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
    assert.equal(hook!.selectedSessionId, DS, 'the default is what the body shows')
    assert.equal(hook!.pinnedSessionId, null, 'and nothing is committed until someone commits it')
    assert.deepEqual(reads, [DS], 'exactly one read, for the terminal on screen')
    mounted.unmount()
  })

  await run('hovering a disc moves the body and commits nothing', async () => {
    reads.length = 0
    const mounted = mount(DS)
    act(() => hook!.openNow())
    await settle()
    act(() => hook!.previewAgent(LL))
    await settle()
    assert.equal(hook!.selectedSessionId, LL, 'the body moved to the hovered terminal')
    assert.equal(hook!.pinnedSessionId, null, 'a hover is not a choice')
    assert.deepEqual(reads, [DS, LL], 'and the hovered terminal is read')
    mounted.unmount()
  })

  await run('leaving the roster without a press returns the body to where it was', async () => {
    const mounted = mount(DS)
    act(() => hook!.openNow())
    await settle()
    act(() => hook!.previewAgent(LL))
    await settle()
    act(() => hook!.endPreview())
    assert.equal(hook!.selectedSessionId, DS, 'back to the default')
    mounted.unmount()
  })

  await run('pinning survives the pointer leaving the roster', async () => {
    const mounted = mount(DS)
    act(() => hook!.openNow())
    await settle()
    act(() => hook!.pinAgent(LL))
    await settle()
    assert.equal(hook!.pinnedSessionId, LL, 'the press committed')
    act(() => hook!.endPreview())
    assert.equal(
      hook!.selectedSessionId,
      LL,
      'so the pointer can travel down to a file chip without the card changing underneath it',
    )
    mounted.unmount()
  })

  await run('a hover over a third disc previews ON TOP of the pin, and falls back to it', async () => {
    const mounted = mount(DS)
    act(() => hook!.openNow())
    await settle()
    act(() => hook!.pinAgent(LL))
    await settle()
    act(() => hook!.previewAgent(DS))
    assert.equal(hook!.selectedSessionId, DS, 'the hover wins while it lasts')
    assert.equal(hook!.pinnedSessionId, LL, 'without disturbing the commit')
    act(() => hook!.endPreview())
    assert.equal(hook!.selectedSessionId, LL, 'and falls back to the pinned one, not the default')
    mounted.unmount()
  })

  await run('a terminal already viewed is not read again while the card is open', async () => {
    reads.length = 0
    const mounted = mount(DS)
    act(() => hook!.openNow())
    await settle()
    act(() => hook!.previewAgent(LL))
    await settle()
    act(() => hook!.previewAgent(DS))
    await settle()
    act(() => hook!.previewAgent(LL))
    await settle()
    assert.deepEqual(reads, [DS, LL], 'switching back is instant and never re-streams a transcript')
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
    answer = async (sessionId) => ({ sessionId, source: 'transcript', first: null, since: [] })
    mounted.unmount()
  })

  await run('closing drops the answers and the pin, so re-opening reads fresh', async () => {
    reads.length = 0
    const mounted = mount(DS)
    act(() => hook!.openNow())
    await settle()
    act(() => hook!.pinAgent(LL))
    await settle()
    act(() => hook!.closeNow())
    act(() => hook!.openNow())
    await settle()
    assert.equal(hook!.pinnedSessionId, null, 'a pin from a previous visit is not a choice still being made')
    assert.equal(hook!.selectedSessionId, DS, 'so the card opens where it always opens')
    assert.deepEqual(
      reads,
      [DS, LL, DS],
      'and the conversation is re-read — the last visit’s messages may have moved on since',
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

void main()
