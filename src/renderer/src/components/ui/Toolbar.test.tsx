import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Toolbar — the region's own glyph band (design-system/components/toolbar).
//
// The assertions are aimed at the promise `role="toolbar"` makes and at the two
// marks the band adds to the button family:
//
//   1. ONE tab stop, with arrow keys walking the items — nine separate tab
//      stops between the pane's tabs and the first file is the cost the role
//      exists to remove;
//   2. a disabled item keeps its place in the BAND but not in the WALK;
//   3. an item that opens a menu says so in ARIA, not only with a corner mark;
//   4. the divider is decoration, not a structural separator.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { Toolbar, ToolbarButton, ToolbarDivider, ToolbarSpacer } = await import('./Toolbar')

  const document = dom.window.document
  const glyph = <svg viewBox="0 0 16 16" aria-hidden="true" />

  function mount(node: React.ReactNode): { band: HTMLElement; container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      band: container.firstElementChild as HTMLElement,
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  function band(extra?: React.ReactNode): React.ReactElement {
    return (
      <Toolbar ariaLabel="Changed files">
        <ToolbarButton ariaLabel="Refresh">{glyph}</ToolbarButton>
        <ToolbarButton ariaLabel="Discard changes">{glyph}</ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton ariaLabel="Collapse all">{glyph}</ToolbarButton>
        {extra}
      </Toolbar>
    )
  }

  run('the band names the region it acts on, not itself', () => {
    const view = mount(band())
    assert.equal(view.band.getAttribute('role'), 'toolbar')
    assert.equal(
      view.band.getAttribute('aria-label'),
      'Changed files',
      'a window with three toolbars must not present three identical landmarks',
    )
    view.unmount()
  })

  run('exactly one item is in the tab order, and arrow keys walk the rest', () => {
    const view = mount(band())
    const items = Array.from(view.band.querySelectorAll('button'))
    assert.equal(items.length, 3)
    assert.deepEqual(
      items.map((item) => item.tabIndex),
      [0, -1, -1],
      'one tab stop: Tab reaches the band, arrows walk inside it',
    )

    const press = (key: string): void => {
      act(() => {
        // From the focused item, which is where a real key event starts.
        ;(document.activeElement as HTMLElement).dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
        )
      })
    }
    const focusedLabel = (): string | null =>
      (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null

    act(() => {
      items[0].focus()
    })
    press('ArrowRight')
    assert.equal(focusedLabel(), 'Discard changes', 'ArrowRight moves to the next item')
    press('End')
    assert.equal(focusedLabel(), 'Collapse all', 'End jumps to the far end')
    press('ArrowRight')
    assert.equal(focusedLabel(), 'Refresh', 'and the walk wraps')
    press('Home')
    assert.equal(focusedLabel(), 'Refresh', 'Home is the other end')
    press('ArrowLeft')
    assert.equal(focusedLabel(), 'Collapse all', 'and ArrowLeft wraps the other way')
    view.unmount()
  })

  run('focus landing on an item makes it the band\'s tab stop', () => {
    const view = mount(band())
    const items = Array.from(view.band.querySelectorAll('button'))
    act(() => {
      items[2].focus()
    })
    assert.deepEqual(
      items.map((item) => item.tabIndex),
      [-1, -1, 0],
      'leaving the band and coming back returns to where the person was',
    )
    view.unmount()
  })

  run('a disabled item keeps its place in the band but not in the walk', () => {
    const view = mount(
      <Toolbar ariaLabel="Changed files">
        <ToolbarButton ariaLabel="Refresh">{glyph}</ToolbarButton>
        <ToolbarButton ariaLabel="Discard changes" disabled>
          {glyph}
        </ToolbarButton>
        <ToolbarButton ariaLabel="Collapse all">{glyph}</ToolbarButton>
      </Toolbar>,
    )
    const items = Array.from(view.band.querySelectorAll('button'))
    assert.equal(items.length, 3, 'which actions EXIST is information even when one is unavailable')
    act(() => {
      items[0].focus()
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    })
    assert.equal(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
      'Collapse all',
      'the walk steps over the disabled item',
    )
    view.unmount()
  })

  run('an item that opens a menu says so in ARIA, not only with a corner mark', () => {
    const view = mount(
      <Toolbar ariaLabel="Changed files">
        <ToolbarButton ariaLabel="Show diff" menu>
          {glyph}
        </ToolbarButton>
      </Toolbar>,
    )
    const item = view.band.querySelector('button') as HTMLElement
    assert.equal(item.getAttribute('aria-haspopup'), 'menu')
    assert.equal(item.getAttribute('aria-expanded'), 'false')
    const classes = item.getAttribute('class') ?? ''
    assert.match(classes, /after:border-r-current/, 'the corner mark is drawn, and it is decoration')
    assert.ok(!/rotate|chevron/.test(classes), 'not a chevron beside the glyph — it would push the glyph off centre')
    view.unmount()
  })

  run('the divider is decoration, and the spacer is not a third cluster', () => {
    const view = mount(band(<ToolbarSpacer />))
    const spans = Array.from(view.band.querySelectorAll('span'))
    assert.ok(spans.length >= 2)
    for (const span of spans) {
      assert.equal(span.getAttribute('aria-hidden'), 'true', 'neither is announced: the band is one flat toolbar')
      assert.equal(span.getAttribute('role'), null, 'never role="separator" — it separates nothing structurally')
    }
    assert.ok(
      !/justify-between/.test(view.band.getAttribute('class') ?? ''),
      'a trailing cluster comes from the spacer, not from spreading the band',
    )
    view.unmount()
  })

  run('the band draws one hairline, and --borderless drops it', () => {
    const withRule = mount(band())
    assert.match(withRule.band.getAttribute('class') ?? '', /border-b border-\[color:var\(--border-subtle\)\]/)
    assert.ok(
      !/bg-\[color:/.test(withRule.band.getAttribute('class') ?? ''),
      'no ground: a band that painted one would read as a second surface on the pane',
    )

    const bare = mount(
      <Toolbar ariaLabel="Diff" borderless>
        <ToolbarButton ariaLabel="Next difference">{glyph}</ToolbarButton>
      </Toolbar>,
    )
    assert.ok(!/border-b/.test(bare.band.getAttribute('class') ?? ''), 'two rules 30px apart is a ladder')

    withRule.unmount()
    bare.unmount()
  })

  if (failures > 0) {
    console.error(`\nToolbar.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('Toolbar: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
