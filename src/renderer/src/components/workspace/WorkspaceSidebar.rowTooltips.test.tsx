import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// One hover surface per row (owner, 2026-09-09). A row that opens the
// conversation peek stops opening tooltips on its own readings — the card is
// already saying how much changed and how long it has been idle, and the
// tooltip was landing on top of it. A row with no card keeps every one of them.

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
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { RowTooltip, RowTooltipsSuppressed } = await import('./WorkspaceSidebar')

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  // Focus opens the kit's tooltip with no dwell (Tooltip's own handleFocus), so
  // the test never waits on a timer to find out.
  const openByFocus = (suppressed: boolean): Element | null => {
    act(() => {
      root.render(
        React.createElement(
          RowTooltipsSuppressed.Provider,
          { value: suppressed },
          React.createElement(
            RowTooltip,
            { content: '12 files updated — changed by this terminal' },
            React.createElement('button', { type: 'button' }, '+12'),
          ),
        ),
      )
    })
    const trigger = container.querySelector('button')
    assert.ok(trigger, 'the reading itself is rendered either way')
    act(() => {
      trigger.focus()
    })
    return dom.window.document.querySelector('[role="tooltip"]')
  }

  try {
    const withoutCard = openByFocus(false)
    assert.ok(withoutCard, 'a row with no conversation peek still opens its tooltips')
    assert.ok(
      (withoutCard?.textContent ?? '').includes('12 files updated'),
      'and it is the row’s own words',
    )

    const withCard = openByFocus(true)
    assert.equal(withCard, null, 'a row whose card is the hover surface opens no tooltip over it')

    // The reading must not move when its tooltip goes: the suppressed path
    // renders the same wrapper the kit does.
    assert.ok(
      container.querySelector('span.relative'),
      'the trigger keeps the wrapper it had, so nothing shifts',
    )
  } finally {
    act(() => {
      root.unmount()
    })
  }
}

main()
  .then(() => console.log('workspace sidebar row tooltip tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
