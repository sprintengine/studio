import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Seam test for the design-system conformance epic (T15).
//
// The twelve fix tasks each emptied their own baseline in isolation. The guard
// proves no rule fires anywhere; it cannot prove the fixes still hold when the
// two primitives that carry most of the product are composed. This suite mounts
// a selected `InboxRow` inside a `Tabs` strip — one tree, one render — and
// asserts the four contracts those tasks landed:
//
//   T4   selection is a neutral `--bg-selected` fill, the title sits at
//        `--text-strong`, and no accent left bar survives anywhere in the row.
//   T5   every tab carries a `:focus-visible` ring; `focus:outline-none` is
//        never left undischarged, and a bare `:focus` ring does not count.
//   T11  the active tab is marked by an accent hairline underline plus an ink
//        lift — never by an accent fill on the control itself.
//   T10  row padding resolves to steps on the `sem.space` 2px grid.
//
// Assertions read the mounted elements, not the source files: a contract that
// only holds in the file that declares it is not a contract the composed tree
// keeps.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

let failures = 0
function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`)
    })
    .catch((error) => {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    })
}

/* ------------------------------------------------------------------ *
 * Class-list helpers
 * ------------------------------------------------------------------ */

function classesOf(element: Element | null | undefined): string[] {
  assert.ok(element, 'expected the element to exist before reading its classes')
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

function hasClassMatching(element: Element | null | undefined, pattern: RegExp): boolean {
  return classesOf(element).some((token) => pattern.test(token))
}

// Every element in the subtree, the root included.
function subtree(root: Element): Element[] {
  return [root, ...(Array.from(root.querySelectorAll('*')) as Element[])]
}

// `sem.space.*` — the 2px grid the system declares. `lint-design-system-conformance.mjs`
// only rejects odd arbitrary pixel values; this list is the tighter statement of
// the same clause, and it is what the row is held to.
const SPACE_SCALE_PX = new Set([0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32])

const PADDING_UTILITY = /^-?(p|px|py|pt|pr|pb|pl)-(.+)$/

// Resolve a Tailwind spacing token to pixels: the numeric scale is 4px per
// step (`3` → 12px, `0.5` → 2px), and the arbitrary form carries its own unit.
function spacingPx(value: string): number | null {
  const arbitrary = value.match(/^\[(-?\d+(?:\.\d+)?)px\]$/)
  if (arbitrary) return Math.abs(Number(arbitrary[1]))
  const arbitraryRem = value.match(/^\[(-?\d+(?:\.\d+)?)rem\]$/)
  if (arbitraryRem) return Math.abs(Number(arbitraryRem[1]) * 16)
  // `px` is deliberately not a spacing step. It is the hairline unit — the same
  // 1px the system spends on borders and the active-tab underline — and the tab
  // strip legitimately uses `-mb-px` to pull itself over the container's border
  // so the two hairlines meet. Resolving it here would fail correct code.
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null
  return Number(value) * 4
}

function paddingSteps(element: Element): { token: string; px: number }[] {
  const steps: { token: string; px: number }[] = []
  for (const token of classesOf(element)) {
    const match = token.match(PADDING_UTILITY)
    if (!match) continue
    const px = spacingPx(match[2])
    assert.ok(
      px !== null,
      `padding utility \`${token}\` on the row does not resolve to a pixel value, ` +
        'so it cannot be checked against the 2px grid',
    )
    steps.push({ token, px: px as number })
  }
  return steps
}

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { InboxRow } = await import('./InboxRow')
  const { Tabs, TabPanel } = await import('./Tabs')

  const TABS = [
    { id: 'inbox', label: 'Inbox', count: 2 },
    { id: 'archive', label: 'Archive' },
  ]

  // One tree: the tab strip above, a selected row and an unselected sibling
  // below it. The unselected row and tab are load-bearing — a contract asserted
  // only on the selected element cannot tell "neutral selection" apart from
  // "every row looks the same".
  function Surface(): React.ReactElement {
    return React.createElement(
      'div',
      null,
      React.createElement(Tabs, {
        ariaLabel: 'Worklist',
        items: TABS,
        value: 'inbox',
        onChange: () => {},
        idPrefix: 'seam',
      }),
      React.createElement(TabPanel, {
        idPrefix: 'seam',
        tabId: 'inbox',
        active: true,
        children: [
          React.createElement(InboxRow, {
            key: 'selected',
            id: 'row-selected',
            title: 'Selected item',
            supporting: 'The row a person is looking at',
            trailing: '2m',
            selected: true,
            onSelect: () => {},
          }),
          React.createElement(InboxRow, {
            key: 'plain',
            id: 'row-plain',
            title: 'Unselected item',
            supporting: 'The row beside it',
            trailing: '9m',
            onSelect: () => {},
          }),
        ],
      }),
    )
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(Surface))
  })

  const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as Element[]
  const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
  const idleTab = tabs.find((tab) => tab.getAttribute('aria-selected') !== 'true')
  const selectedRow = container.querySelector('#row-selected')
  const plainRow = container.querySelector('#row-plain')

  await run('the tree composes: a tab strip above a selected row and its sibling', () => {
    assert.equal(tabs.length, 2, 'both tabs mounted')
    assert.ok(activeTab, 'one tab is aria-selected')
    assert.ok(idleTab, 'the other tab is not')
    assert.ok(selectedRow, 'the selected row mounted')
    assert.ok(plainRow, 'its unselected sibling mounted')
    assert.equal(selectedRow?.tagName, 'BUTTON', 'an interactive row renders as a button')
  })

  // --- T4: neutral two-tier selection ------------------------------------

  await run('T4 selection is the neutral --bg-selected fill, and only the selected row carries it', () => {
    assert.ok(
      hasClassMatching(selectedRow, /^bg-\[color:var\(--bg-selected\)\]$/),
      'the selected row is filled with --bg-selected',
    )
    assert.ok(
      !hasClassMatching(plainRow, /^bg-\[color:var\(--bg-selected\)\]$/),
      'the unselected row is not — selection has to be visible as a difference',
    )
    assert.equal(
      selectedRow?.getAttribute('aria-current'),
      'true',
      'the neutral fill is carried to assistive tech by aria-current',
    )
  })

  await run('T4 the selected row title sits at --text-strong', () => {
    const title = selectedRow?.querySelector('.truncate')
    assert.ok(title, 'the row has a title line')
    assert.equal(title?.textContent, 'Selected item', 'and it is the title, not the supporting line')
    assert.ok(
      hasClassMatching(title, /^text-\[color:var\(--text-strong\)\]$/),
      'the title is the second tier of the selection: ink lifted to --text-strong',
    )
  })

  await run('T4 no accent and no left bar survives anywhere in the selected row', () => {
    for (const element of subtree(selectedRow as Element)) {
      for (const token of classesOf(element)) {
        assert.ok(
          !/--accent-primary/.test(token),
          `selection must not reach for the accent, found \`${token}\``,
        )
        assert.ok(
          !/^-?border-l(-|$)/.test(token),
          `selection must not draw a left bar, found \`${token}\``,
        )
      }
    }
  })

  // --- T5: the focus ring is present and on :focus-visible ---------------

  await run('T5 every tab carries a :focus-visible ring', () => {
    for (const tab of tabs) {
      const classes = classesOf(tab)
      assert.ok(
        classes.some((token) => /^focus-visible:(ring|outline|shadow|border)/.test(token)),
        `tab "${tab.textContent}" declares a focus-visible ring`,
      )
      assert.ok(
        classes.includes('focus-visible:ring-[color:var(--border-focus)]'),
        `tab "${tab.textContent}" takes the ring colour from --border-focus, not a literal`,
      )
    }
  })

  await run('T5 focus:outline-none is never left undischarged, and a bare :focus ring does not count', () => {
    for (const element of [...tabs, selectedRow as Element, plainRow as Element]) {
      const classes = classesOf(element)
      assert.ok(
        !classes.some((token) => /^focus:(ring|outline-\[|shadow)/.test(token)),
        'a ring on :focus draws for a mouse click, which the clause rules out',
      )
      if (!classes.includes('focus:outline-none')) continue
      assert.ok(
        classes.some((token) => /^focus-visible:(ring|outline|shadow|border)/.test(token)),
        'focus:outline-none is only allowed alongside a focus-visible replacement',
      )
    }
  })

  await run('T5 the focused tab is reachable and keeps its ring once focus lands on it', () => {
    ;(activeTab as unknown as HTMLElement).focus()
    assert.equal(
      dom.window.document.activeElement,
      activeTab,
      'the active tab takes focus — a ring on an unreachable control is not a keyboard path',
    )
    assert.equal(activeTab?.getAttribute('tabindex'), '0', 'and it is the tab in the tab order')
    assert.equal(idleTab?.getAttribute('tabindex'), '-1', 'roving focus keeps the other one out of it')
    assert.ok(
      hasClassMatching(activeTab, /^focus-visible:ring-2$/),
      'the ring is still declared on the element that now holds focus',
    )
  })

  // --- T11: active is an underline plus an ink lift, never a fill ---------

  await run('T11 the active tab is marked by an accent hairline underline', () => {
    const underline = activeTab?.querySelector('[aria-hidden="true"].absolute')
    assert.ok(underline, 'the active tab carries a decorative underline element')
    const classes = classesOf(underline)
    assert.ok(classes.includes('h-px'), 'the underline is a hairline, not a bar')
    assert.ok(
      classes.includes('bg-[color:var(--accent-primary)]'),
      'the accent is spent on the hairline — the one shape the accent budget allows',
    )
    const idleUnderline = idleTab?.querySelector('[aria-hidden="true"].absolute')
    assert.ok(idleUnderline, 'the idle tab reserves the same space so the strip does not shift')
    assert.ok(
      !hasClassMatching(idleUnderline, /--accent-primary/),
      'but draws nothing — otherwise the underline would not mark anything',
    )
  })

  await run('T11 active also lifts the ink, and idle does not', () => {
    assert.ok(
      hasClassMatching(activeTab, /^text-\[color:var\(--text-strong\)\]$/),
      'the active tab label is lifted to --text-strong',
    )
    assert.ok(
      hasClassMatching(idleTab, /^text-\[color:var\(--text-muted\)\]$/),
      'the idle tab label stays at --text-muted, so the lift reads as state',
    )
  })

  await run('T11 no accent fill marks the active tab', () => {
    for (const tab of tabs) {
      for (const token of classesOf(tab)) {
        assert.ok(
          !/^bg-\[color:var\(--accent-primary/.test(token),
          `the accent is never a fill on the control itself, found \`${token}\``,
        )
      }
      // The hairline is the only element permitted to spend the accent, and only
      // because it is a hairline. Anything taller filling with the accent is the
      // violation this contract exists to catch.
      for (const element of subtree(tab)) {
        const classes = classesOf(element)
        if (!classes.some((token) => /^bg-\[color:var\(--accent-primary/.test(token))) continue
        assert.ok(
          classes.includes('h-px') || classes.includes('w-px'),
          `only a hairline may carry the accent fill, found it on \`${classes.join(' ')}\``,
        )
      }
    }
  })

  // --- T10: row padding is on the 2px grid -------------------------------

  await run('T10 row padding resolves to steps on the sem.space 2px grid', () => {
    for (const row of [selectedRow as Element, plainRow as Element]) {
      const steps = paddingSteps(row)
      assert.ok(steps.length > 0, 'the row declares padding — a row with none is not a row')
      for (const step of steps) {
        assert.ok(
          SPACE_SCALE_PX.has(step.px),
          `padding \`${step.token}\` is ${step.px}px, which is not a sem.space step ` +
            `(${[...SPACE_SCALE_PX].join(', ')})`,
        )
      }
    }
  })

  await run('T10 every spacing utility in the composed tree lands on the 2px grid', () => {
    const SPACING_UTILITY =
      /^-?(?:px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y)-(.+)$/
    for (const element of subtree(container.firstElementChild as Element)) {
      for (const token of classesOf(element)) {
        const match = token.match(SPACING_UTILITY)
        if (!match) continue
        const px = spacingPx(match[1])
        // `gap-0.5` style fractions resolve; anything else (`auto`, `full`) is
        // not a grid value at all and is left alone.
        if (px === null) continue
        assert.ok(
          px % 2 === 0,
          `\`${token}\` resolves to ${px}px, off the 2px grid`,
        )
      }
    }
  })

  act(() => {
    root.unmount()
  })

  if (failures > 0) {
    console.error(`designSystemConformance.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('designSystemConformance.test.tsx: ok')
}

void main()
