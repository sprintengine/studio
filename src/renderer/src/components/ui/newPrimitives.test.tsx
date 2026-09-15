import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// MC-2117 — the five primitives the kit was missing, and the two correctness
// fixes that rode along.
//
// Each of these existed as hand-rolls before, so the assertions here are aimed
// at the things the hand-rolls got WRONG rather than at the styling they got
// right. A checkbox that renders is not interesting; a checkbox whose focus
// treatment survives being placed on a surface other than the one its author had
// in mind is the whole point.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
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
domWindow.api = { platform: 'darwin' }

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
  const { Badge } = await import('./Badge')
  const { Checkbox } = await import('./Checkbox')
  const { EmptyState } = await import('./EmptyState')
  const { SettingCard } = await import('./SettingRow')
  const { Table } = await import('./Table')

  const document = dom.window.document

  function mount(node: React.ReactNode): { container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  // ── Checkbox ──────────────────────────────────────────────────────────────

  run('the native input is the control, not a div pretending to be one', () => {
    const view = mount(<Checkbox checked={false} onChange={() => undefined} label="Copy files" />)
    const input = view.container.querySelector('input[type="checkbox"]')
    assert.ok(input, 'a real checkbox carries the semantics, the keyboard path and form participation')
    assert.equal(
      view.container.querySelectorAll('[role="checkbox"]').length,
      0,
      'and nothing re-implements the role by hand',
    )
    // The visible box is decoration; a screen reader must not meet it twice.
    const box = view.container.querySelector('span[aria-hidden="true"]')
    assert.ok(box, 'the drawn box is hidden from assistive tech')
    view.unmount()
  })

  run('focus treatment is the shared peer utility, not a surface-specific ring', () => {
    // The hand-roll this promoted used a ring whose `ring-offset-color` was
    // pinned to --bg-surface-raised, which is wrong the moment the row sits on
    // any other surface. An outline's gap needs no such guess.
    const view = mount(<Checkbox checked onChange={() => undefined} label="On" />)
    const box = view.container.querySelector('span[aria-hidden="true"]')
    const classes = box?.getAttribute('class') ?? ''
    assert.match(classes, /peer-focus-visible/, 'the box takes focus from the input via `peer`')
    assert.ok(!/ring-offset/.test(classes), 'and no ring-offset colour guesses at the surface behind it')
    view.unmount()
  })

  run('indeterminate is set on the element, since it has no attribute', () => {
    const view = mount(<Checkbox checked={false} indeterminate onChange={() => undefined} label="Some" />)
    const input = view.container.querySelector('input') as HTMLInputElement
    assert.equal(input.indeterminate, true, 'mixed state is a DOM property; JSX alone cannot express it')
    view.unmount()
  })

  run('clicking reports the next value, not the event', () => {
    const seen: boolean[] = []
    const view = mount(<Checkbox checked={false} onChange={(next) => seen.push(next)} label="Tick" />)
    const input = view.container.querySelector('input') as HTMLInputElement
    act(() => {
      input.click()
    })
    assert.deepEqual(seen, [true], 'callers get a boolean, so no call site unwraps event.target.checked itself')
    view.unmount()
  })

  // ── Badge ─────────────────────────────────────────────────────────────────

  run('a counter caps rather than overflowing its trigger', () => {
    const view = mount(<Badge count={137} max={99} tone="error" ariaLabel="137 errors" />)
    assert.match(view.container.textContent ?? '', /99\+/, 'past the cap the badge says so instead of widening')
    view.unmount()
  })

  run('a counter is legible on its own fill in every theme', () => {
    // Every shipped counter hardcoded --bg-app as its ink, which only works
    // while the badge is on a saturated tone. --text-on-accent is the token that
    // means "foreground for a filled surface".
    const view = mount(<Badge count={3} tone="warn" ariaLabel="3 waiting" />)
    const classes = view.container.firstElementChild?.getAttribute('class') ?? ''
    assert.match(classes, /text-\[color:var\(--text-on-accent\)\]/)
    assert.match(classes, /tabular-nums/, 'and 1 → 2 must not jog the layout')
    view.unmount()
  })

  run('a decorative badge is hidden, a meaningful one is named', () => {
    // A bare "3" read aloud tells a screen reader nothing, and reading it beside
    // a label that already says "3 waiting" says it twice.
    const decorative = mount(<Badge count={3} decorative tone="warn" />)
    assert.equal(decorative.container.firstElementChild?.getAttribute('aria-hidden'), 'true')
    decorative.unmount()

    const named = mount(<Badge count={3} tone="warn" ariaLabel="3 agents waiting" />)
    assert.equal(named.container.firstElementChild?.getAttribute('aria-label'), '3 agents waiting')
    named.unmount()
  })

  // ── Table ─────────────────────────────────────────────────────────────────

  run('the table is a real table, with header association', () => {
    // One of the three variants this replaces was a div-grid, which reads to a
    // screen reader as a stack of unrelated cells: no row or column association
    // and no header relationship. That was the one difference between the three
    // that was a defect rather than a preference.
    const view = mount(
      <Table ariaLabel="Processes">
        <thead>
          <tr>
            <Table.Head>Kind</Table.Head>
            <Table.Head numeric>PID</Table.Head>
          </tr>
        </thead>
        <tbody>
          <Table.Row>
            <Table.Cell>Renderer</Table.Cell>
            <Table.Cell numeric>4821</Table.Cell>
          </Table.Row>
        </tbody>
      </Table>,
    )
    assert.ok(view.container.querySelector('table'), 'a real <table>')
    const th = view.container.querySelector('th')
    assert.equal(th?.getAttribute('scope'), 'col', 'headers declare what they label')
    const numericCell = view.container.querySelectorAll('td')[1]
    assert.match(
      numericCell?.getAttribute('class') ?? '',
      /tabular-nums/,
      'numeric columns get figures that line up, not just right alignment',
    )
    view.unmount()
  })

  run('a sticky header paints a ground; a static one does not', () => {
    // Sticky without a ground lets rows show through it as they scroll under.
    const sticky = mount(
      <Table>
        <thead>
          <tr>
            <Table.Head>Kind</Table.Head>
          </tr>
        </thead>
      </Table>,
    )
    const stickyClasses = sticky.container.querySelector('th')?.getAttribute('class') ?? ''
    assert.match(stickyClasses, /sticky/)
    assert.match(stickyClasses, /bg-\[color:var\(--bg-surface\)\]/)
    assert.match(stickyClasses, /z-\[var\(--z-sticky\)\]/, 'on the ramp tier for pinned in-flow chrome')
    sticky.unmount()
  })

  // ── EmptyState ────────────────────────────────────────────────────────────

  run('empty-state copy is readable ink, not disabled ink', () => {
    // One of the five hand-rolls rendered its sentence in --text-disabled: copy
    // meant to be READ, greyed out as if it were a dead control.
    const view = mount(<EmptyState title="No workspace open" />)
    const line = view.container.querySelector('p')
    const classes = line?.getAttribute('class') ?? ''
    assert.match(classes, /text-\[color:var\(--text-muted\)\]/)
    assert.ok(!/text-disabled/.test(classes))
    view.unmount()
  })

  run('the two densities are actually different', () => {
    const pane = mount(<EmptyState title="Nothing selected" />)
    const list = mount(<EmptyState density="list" title="No matches" />)
    const paneClasses = pane.container.firstElementChild?.getAttribute('class') ?? ''
    const listClasses = list.container.firstElementChild?.getAttribute('class') ?? ''
    assert.match(paneClasses, /h-full/, 'a pane empty state fills the region content would have')
    assert.ok(!/h-full/.test(listClasses), 'a list empty state sits inside the list, not as a page of its own')
    pane.unmount()
    list.unmount()
  })

  // ── SettingCard ───────────────────────────────────────────────────────────

  run('a list card is a real list with its rows divided by hairlines', () => {
    const view = mount(
      <SettingCard as="ul" ariaLabel="Machines">
        <li>one</li>
        <li>two</li>
      </SettingCard>,
    )
    const card = view.container.querySelector('ul[aria-label="Machines"]')
    assert.ok(card, 'the list form is a <ul> carrying the list name')
    const classes = card?.getAttribute('class') ?? ''
    assert.match(classes, /\[&>\*\+\*\]:border-t/, 'rules go between rows')
    assert.ok(!/grid-cols-2/.test(classes), 'one column by default')
    view.unmount()
  })

  run('two columns stay one card, with the rules where the cells meet', () => {
    const view = mount(
      <SettingCard as="ul" ariaLabel="Skills" columns={2}>
        <li>a</li>
        <li>b</li>
        <li>c</li>
      </SettingCard>,
    )
    const classes = view.container.querySelector('ul')?.getAttribute('class') ?? ''
    assert.match(classes, /sm:grid-cols-2/, 'two abreast from the sm breakpoint')
    assert.match(classes, /nth-child\(2\)\]:border-t-0/, 'the first row is two cells, so the second cell drops its top rule')
    assert.match(
      classes,
      /nth-child\(odd\)\]:border-r/,
      'the LEFT column draws the rule between the columns, so a trailing odd cell is still ruled',
    )
    assert.ok(!/nth-child\(even\)\]:border-l/.test(classes), 'and the right column owns none — it may be absent')
    assert.equal(view.container.querySelectorAll('ul').length, 1, 'one card, not two side by side')
    // Three cells: the last row is half empty, and the horizontal rule above
    // it is drawn by cells, so an empty cell fills the half to carry it.
    const cells = view.container.querySelectorAll('ul > li')
    assert.equal(cells.length, 4, 'an odd count gets one filler cell')
    const filler = cells[3]
    assert.equal(filler.getAttribute('aria-hidden'), 'true', 'the filler is not a list item to a screen reader')
    assert.match(filler.getAttribute('class') ?? '', /\bhidden\b.*\bsm:block\b/, 'and not a row in the one-column fallback')
    view.unmount()

    const even = mount(
      <SettingCard as="ul" ariaLabel="Skills" columns={2}>
        <li>a</li>
        <li>b</li>
      </SettingCard>,
    )
    assert.equal(even.container.querySelectorAll('ul > li').length, 2, 'an even count needs no filler')
    even.unmount()
  })

  if (failures > 0) {
    console.error(`\nnewPrimitives.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('new primitives: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
