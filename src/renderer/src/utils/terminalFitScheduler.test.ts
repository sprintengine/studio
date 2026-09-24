import assert from 'node:assert/strict'
import {
  createTerminalFitScheduler,
  RESIZE_FIT_THROTTLE_MS,
  WORKSPACE_LAYER_REVEAL_EVENT,
} from './terminalFitScheduler'
import {
  __resetLayoutTransitionsForTests,
  beginInteractiveLayoutResize,
  LAYOUT_TRANSITION_MAX_HOLD_MS,
} from './layoutTransition'
import { test } from 'vitest'

test('terminalFitScheduler', async () => {
  type Handler = (event?: unknown) => void

  const eventHandlers = new Map<string, Set<Handler>>()
  const documentHandlers = new Map<string, Set<Handler>>()
  const timers: Array<{ id: number; fn: () => void }> = []
  let nextTimerId = 1
  let fakeNow = 0

  void main()

  function main(): void {
    installFakeWindow()
    assertFitRunsWhenVisibleAndIdle()
    assertHiddenContainerParksFitUntilReveal()
    assertRevealWithoutPendingFitDoesNothing()
    assertWindowResizeThrottlesFitsAndSettles()
    assertLayoutTransitionDefersFitUntilItLands()
    assertUnrelatedOrNonLayoutTransitionDoesNotDefer()
    assertTransitionThatNeverLandsReleasesAfterMaxHold()
    assertColumnDragThrottlesAndFitsOnceAtTheEnd()
    assertDisposeDropsListeners()
    console.log('terminalFitScheduler tests passed')
  }

  function assertFitRunsWhenVisibleAndIdle(): void {
    const fits: number[] = []
    const scheduler = createTerminalFitScheduler(() => fits.push(1), visibleContainer())

    scheduler.requestFit()

    assert.equal(fits.length, 1)
    scheduler.dispose()
  }

  function assertHiddenContainerParksFitUntilReveal(): void {
    const fits: number[] = []
    let visible = false
    const scheduler = createTerminalFitScheduler(
      () => fits.push(1),
      container(() => visible),
    )

    scheduler.requestFit()
    scheduler.requestFit()
    assert.equal(fits.length, 0)

    visible = true
    dispatchEvent(WORKSPACE_LAYER_REVEAL_EVENT)
    assert.equal(fits.length, 1)
    scheduler.dispose()
  }

  function assertRevealWithoutPendingFitDoesNothing(): void {
    const fits: number[] = []
    const scheduler = createTerminalFitScheduler(() => fits.push(1), visibleContainer())

    dispatchEvent(WORKSPACE_LAYER_REVEAL_EVENT)

    assert.equal(fits.length, 0)
    scheduler.dispose()
  }

  function assertWindowResizeThrottlesFitsAndSettles(): void {
    const fits: number[] = []
    const scheduler = createTerminalFitScheduler(() => fits.push(1), visibleContainer())

    fakeNow = RESIZE_FIT_THROTTLE_MS * 10
    dispatchEvent('resize')
    scheduler.requestFit()
    assert.equal(fits.length, 1)

    fakeNow += RESIZE_FIT_THROTTLE_MS / 2
    dispatchEvent('resize')
    scheduler.requestFit()
    scheduler.requestFit()
    assert.equal(fits.length, 1)

    fakeNow += RESIZE_FIT_THROTTLE_MS
    scheduler.requestFit()
    assert.equal(fits.length, 2)

    fakeNow += RESIZE_FIT_THROTTLE_MS / 4
    scheduler.requestFit()
    assert.equal(fits.length, 2)

    flushTimers()
    assert.equal(fits.length, 3)
    scheduler.dispose()
  }

  // The sidebar's width glide runs on the aside, a sibling of the column the
  // terminal sits in. Every frame of it resizes the terminal; the fit waits for
  // `transitionend` and runs once, so the CLI redraws once.
  function assertLayoutTransitionDefersFitUntilItLands(): void {
    __resetLayoutTransitionsForTests()
    const fits: number[] = []
    const terminal = visibleContainer()
    const row = element([terminal])
    const sidebar = element([], row)
    const scheduler = createTerminalFitScheduler(() => fits.push(1), terminal)

    dispatchDocumentEvent('transitionrun', { target: sidebar, propertyName: 'width' })
    scheduler.requestFit()
    scheduler.requestFit()
    scheduler.requestFit()
    assert.equal(fits.length, 0, 'no fit while the glide is running')

    dispatchDocumentEvent('transitionend', { target: sidebar, propertyName: 'width' })
    assert.equal(fits.length, 1, 'one fit when it lands')

    // A transition on an ancestor holds it the same way, and a cancel lands it.
    const footer = element([terminal])
    dispatchDocumentEvent('transitionrun', { target: footer, propertyName: 'grid-template-rows' })
    scheduler.requestFit()
    assert.equal(fits.length, 1)
    dispatchDocumentEvent('transitioncancel', { target: footer, propertyName: 'grid-template-rows' })
    assert.equal(fits.length, 2)
    scheduler.dispose()
  }

  function assertUnrelatedOrNonLayoutTransitionDoesNotDefer(): void {
    __resetLayoutTransitionsForTests()
    const fits: number[] = []
    const terminal = visibleContainer()
    const elsewhere = element([], element([]))
    const ancestor = element([terminal])
    const scheduler = createTerminalFitScheduler(() => fits.push(1), terminal)

    dispatchDocumentEvent('transitionrun', { target: elsewhere, propertyName: 'width' })
    dispatchDocumentEvent('transitionrun', { target: ancestor, propertyName: 'opacity' })
    scheduler.requestFit()
    assert.equal(fits.length, 1, 'a glide in another column and a fade do not hold the fit')
    scheduler.dispose()
  }

  function assertTransitionThatNeverLandsReleasesAfterMaxHold(): void {
    __resetLayoutTransitionsForTests()
    const fits: number[] = []
    const terminal = visibleContainer()
    const ancestor = element([terminal])
    const scheduler = createTerminalFitScheduler(() => fits.push(1), terminal)

    dispatchDocumentEvent('transitionrun', { target: ancestor, propertyName: 'width' })
    scheduler.requestFit()
    assert.equal(fits.length, 0)

    fakeNow += LAYOUT_TRANSITION_MAX_HOLD_MS + 1
    flushTimers()
    assert.equal(fits.length, 1, 'a detached element whose end never fires cannot hold fits forever')
    scheduler.dispose()
  }

  function assertColumnDragThrottlesAndFitsOnceAtTheEnd(): void {
    __resetLayoutTransitionsForTests()
    const fits: number[] = []
    const scheduler = createTerminalFitScheduler(() => fits.push(1), visibleContainer())

    fakeNow += RESIZE_FIT_THROTTLE_MS * 10
    const endDrag = beginInteractiveLayoutResize()
    scheduler.requestFit()
    assert.equal(fits.length, 1, 'the first frame of the drag fits')
    scheduler.requestFit()
    scheduler.requestFit()
    assert.equal(fits.length, 1, 'frames inside the throttle window do not')

    endDrag()
    assert.equal(fits.length, 2, 'the drag ending fits once at the final width')
    endDrag()
    assert.equal(fits.length, 2, 'ending twice is one end')
    scheduler.dispose()
  }

  function assertDisposeDropsListeners(): void {
    const fits: number[] = []
    let visible = false
    const scheduler = createTerminalFitScheduler(
      () => fits.push(1),
      container(() => visible),
    )

    scheduler.requestFit()
    scheduler.dispose()
    visible = true
    dispatchEvent(WORKSPACE_LAYER_REVEAL_EVENT)
    scheduler.requestFit()

    assert.equal(fits.length, 0)
  }

  function container(isVisible: () => boolean): HTMLElement {
    return { checkVisibility: () => isVisible(), parentElement: null, contains: () => false } as unknown as HTMLElement
  }

  // A stand-in element: contains itself, its children, and theirs.
  function element(children: object[], parent: object | null = null): HTMLElement {
    const node: {
      parentElement: object | null
      children: object[]
      contains: (other: object) => boolean
    } = {
      parentElement: parent,
      children,
      contains: (other) =>
        other === node ||
        node.children.some(
          (child) => child === other || (child as { contains?: (o: object) => boolean }).contains?.(other),
        ),
    }
    if (parent) (parent as { children: object[] }).children.push(node)
    return node as unknown as HTMLElement
  }

  function dispatchDocumentEvent(type: string, event: { target: object; propertyName: string }): void {
    for (const handler of documentHandlers.get(type) ?? []) handler(event)
  }

  function visibleContainer(): HTMLElement {
    return container(() => true)
  }

  function dispatchEvent(type: string): void {
    for (const handler of eventHandlers.get(type) ?? []) handler()
  }

  function flushTimers(): void {
    while (timers.length > 0) {
      const timer = timers.shift()
      timer?.fn()
    }
  }

  function installFakeWindow(): void {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: (type: string, handler: Handler) => {
          const handlers = documentHandlers.get(type) ?? new Set<Handler>()
          handlers.add(handler)
          documentHandlers.set(type, handlers)
        },
      },
    })
    globalThis.window = {
      addEventListener: (type: string, handler: Handler) => {
        const handlers = eventHandlers.get(type) ?? new Set<Handler>()
        handlers.add(handler)
        eventHandlers.set(type, handlers)
      },
      removeEventListener: (type: string, handler: Handler) => {
        eventHandlers.get(type)?.delete(handler)
      },
      setTimeout: (fn: () => void) => {
        const id = nextTimerId
        nextTimerId += 1
        timers.push({ id, fn })
        return id
      },
      clearTimeout: (id: number) => {
        const index = timers.findIndex((timer) => timer.id === id)
        if (index >= 0) timers.splice(index, 1)
      },
    } as unknown as Window & typeof globalThis
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }) as typeof globalThis.requestAnimationFrame
    Object.defineProperty(globalThis, 'performance', {
      value: { now: () => fakeNow },
      configurable: true,
    })
  }
})
