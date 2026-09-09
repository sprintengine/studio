import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// CheckRow — the pick-AND-mark row (design-system/components/check-row).
//
// The assertions are aimed at the four things this row is easy to get wrong,
// each of which the spec rules on explicitly:
//
//   1. the tick and the choice are two channels — a row can be checked and
//      unselected, or selected and unchecked, and neither may be read as the
//      other;
//   2. the box is a SIBLING and not a control — a real <input> per row would
//      be the four hundredth tab stop in a list that is one;
//   3. the state is announced once — the row's `aria-checked`, with the drawn
//      box `aria-hidden`;
//   4. clicking the box ticks without picking, and clicking the row picks
//      without ticking.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
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
  const { CheckRow } = await import('./CheckRow')

  const document = dom.window.document

  function mount(node: React.ReactNode): { row: HTMLElement; container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    const row = container.firstElementChild as HTMLElement
    return {
      row,
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  run('the tick is on the row, and the drawn box is hidden from assistive tech', () => {
    const view = mount(<CheckRow checked name="arrivals.ts" directory="src/shared" />)
    assert.equal(view.row.getAttribute('role'), 'option')
    assert.equal(view.row.getAttribute('aria-checked'), 'true')
    assert.equal(
      view.container.querySelectorAll('input').length,
      0,
      'a real input per row would be the four hundredth tab stop in a list that is one',
    )
    const box = view.container.querySelector('span[aria-hidden="true"]')
    assert.ok(box, 'the box is drawn, and it is decoration')
    view.unmount()
  })

  run('mixed is a third state, not a checked box with a different mark', () => {
    const view = mount(<CheckRow checked="mixed" name="app-services.ts" />)
    assert.equal(
      view.row.getAttribute('aria-checked'),
      'mixed',
      'a partly-staged file announces mixed, which is what the dash means',
    )
    view.unmount()
  })

  run('checked and selected are two channels: a row can carry either alone', () => {
    const checkedOnly = mount(<CheckRow checked name="a.ts" />)
    assert.equal(checkedOnly.row.getAttribute('aria-checked'), 'true')
    assert.equal(checkedOnly.row.getAttribute('aria-selected'), 'false')

    const selectedOnly = mount(<CheckRow checked={false} selected name="b.ts" />)
    assert.equal(selectedOnly.row.getAttribute('aria-checked'), 'false')
    assert.equal(selectedOnly.row.getAttribute('aria-selected'), 'true')
    // Selection is the neutral fill plus the inset edge, never an accent fill.
    const classes = selectedOnly.row.getAttribute('class') ?? ''
    assert.match(classes, /bg-\[color:var\(--bg-selected\)\]/)
    assert.match(classes, /ring-inset ring-\[color:var\(--selection-edge\)\]/)
    assert.ok(!/bg-\[color:var\(--accent-primary\)\]/.test(classes), 'never an accent FILL on a chosen row')
    assert.ok(!/border-l/.test(classes), 'and never a left bar — the gutter belongs to the cursor')

    checkedOnly.unmount()
    selectedOnly.unmount()
  })

  run('the resting tier takes the quieter fill and drops the edge', () => {
    const view = mount(<CheckRow checked={false} resting name="c.ts" />)
    const classes = view.row.getAttribute('class') ?? ''
    assert.match(classes, /bg-\[color:var\(--bg-selected-resting\)\]/)
    // `ring-2 ring-inset`, not bare `ring-inset`: the row's focus utility is
    // `focus-visible:focus-ring-inset`, which contains that substring and is
    // not the selection edge.
    assert.ok(!/ring-2 ring-inset/.test(classes), 'exactly one accent edge on screen, on the pane with focus')
    view.unmount()
  })

  run('clicking the box ticks without picking; clicking the row picks without ticking', () => {
    const events: string[] = []
    const view = mount(
      <CheckRow
        checked={false}
        name="repo-reader.ts"
        onCheckedChange={(next) => events.push(`checked:${next}`)}
        onSelect={() => events.push('selected')}
      />,
    )
    const box = view.row.querySelector('span[class*="size-icon-sm"]') as HTMLElement
    act(() => {
      box.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(events, ['checked:true'], 'the tick does not also pick the row')

    act(() => {
      view.row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(events, ['checked:true', 'selected'], 'and picking the row does not tick it')
    view.unmount()
  })

  run('the cursor is a gutter mark, and it composes over the selection fill', () => {
    // A third channel: it has to stay visible on a row that is already selected
    // and distinct from one merely hovered, which neither fill can do over the
    // other. `--text-strong`, not the accent, because --border-focus and
    // --accent-primary are the same value in 18 of the 19 themes.
    const view = mount(<CheckRow checked selected cursor name="swap2-top.png" />)
    const mark = view.row.querySelector('[aria-hidden="true"][class*="absolute"]')
    assert.ok(mark, 'the cursor is drawn even on a row that is already selected')
    const classes = mark.getAttribute('class') ?? ''
    assert.match(classes, /bg-\[color:var\(--text-strong\)\]/, 'never the accent — that reads as a slipped focus ring')
    assert.match(classes, /pointer-events-none/)
    assert.match(view.row.getAttribute('class') ?? '', /relative/, 'the row is the mark\'s positioning context')

    const without = mount(<CheckRow checked name="swap2-top.png" />)
    assert.equal(
      without.row.querySelectorAll('[aria-hidden="true"][class*="absolute"]').length,
      0,
      'a list that moves real focus with its cursor draws no mark at all',
    )
    view.unmount()
    without.unmount()
  })

  run('a disabled row stays in the walk and refuses both', () => {
    const events: string[] = []
    const view = mount(
      <CheckRow
        checked={false}
        disabled
        name="package-lock.json"
        onCheckedChange={() => events.push('checked')}
        onSelect={() => events.push('selected')}
      />,
    )
    assert.equal(view.row.getAttribute('aria-disabled'), 'true')
    assert.equal(view.row.hasAttribute('disabled'), false, 'aria-disabled, never the attribute: the row stays reachable')
    act(() => {
      view.row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(events, [])
    view.unmount()
  })

  run('a tree row carries level and expansion on itself, and a leaf keeps the slot', () => {
    const branch = mount(<CheckRow checked={false} role="treeitem" level={1} expanded depth={0} name="design-system" />)
    assert.equal(branch.row.getAttribute('role'), 'treeitem')
    assert.equal(branch.row.getAttribute('aria-expanded'), 'true')
    assert.equal(branch.row.getAttribute('aria-level'), '1')
    assert.equal(
      branch.row.hasAttribute('aria-selected'),
      false,
      'a tree announces itself as selectable only when something in it is selected',
    )

    const leaf = mount(<CheckRow checked={false} role="treeitem" level={2} depth={1} name="tokens.ts" />)
    assert.equal(leaf.row.hasAttribute('aria-expanded'), false, 'a leaf declares no expansion state')
    const twisty = leaf.row.querySelector('[class*="invisible"]')
    assert.ok(twisty, 'the chevron slot survives on a leaf so every glyph column lines up')
    assert.equal(
      leaf.row.getAttribute('style'),
      'padding-left: 20px;',
      'one 12px level step off the row\'s own 8px inset',
    )

    branch.unmount()
    leaf.unmount()
  })

  run('the row is one tab stop\'s worth of DOM, and the list keeps its hooks', () => {
    const view = mount(
      <CheckRow checked={false} name="a.ts" id="row-a" tabIndex={-1} data-path="src/a.ts" />,
    )
    assert.equal(view.row.getAttribute('id'), 'row-a', 'aria-activedescendant needs a stable id')
    assert.equal(view.row.getAttribute('tabindex'), '-1')
    assert.equal(view.row.getAttribute('data-path'), 'src/a.ts', 'the list drives roving focus by its own hook')
    assert.equal(view.row.tagName, 'DIV', 'never a <button>: that is why the box may sit inside it')
    view.unmount()
  })

  if (failures > 0) {
    console.error(`\nCheckRow.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('CheckRow: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
