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
//   2. a disabled item keeps its place in the BAND but not in the WALK, while a
//      SOFT-disabled one (`aria-disabled`, no attribute) keeps both — it has to
//      be focusable and hoverable, or the tooltip that is the only explanation
//      for a glyph-only control can never open;
//   3. an item that opens a menu says so in ARIA, not only with a corner mark;
//   4. the divider is decoration, not a structural separator;
//   5. a MIXED band — one holding a segmented control and an inline pager — is
//      still one tab stop, and the child that owns its own arrow keys keeps
//      them instead of being overruled by the band's walk;
//   6. the remembered tab stop survives a re-render with focus outside the
//      band, which is the whole point of remembering it.

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
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
// The mixed-band checks mount the real SegmentedControl, which reaches for a
// Tooltip; these are what that needs from a browser and nothing more.
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

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
  const { SegmentedControl } = await import('./SegmentedControl')
  const { Pager } = await import('./Pager')
  const { Tooltip } = await import('./Tooltip')

  const document = dom.window.document
  const glyph = <svg viewBox="0 0 16 16" aria-hidden="true" />

  function mount(node: React.ReactNode): {
    band: HTMLElement
    container: HTMLElement
    rerender: (next: React.ReactNode) => void
    unmount: () => void
  } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      band: container.firstElementChild as HTMLElement,
      container: container as unknown as HTMLElement,
      rerender: (next: React.ReactNode) => {
        act(() => {
          root.render(next)
        })
      },
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

  run('an item IS the kit\'s icon button, at the 26px step', () => {
    // The band composes rather than restyles: an item that hovered differently
    // from a button would be a second button.
    const view = mount(band())
    const classes = view.band.querySelector('button')?.getAttribute('class') ?? ''
    assert.match(classes, /size-control-xs/, 'IconButton size sm — the 26px square')
    assert.match(classes, /interactive/, 'and the button family\'s own press behaviour')
    assert.match(classes, /focus-visible:focus-ring/, 'and the one shared focus treatment')
    view.unmount()
  })

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

  run('a soft-disabled item stays in the walk, so its tooltip can explain it', () => {
    let pressed = 0
    const view = mount(
      <Toolbar ariaLabel="Changed files">
        <ToolbarButton ariaLabel="Refresh">{glyph}</ToolbarButton>
        <ToolbarButton
          ariaLabel="Write commit message"
          ariaDisabled
          disabledReason="coming with the composer"
          onClick={() => {
            pressed += 1
          }}
        >
          {glyph}
        </ToolbarButton>
        <ToolbarButton ariaLabel="Collapse all">{glyph}</ToolbarButton>
      </Toolbar>,
    )
    const items = Array.from(view.band.querySelectorAll('button')) as HTMLElement[]
    const soft = items[1]

    assert.equal(soft.getAttribute('aria-disabled'), 'true', 'it says it is unavailable')
    assert.equal(soft.hasAttribute('disabled'), false, 'without the attribute that makes it inert')
    assert.equal(
      soft.getAttribute('aria-label'),
      'Write commit message — coming with the composer',
      'the reason rides the name, for a reader who never sees a tooltip',
    )

    act(() => {
      items[0].focus()
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    })
    assert.equal(
      (document.activeElement as HTMLElement).getAttribute('aria-disabled'),
      'true',
      'the walk lands ON it — a tooltip on a control the keyboard cannot reach explains nothing',
    )

    act(() => {
      soft.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(pressed, 0, 'and pressing it does nothing, which is what unavailable means')
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
    assert.match(classes, /(^| )relative( |$)/, 'and it has a positioning context to be drawn in')
    assert.ok(!/rotate|chevron/.test(classes), 'not a chevron beside the glyph — it would push the glyph off centre')
    view.unmount()
  })

  run('the divider is decoration, and the spacer is not a third cluster', () => {
    // The REAL band shape: every item in the product's bands is Tooltip-wrapped,
    // because the words ride the tooltip in a glyph-only band. That wrapper is a
    // `<span>`, and it is emphatically NOT `aria-hidden` — hiding it would hide
    // the control inside it. So the invariant is not "every span in the band is
    // hidden" (which the old fixture could only satisfy by having no tooltips in
    // it, i.e. by not being a band); it is that the CHROME — the divider and the
    // spacer, the two spans that wrap no control — is hidden and roleless.
    const view = mount(
      <Toolbar ariaLabel="Changed files">
        <Tooltip content="Refresh the working tree" placement="bottom">
          <ToolbarButton ariaLabel="Refresh">{glyph}</ToolbarButton>
        </Tooltip>
        <ToolbarDivider />
        <Tooltip content="Collapse all groups" placement="bottom">
          <ToolbarButton ariaLabel="Collapse all">{glyph}</ToolbarButton>
        </Tooltip>
        <ToolbarSpacer />
      </Toolbar>,
    )
    const spans = Array.from(view.band.querySelectorAll('span'))
    const chrome = spans.filter((span) => span.querySelector('button') === null && !span.closest('button'))
    const wrappers = spans.filter((span) => span.querySelector('button') !== null)

    assert.equal(chrome.length, 2, 'exactly two decorative spans: the divider and the spacer')
    for (const span of chrome) {
      assert.equal(span.getAttribute('aria-hidden'), 'true', 'neither is announced: the band is one flat toolbar')
      assert.equal(span.getAttribute('role'), null, 'never role="separator" — it separates nothing structurally')
    }
    assert.equal(wrappers.length, 2, 'and both items are wrapped, as every real band wraps them')
    for (const span of wrappers) {
      assert.equal(
        span.getAttribute('aria-hidden'),
        null,
        'a tooltip wrapper is not chrome — hiding it would hide the control inside it',
      )
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

  // --- The mixed band -------------------------------------------------------
  // The band promises ONE tab stop. A segmented control and an inline pager are
  // each a composite with its own focus rules, and dropped into the band
  // unchanged they broke the promise from both ends: they stood up tab stops of
  // their own, and their arrow keys bubbled to a walk that could not see where
  // focus was, so `move(null, 1)` teleported it to item one.

  function mixedBand(view: 'a' | 'b' = 'a'): React.ReactElement {
    return (
      <Toolbar ariaLabel="Diff">
        <ToolbarButton ariaLabel="Previous difference">{glyph}</ToolbarButton>
        <SegmentedControl
          ariaLabel="Diff view"
          value={view}
          onChange={() => {}}
          iconOnly
          items={[
            { value: 'a', label: 'Side by side', icon: glyph },
            { value: 'b', label: 'Unified', icon: glyph },
          ]}
        />
        <Pager inline page={2} pageCount={27} rangeLabel="File 2 of 27" ariaLabel="Files" onPageChange={() => {}} />
        <ToolbarButton ariaLabel="Open in editor">{glyph}</ToolbarButton>
      </Toolbar>
    )
  }

  run('a mixed band is still ONE tab stop', () => {
    const view = mount(mixedBand())
    const focusable = Array.from(view.band.querySelectorAll('button')) as HTMLElement[]
    assert.equal(focusable.length, 6, 'two items, two segments, two chevrons')
    const stops = focusable.filter((item) => item.tabIndex === 0)
    assert.equal(
      stops.length,
      1,
      'a radiogroup and a stepper that kept their own tab stops would make the band three',
    )
    assert.equal(stops[0]?.getAttribute('aria-label'), 'Previous difference', 'and it is the first item')

    // Both composites hang off the band's own hook rather than being skipped.
    const walked = Array.from(view.band.querySelectorAll('[data-toolbar-item]')).map((item) =>
      item.getAttribute('aria-label'),
    )
    assert.deepEqual(
      walked,
      ['Previous difference', 'Side by side', 'Previous', 'Next', 'Open in editor'],
      'the SELECTED segment and both chevrons join the walk; the unselected segment is the radiogroup\'s own business',
    )
    view.unmount()
  })

  run('the band walks its own items and steps into the composites', () => {
    const view = mount(mixedBand())
    const items = Array.from(view.band.querySelectorAll('[data-toolbar-item]')) as HTMLElement[]
    const press = (key: string): void => {
      act(() => {
        ;(document.activeElement as HTMLElement).dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
        )
      })
    }
    act(() => {
      items[0].focus()
    })
    press('ArrowRight')
    assert.equal(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
      'Side by side',
      'the walk reaches the segmented control rather than jumping over it',
    )
    press('End')
    assert.equal(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
      'Open in editor',
      'and Home/End still reach the ends from inside a radiogroup — it claims neither key',
    )
    press('ArrowLeft')
    assert.equal(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
      'Next',
      'the stepper\'s chevrons are ordinary items in the walk',
    )
    view.unmount()
  })

  run('a child that owns its arrow keys keeps them', () => {
    let selected = 'a'
    const view = mount(
      <Toolbar ariaLabel="Diff">
        <ToolbarButton ariaLabel="Previous difference">{glyph}</ToolbarButton>
        <SegmentedControl
          ariaLabel="Diff view"
          value="a"
          onChange={(next) => {
            selected = next
          }}
          iconOnly
          items={[
            { value: 'a', label: 'Side by side', icon: glyph },
            { value: 'b', label: 'Unified', icon: glyph },
          ]}
        />
        <ToolbarButton ariaLabel="Open in editor">{glyph}</ToolbarButton>
      </Toolbar>,
    )
    const segment = view.band.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement
    act(() => {
      segment.focus()
      segment.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    assert.equal(selected, 'b', 'the radiogroup moved its own selection')
    assert.notEqual(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
      'Previous difference',
      'and the band did not ALSO answer the key by teleporting focus to item one',
    )

    // The same for a text field, which the band's own docs forbid but which the
    // guard has to survive: its caret keys are its own, Home and End included.
    const withInput = mount(
      <Toolbar ariaLabel="Filter">
        <ToolbarButton ariaLabel="Refresh">{glyph}</ToolbarButton>
        <input aria-label="Filter files" defaultValue="src" />
        <ToolbarButton ariaLabel="Collapse all">{glyph}</ToolbarButton>
      </Toolbar>,
    )
    const field = withInput.band.querySelector('input') as HTMLElement
    act(() => {
      field.focus()
      for (const key of ['ArrowRight', 'Home', 'End']) {
        field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
      }
    })
    assert.equal(document.activeElement, field, 'the caret keys never left the field')

    view.unmount()
    withInput.unmount()
  })

  run('the remembered tab stop survives a re-render with focus outside the band', () => {
    // The bug this pins: the stop used to be re-derived from
    // `document.activeElement` on every render. Focus leaves the band, the
    // region's state moves, and the person Tabs back in — to item one, not to
    // where they were.
    const outside = document.createElement('button')
    document.body.appendChild(outside)

    const view = mount(band())
    const items = Array.from(view.band.querySelectorAll('button')) as HTMLElement[]
    act(() => {
      items[2].focus()
    })
    assert.deepEqual(items.map((item) => item.tabIndex), [-1, -1, 0])

    act(() => {
      outside.focus()
    })
    view.rerender(band())
    const after = Array.from(view.band.querySelectorAll('button')) as HTMLElement[]
    assert.deepEqual(
      after.map((item) => item.tabIndex),
      [-1, -1, 0],
      'Tab comes back to where the person was, not to item one',
    )

    // And it gives way when the remembered item leaves the walk: a disabled
    // item is not a tab stop, so the band falls through to the first.
    view.rerender(
      <Toolbar ariaLabel="Changed files">
        <ToolbarButton ariaLabel="Refresh">{glyph}</ToolbarButton>
        <ToolbarButton ariaLabel="Discard changes">{glyph}</ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton ariaLabel="Collapse all" disabled>
          {glyph}
        </ToolbarButton>
      </Toolbar>,
    )
    const disabled = Array.from(view.band.querySelectorAll('button')) as HTMLElement[]
    assert.deepEqual(
      disabled.map((item) => item.tabIndex),
      [0, -1, -1],
      'a remembered stop that is no longer walkable falls through to the first item',
    )

    view.unmount()
    outside.remove()
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
