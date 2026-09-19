import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('surfaceBarLift', async () => {
  // The door bar must ride the app's ONE top strip. This is the regression this
  // suite exists for: while the slot context was declared inside GlobalSurfaceShell
  // (rather than in its own leaf module, the way the rail's ContextRailSlotContext
  // always was), the host provided one context object and the doors — reached
  // through their own lazy import chains — consumed another. Every door silently
  // fell back to its inline bar, and the app showed two stacked title bars: an
  // empty workspace strip above, the door's own bar below.
  //
  // So the assertions here are about PLACEMENT, not markup: the title lands inside
  // the element the host offered, and the door's own region renders no bar row of
  // its own. The host imports the context from `surfaceBarSlot` (as WorkspaceManager
  // does) while the shell is imported normally — if those two ever drift apart
  // again, the first assertion fails.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    dom.window.setTimeout(() => cb(Date.now()), 0) as unknown as number
  anyGlobal.cancelAnimationFrame = (id: number): void => dom.window.clearTimeout(id)
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  async function main(): Promise<void> {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { GlobalSurfaceShell } = await import('./GlobalSurfaceShell')
    // The HOST's import path, deliberately — WorkspaceManager provides the context
    // from this module, and the shell consumes it from the same one.
    const { GlobalSurfaceBarSlotContext } = await import('./surfaceBarSlot')

    const container = dom.window.document.createElement('div')
    dom.window.document.body.append(container)
    // Stands in for WorkspaceHeader's slot div: the app's one 36px top strip.
    const strip = dom.window.document.createElement('div')
    strip.setAttribute('data-testid', 'top-strip')
    dom.window.document.body.append(strip)

    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(
          GlobalSurfaceBarSlotContext.Provider,
          { value: { el: strip } },
          React.createElement(GlobalSurfaceShell, {
            ariaLabel: 'Backlog',
            bar: { title: 'Backlog', actions: React.createElement('button', { type: 'button' }, 'New item') },
            children: React.createElement('div', { 'data-testid': 'canvas' }, 'rows'),
          }),
        ),
      )
    })

    const section = container.querySelector('section[aria-label="Backlog"]')
    assert.ok(section, 'the door renders its region')
    assert.equal(strip.textContent?.includes('Backlog'), true, 'the door name rides the app top strip')
    assert.equal(strip.textContent?.includes('New item'), true, 'the door actions ride the strip beside it')
    assert.equal(
      section?.querySelector('h2'),
      null,
      'the door renders NO bar row of its own — a second title bar under the first is the bug',
    )
    console.log('ok - a door bar lifts into the host strip and leaves no second bar behind')

    // No host (tests, storybook): the shell keeps its own strip-height bar, so a
    // door is never nameless.
    const soloContainer = dom.window.document.createElement('div')
    dom.window.document.body.append(soloContainer)
    const soloRoot = createRoot(soloContainer)
    await act(async () => {
      soloRoot.render(
        React.createElement(GlobalSurfaceShell, {
          ariaLabel: 'Backlog',
          bar: { title: 'Backlog' },
          children: React.createElement('div', null, 'rows'),
        }),
      )
    })
    assert.equal(
      soloContainer.querySelector('h2')?.textContent,
      'Backlog',
      'with no host slot the bar falls back inline rather than vanishing',
    )
    console.log('ok - with no host in scope the bar falls back inline')

    console.log('global surface bar-lift tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
