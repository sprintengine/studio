import assert from 'node:assert/strict'
import {
  createTerminalFitScheduler,
  RESIZE_FIT_THROTTLE_MS,
  WORKSPACE_LAYER_REVEAL_EVENT,
} from './terminalFitScheduler'
import { beginSidebarTransition } from './sidebarTransition'
import { test } from 'vitest'

test('terminalFitScheduler', async () => {
  type Handler = (event?: unknown) => void

  const eventHandlers = new Map<string, Set<Handler>>()
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
    assertSidebarAnimationDefersFitUntilLanding()
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

  function assertSidebarAnimationDefersFitUntilLanding(): void {
    const fits: number[] = []
    const scheduler = createTerminalFitScheduler(() => fits.push(1), visibleContainer())

    beginSidebarTransition()
    scheduler.requestFit()
    scheduler.requestFit()
    assert.equal(fits.length, 0)

    flushTimers()
    assert.equal(fits.length, 1)
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
    return { checkVisibility: () => isVisible() } as unknown as HTMLElement
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
