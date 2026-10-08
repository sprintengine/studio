import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, test } from 'vitest'

import type { TooltipChildProps } from './Tooltip'

// A tooltip has to be gone once the thing it describes has been used. These
// cover the ways it used to outlive a click: the press itself, the app losing
// focus to the browser the click opened, focus handed back to the clicked
// control when the app is activated again, and the pointer entering a menu the
// trigger portals out.

type Harness = {
  dom: JSDOM
  render: (trigger: React.ReactElement<TooltipChildProps>) => Promise<HTMLElement>
  tooltip: () => Element | null
  act: (fn: () => void) => void
  cleanup: () => void
}

let harness: Harness

beforeEach(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Element = dom.window.Element
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { Tooltip } = await import('./Tooltip')

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const act = (fn: () => void) => React.act(fn)

  harness = {
    dom,
    act,
    tooltip: () => dom.window.document.querySelector('[role="tooltip"]'),
    render: async (trigger) => {
      act(() => {
        root.render(
          React.createElement(Tooltip, { content: 'Pull request #12 · open', openDelayMs: 0, children: trigger }),
        )
      })
      const element = container.querySelector<HTMLElement>('[data-trigger]')
      assert.ok(element, 'the trigger is rendered')
      return element
    },
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
})

afterEach(() => harness.cleanup())

const button = async (): Promise<React.ReactElement<TooltipChildProps>> => {
  const React = await import('react')
  return React.createElement(
    'button',
    { type: 'button', 'data-trigger': '' },
    '#12',
  ) as React.ReactElement<TooltipChildProps>
}

// React synthesises enter and leave from native mouseover/mouseout.
const hover = (target: Element, from: Element) =>
  harness.act(() => {
    target.dispatchEvent(new harness.dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
  })

// Lets the hover delay run out. A loaded test machine can be slow to fire even
// a zero delay, so a wait for the tooltip to appear polls rather than guessing.
const dwell = async (ms = 50) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
  harness.act(() => {})
}

const opened = async (): Promise<Element | null> => {
  for (let waited = 0; waited < 2000 && !harness.tooltip(); waited += 20) await dwell(20)
  return harness.tooltip()
}

test('pressing the trigger dismisses its tooltip, and resting on it does not bring it back', async () => {
  const trigger = await harness.render(await button())
  hover(trigger, harness.dom.window.document.body)
  assert.ok(await opened(), 'hovering opens it')

  harness.act(() => {
    trigger.dispatchEvent(new harness.dom.window.PointerEvent('pointerdown', { bubbles: true }))
  })
  assert.ok(harness.tooltip() === null, 'the press dismisses it')
  await dwell()
  assert.ok(harness.tooltip() === null, 'and nothing reopens it while the pointer stays put')
})

test('the app losing focus dismisses an open tooltip', async () => {
  const trigger = await harness.render(await button())
  hover(trigger, harness.dom.window.document.body)
  assert.ok(await opened(), 'hovering opens it')

  harness.act(() => {
    harness.dom.window.dispatchEvent(new harness.dom.window.Event('blur'))
  })
  assert.ok(harness.tooltip() === null, 'opening the browser takes the focus, and the tooltip goes with it')
})

test('focus opens it only when focus is visible, so a click or a window activation does not', async () => {
  const trigger = await harness.render(await button())
  // A click's focus is not `:focus-visible`; the test DOM has no notion of how
  // focus arrived, so the trigger is told to answer as a clicked control would.
  const matches = trigger.matches.bind(trigger)
  Object.defineProperty(trigger, 'matches', {
    configurable: true,
    value: (selector: string) => (selector === ':focus-visible' ? false : matches(selector)),
  })
  harness.act(() => trigger.focus())
  assert.ok(harness.tooltip() === null, 'focus a click or the window gave back draws nothing')
  harness.act(() => trigger.blur())
  delete (trigger as { matches?: unknown }).matches

  harness.act(() => {
    harness.dom.window.document.body.dispatchEvent(
      new harness.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    )
    trigger.focus()
  })
  assert.ok(harness.tooltip(), 'keyboard focus still opens it at once')
})

test('focus handed back to a control the pointer last steered does not open it', async () => {
  const trigger = await harness.render(await button())
  const root = harness.dom.window.document.documentElement
  // Settings, opened with a click on the gear, closes on Escape and gives the
  // gear its focus back. The browser calls that focus visible (the last input
  // was a key), but the pointer was the last thing to move focus, so no ring
  // is drawn and nobody asked what the gear is.
  root.dataset.focusSource = 'pointer'
  harness.act(() => trigger.focus())
  assert.ok(harness.tooltip() === null, 'a focus restored by a dismissed surface draws nothing')
  harness.act(() => trigger.blur())

  root.dataset.focusSource = 'keyboard'
  harness.act(() => trigger.focus())
  assert.ok(harness.tooltip(), 'focus the keyboard moved still opens it')
  delete root.dataset.focusSource
})

test('a menu the trigger portals out does not count as the trigger', async () => {
  const React = await import('react')
  const { createPortal } = await import('react-dom')
  const menuHost = harness.dom.window.document.createElement('div')
  harness.dom.window.document.body.appendChild(menuHost)
  const trigger = await harness.render(
    React.createElement(
      'span',
      { 'data-trigger': '' },
      React.createElement('button', { type: 'button' }, '#12'),
      createPortal(React.createElement('div', { role: 'menuitem' }, '#11 · merged'), menuHost),
    ) as React.ReactElement<TooltipChildProps>,
  )
  const row = menuHost.querySelector('[role="menuitem"]')
  assert.ok(row)

  hover(row, harness.dom.window.document.body)
  await dwell()
  assert.ok(harness.tooltip() === null, "a row of the trigger's menu does not summon the trigger's tooltip")

  hover(trigger, harness.dom.window.document.body)
  assert.ok(await opened(), 'the trigger itself still does')
})
