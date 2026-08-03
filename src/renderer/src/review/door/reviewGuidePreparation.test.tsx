import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The guide banner's action block. Two things live here.
//
// The preparation choices (MC-1788). Depth and the guide agent are offered where
// the guide is invoked, never in a settings tab, and they are remembered: the door
// unmounts when it closes, so the choice has to live in the settings slice rather
// than component state. This suite drives the real control against the real store —
// pressing a segment must move the value the door hands to `useReviewSession` as
// `depth`, and reopening the door must come back on it. What that depth then does
// to the start IPC is pinned in `useReviewSession.test.tsx`; together the two cover
// the whole thread.
//
// And the way out (MC-1804). While the guide works the block becomes the terminal
// link plus Stop, wired to the `review:stop-brief-run` IPC that shipped with epic
// 1779 and had no caller until now.

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
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia
// The CLI picker measures its label with TruncatedText, which jsdom has no
// ResizeObserver for; the no-op keeps the control renderable without changing it.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = NoopResizeObserver

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { readReviewGuideDefaults } = await import('./reviewAppState')
  const { ReviewGuideActions, useReviewGuideRuntime } = await import('./ReviewGuideControls')
  type ReviewGuideRuntime = import('./ReviewGuideControls').ReviewGuideRuntime
  type ReviewSession = import('../canvas/useReviewSession').ReviewSession
  type GuideTerminalLink = import('./useGuideTerminal').GuideTerminalLink

  // The banner's action block only reads the run state off the session, so a
  // resting stub is all it takes to render the resting (choices + Prepare) face.
  const startRuns: number[] = []
  const session = {
    run: { running: false, phase: null, error: null },
    startRun: () => startRuns.push(1),
  } as unknown as ReviewSession
  const terminal = { terminal: null, open: async () => {} } as unknown as GuideTerminalLink

  let runtime: ReviewGuideRuntime | null = null
  function Banner(): JSX.Element {
    runtime = useReviewGuideRuntime()
    return <ReviewGuideActions session={session} runtime={runtime} terminal={terminal} />
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)

  // Open the door: mount the banner and return handles onto the depth control.
  async function openDoor() {
    const root = createRoot(container)
    await act(async () => root.render(<Banner />))
    const segments = () => [...container.querySelectorAll('[role="radio"]')] as HTMLElement[]
    return {
      root,
      segments,
      segment: (label: string) => {
        const found = segments().find((node) => node.textContent?.trim() === label)
        assert.ok(found, `the depth control must offer "${label}"`)
        return found
      },
      current: () => {
        assert.ok(runtime, 'the banner must have rendered')
        return runtime
      },
    }
  }

  // The choice is remembered in review's own app-level module state (MC-2090),
  // not in core's settings — read it back the way the module does.
  const depthInStore = () => readReviewGuideDefaults().depth

  // A fresh profile: three plain choices, standard selected, and the one-liner for
  // it on screen — the difference between the three is never left to a tooltip.
  const first = await openDoor()
  assert.deepEqual(
    first.segments().map((node) => node.textContent?.trim()),
    ['Overview', 'Standard', 'Deep'],
    'the three depths read in the reviewer’s words, not the guide’s wire values',
  )
  assert.equal(first.segment('Standard').getAttribute('aria-checked'), 'true', 'a fresh profile rests on Standard')
  assert.match(
    container.textContent ?? '',
    /Adds notes on the lines worth pausing on/,
    'the selected depth explains what it produces',
  )
  assert.equal(first.current().depth, 'standard', 'and that is what the door passes to the session')
  // The explanation is visible copy AND the group's description, so it is not a
  // sighted-only affordance.
  const group = container.querySelector('[role="radiogroup"]')
  const describedBy = group?.getAttribute('aria-describedby')
  assert.ok(describedBy, 'the depth group points at its explanation')
  // getElementById, not a `#id` selector: React's useId values contain colons,
  // which are legal in an id but not in a CSS selector.
  assert.match(
    dom.window.document.getElementById(describedBy)?.textContent ?? '',
    /Adds notes on the lines worth pausing on/,
    'and that description is the same line on screen',
  )
  console.log('ok - the prepare banner offers three plain depths with the selected one explained')

  // Pressing a segment changes the value the door threads into the start IPC, and
  // writes it through to settings — no separate save, no settings tab.
  await act(async () => {
    first.segment('Deep').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.equal(first.current().depth, 'thorough', 'the pressed segment is what the door now passes as depth')
  assert.equal(depthInStore(), 'thorough', 'and the choice is remembered the moment it is made')
  assert.match(container.textContent ?? '', /links to project knowledge/, 'the one-liner follows the selection')
  console.log('ok - pressing a depth segment changes what the door hands the guide, and is remembered')

  // Close the door and reopen it: the choice survives, because it never lived in
  // the component that just unmounted.
  await act(async () => first.root.unmount())
  runtime = null
  const second = await openDoor()
  assert.equal(second.segment('Deep').getAttribute('aria-checked'), 'true', 'reopening the door comes back on Deep')
  assert.equal(second.current().depth, 'thorough', 'so the next review starts at the depth the reviewer last used')
  await act(async () => second.root.unmount())
  console.log('ok - the depth choice survives closing and reopening the Reviews door')

  // MC-1804 — the stop path, end to end from the banner. A working guide offers
  // the terminal it is working in AND the way to end it; pressing Stop reaches
  // `review:stop-brief-run` with this review's target, which is what records the
  // honest "You stopped the guide." instead of the watchdog's misleading line.
  const stopCalls: Array<{ workspaceId: string; workspaceRoot: string }> = []
  ;(dom.window as unknown as { api: Record<string, unknown> }).api = {
    reviewStopBriefRun: async (target: { workspaceId: string; workspaceRoot: string }) => {
      stopCalls.push(target)
    },
  }

  const workingSession = {
    reviewId: 'rv_1',
    workspaceRoot: '/proj/multicode',
    run: { running: true, phase: 'grouping', error: null },
    startRun: () => {},
  } as unknown as ReviewSession
  // The running branch renders no preparation choices, so it reads nothing off the
  // runtime — the stub proves that rather than merely satisfying the type.
  const noRuntime = {} as unknown as ReviewGuideRuntime
  const liveTerminal = {
    terminal: { workspaceId: 'ws-1', agentId: 'review-guide-rv_1' },
    open: async () => {},
  } as unknown as GuideTerminalLink

  async function mountWorking(terminalLink: GuideTerminalLink) {
    const root = createRoot(container)
    await act(async () =>
      root.render(<ReviewGuideActions session={workingSession} runtime={noRuntime} terminal={terminalLink} />),
    )
    const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[]
    return { root, buttons, labels: () => buttons().map((node) => node.textContent?.trim()) }
  }

  const working = await mountWorking(liveTerminal)
  assert.deepEqual(
    working.labels(),
    ['Open the guide’s terminal', 'Stop'],
    'a working guide offers its terminal and the way to end it — Stop trailing, because it ends the row',
  )
  const stopButton = working.buttons()[1]
  await act(async () => {
    stopButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(
    stopCalls,
    [{ workspaceId: 'rv_1', workspaceRoot: '/proj/multicode' }],
    'Stop reaches the purpose-built stop IPC with this review’s target',
  )
  // The run ends on the main process's own event, never on the click: the banner
  // still reads as running until that event lands.
  assert.match(container.textContent ?? '', /Stop/, 'the control does not fake the run ending')
  await act(async () => working.root.unmount())
  console.log('ok - a working guide is stoppable, and the stop reaches review:stop-brief-run')

  // A run seeded from the main process on remount carries no terminal coordinates.
  // The whole action block used to render as nothing there — a working guide with
  // no exit at all. Stop stands alone.
  const noTerminal = await mountWorking({ terminal: null, open: async () => {} } as unknown as GuideTerminalLink)
  assert.deepEqual(noTerminal.labels(), ['Stop'], 'no terminal to open still leaves a way out')
  await act(async () => noTerminal.root.unmount())
  console.log('ok - a working guide with no terminal link is still stoppable')

  console.log('all review guide preparation tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
