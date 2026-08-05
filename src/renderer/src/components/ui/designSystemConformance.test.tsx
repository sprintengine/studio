import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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
//   T18  the ink lift is a real step: an unselected title sits at
//        `--text-default`. The resting tier itself is a cascade behaviour
//        (`data-selection-pane` + `:focus-within`) and is measured in the built
//        app by `scripts/testing/selection-tier-pass.mjs`, not here — jsdom
//        loads no stylesheet, so it can only read class names.
//   T5   every tab carries the shared `:focus-visible` indicator;
//        `focus:outline-none` is never left undischarged, and a bare `:focus`
//        ring does not count. T18 made that indicator an offset outline behind
//        one `focus-ring` utility, so the class a tab must carry is the utility
//        reference, not a width and a colour spelled out per control.
//   T11  the active tab is marked by an accent hairline underline plus an ink
//        lift — never by an accent fill on the control itself.
//   T10  row padding resolves to steps on the `sem.space` 2px grid.
//
// Assertions read the mounted elements, not the source files: a contract that
// only holds in the file that declares it is not a contract the composed tree
// keeps.
//
// Two later items extend the suite on the same terms:
//
//   2003/2005  the Design door's canvas and create screen (mounted, below).
//   MC-2109    the modal focus trap, mounted; and the one z ladder, which is
//              the suite's single source-read rule — the overlay shells it
//              polices are whole app screens that cannot be mounted here, and
//              the rule is about the literal a developer types.

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

  // The lift is only a signal if the row it lifts from sits lower. Before T18
  // an unselected title was already `--text-strong`, so "selection lifts its
  // title" changed nothing and the fill carried the state alone.
  await run('T18 an unselected row title sits at --text-default, so the lift is a real step', () => {
    const title = plainRow?.querySelector('.truncate')
    assert.ok(title, 'the unselected row has a title line')
    assert.equal(title?.textContent, 'Unselected item', 'and it is the title, not the supporting line')
    assert.ok(
      hasClassMatching(title, /^text-\[color:var\(--text-default\)\]$/),
      'the unselected title is one rung below the selected one',
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
        classes.some((token) =>
          /^focus-visible:(focus-ring|ring|outline|shadow|border)/.test(token),
        ),
        `tab "${tab.textContent}" declares a focus-visible indicator`,
      )
      assert.ok(
        classes.includes('focus-visible:focus-ring'),
        `tab "${tab.textContent}" reaches for the shared focus-ring utility rather than spelling out a width and a colour`,
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
        classes.some((token) =>
          /^focus-visible:(focus-ring|ring|outline|shadow|border)/.test(token),
        ),
        'focus:outline-none is only allowed alongside a focus-visible replacement',
      )
    }
  })

  // MC-2107: the retired second idiom. A focus-scoped border recolour is not an
  // indicator — it moves no pixels, and on a field whose resting border already
  // sits near the focus hue it is invisible. It had spread to whole form
  // families, so the tree-wide sweep is enforced by the `focus-border-swap` rule
  // in scripts/lint-design-system-conformance.mjs, which reads every renderer
  // source; what belongs HERE is the composed tree keeping the same clause.
  await run('MC-2107 no control in the tree swaps a border on focus instead of wearing the ring', () => {
    for (const element of subtree(container.firstElementChild as Element)) {
      for (const token of classesOf(element)) {
        assert.ok(
          !/^(?:group-|peer-)?focus(?:-within|-visible)?:border-/.test(token),
          `focus is the shared ring, never a border swap — found \`${token}\``,
        )
      }
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
      hasClassMatching(activeTab, /^focus-visible:focus-ring$/),
      'the indicator is still declared on the element that now holds focus',
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

  // --- item 2003: the Design door's canvas ---------------------------------
  // The canvas renders THIRD-PARTY design systems, so it is the surface most
  // likely to drift into borrowing the previewed system's idioms. Mounted with a
  // fixture view and read as markup, like everything else here.

  const { DesignCanvas } = await import(
    '../workspace/globalSurface/design/DesignCanvas'
  )
  const designContainer = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(designContainer)
  const designRoot = createRoot(designContainer)
  const designView = {
    identity: {
      path: '/work/brand/design-system',
      name: 'multicode',
      version: '2.4.0',
      summary: 'The in-house system.',
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      accent: { light: '#2f6a4a', dark: '#4daf7d' },
    },
    manifest: {
      schemaVersion: 1,
      name: 'multicode',
      version: '2.4.0',
      summary: 'The in-house system.',
      modes: ['light', 'dark'],
      namingGrammar: {},
      contents: { components: ['button'], glyphs: ['check'] },
      derived: {},
      provenance: {},
    },
    specimen: {
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      tokensCss: ':root{--sem-color-bg-app:#08080c}',
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      ramp: [{ path: 'ref.color.green.600', light: '#2f6a4a', dark: '#4daf7d' }],
      fontFamilyUi: 'Inter, system-ui',
      fontFamilyMono: null,
      problems: [],
    },
    groups: [
      { key: 'components', label: 'Components', entries: ['button'], count: 1 },
      { key: 'glyphs', label: 'Glyphs', entries: ['check'], count: 1 },
    ],
    components: [
      {
        name: 'button',
        css: '.ds-button{border-radius:5px}',
        inlineStyles: [],
        stages: [{ mode: 'light', html: '<button class="ds-button">Continue</button>' }],
        variantCount: 3,
        stateCount: 4,
        doc: {
          anatomy: 'Label.',
          variants: '- primary\n- secondary\n- ghost',
          states: '- rest\n- hover\n- focus-visible\n- disabled',
          usage: 'One primary per view.',
          accessibility: 'Native button.',
        },
        unresolvedRefs: [],
      },
    ],
    patterns: [],
    glyphs: [{ name: 'check', svg: '<svg viewBox="0 0 16 16"></svg>' }],
    assetBudgetExhausted: false,
  }
  act(() => {
    designRoot.render(
      React.createElement(DesignCanvas, {
        view: designView as never,
        mode: 'dark',
        openComponent: null,
        onOpenComponent: () => {},
        onCloseComponent: () => {},
        onReload: () => {},
        reloading: false,
      }),
    )
  })

  await run('2003 no component tile carries a border — spacing does the grouping', () => {
    const tiles = Array.from(designContainer.querySelectorAll('button')) as Element[]
    const componentTiles = tiles.filter((tile) =>
      (tile.getAttribute('aria-label') ?? '').startsWith('button'),
    )
    assert.ok(componentTiles.length > 0, 'the fixture renders a component tile')
    for (const tile of componentTiles) {
      for (const element of [tile, ...subtree(tile)]) {
        for (const token of classesOf(element)) {
          // `border-0`/`border-none` REMOVE a border (the iframe's UA default),
          // which is the rule, not a violation of it.
          if (token === 'border-0' || token === 'border-none') continue
          assert.ok(
            !/^border(-[trbl])?(-\d+)?$/.test(token) && !token.startsWith('border-['),
            `a tile must not draw a border, found \`${token}\``,
          )
        }
      }
    }
  })

  await run('2003 hover is a background change — never a scale, shadow, or border', () => {
    for (const element of subtree(designContainer.firstElementChild as Element)) {
      for (const token of classesOf(element)) {
        if (!token.startsWith('hover:')) continue
        assert.ok(
          token.startsWith('hover:bg-') || token.startsWith('hover:text-'),
          `hover may only change background or ink, found \`${token}\``,
        )
      }
    }
  })

  await run('2003 the canvas spends two radii, and no marketing radius', () => {
    const radii = new Set<string>()
    for (const element of [
      designContainer.firstElementChild as Element,
      ...subtree(designContainer.firstElementChild as Element),
    ]) {
      for (const token of classesOf(element)) {
        if (token.startsWith('rounded')) radii.add(token)
      }
    }
    for (const token of radii) {
      assert.ok(
        !/^rounded-(2xl|3xl|full)$/.test(token),
        `marketing radii are reject-on-sight, found \`${token}\``,
      )
    }
    assert.ok(radii.size <= 2, `two radii per view; found ${[...radii].join(', ')}`)
  })

  await run('2003 headings are sentence case, never uppercase letter-spaced', () => {
    for (const element of subtree(designContainer.firstElementChild as Element)) {
      for (const token of classesOf(element)) {
        assert.ok(token !== 'uppercase', 'uppercase is not a hierarchy device')
        assert.ok(!/^tracking-(wide|wider|widest)$/.test(token), `found \`${token}\``)
      }
    }
    const headings = Array.from(designContainer.querySelectorAll('h2, h3')) as Element[]
    for (const heading of headings) {
      const text = heading.textContent ?? ''
      assert.ok(text !== text.toUpperCase() || text.length < 2, `shouting heading: ${text}`)
    }
  })

  await run('2003 no Release, version history, lint or regenerate affordance exists', () => {
    const text = (designContainer.textContent ?? '').toLowerCase()
    for (const forbidden of ['release', 'lint', 'regenerate', 'version history', 'pull']) {
      assert.ok(!text.includes(forbidden), `the canvas must not offer "${forbidden}"`)
    }
    // The two actions that DO belong are both about the folder.
    assert.ok(text.includes('reveal'), 'Reveal is offered')
    assert.ok(text.includes('reload'), 'Reload is offered')
  })

  await run('2003 the specimen has no container and the name appears exactly once', () => {
    const occurrences = (designContainer.textContent ?? '').split('multicode').length - 1
    assert.equal(occurrences, 1, 'the system name is shown once, in the specimen')
    const specimen = designContainer.querySelector('[aria-label="multicode specimen"]')
    assert.ok(specimen, 'the specimen is a labelled region')
    for (const token of classesOf(specimen)) {
      assert.ok(!token.startsWith('border'), 'the specimen has no container')
      assert.ok(!token.startsWith('bg-'), 'and no surface of its own')
    }
  })

  act(() => {
    designRoot.unmount()
  })

  // --- item 2005: the create screen ----------------------------------------
  // The screen most at risk of growing affordances the epic explicitly cut:
  // clone-from-GitHub, a DTCG token-file import, a marketplace shelf. Each was
  // rejected for its own reason, and each would be easy to re-add by accident.

  const { NewDesignSystemScreen } = await import(
    '../workspace/globalSurface/design/NewDesignSystemScreen'
  )
  const newRoot = createRoot(designContainer)
  act(() => {
    newRoot.render(
      React.createElement(NewDesignSystemScreen, {
        sources: [
          { path: '/work/brand/design-system', name: 'multicode', view: designView as never },
          { path: null, name: 'Empty system', view: null },
        ],
        mode: 'dark',
        busy: null,
        error: null,
        onPointAtFolder: () => {},
        onSeedFrom: () => {},
      }),
    )
  })

  await run('2005 Point at a folder is the ONE accent-filled action on the screen', () => {
    const primaries = (Array.from(designContainer.querySelectorAll('button')) as Element[]).filter(
      (button) => classesOf(button).some((token) => /^bg-\[color:var\(--accent-primary/.test(token)),
    )
    assert.equal(primaries.length, 1, 'exactly one accent-filled control')
    assert.match(primaries[0].textContent ?? '', /Point at a folder/)
  })

  await run('2005 no heading sits above the grid', () => {
    // With the rejected "bring one in" row cut there is one group on screen, and
    // a heading must separate something from something else.
    assert.equal(
      designContainer.querySelectorAll('h1, h2, h3').length,
      0,
      'a heading here would label the only thing present',
    )
  })

  await run('2005 a card names its system once, in the specimen — never again beneath', () => {
    // The specimen lives inside a sandboxed iframe (srcdoc), so the app-side
    // markup must carry the name only as the accessible label of the card.
    const cards = (Array.from(designContainer.querySelectorAll('button')) as Element[]).filter(
      (button) => (button.getAttribute('aria-label') ?? '').startsWith('Start from'),
    )
    assert.equal(cards.length, 2, 'one per source, plus Empty')
    const seeded = cards[0]
    assert.equal(seeded.getAttribute('aria-label'), 'Start from multicode')
    assert.ok(
      !(seeded.textContent ?? '').includes('multicode'),
      'no caption repeating the name the specimen already carries',
    )
    // Boxless: no border on the card itself.
    for (const token of classesOf(seeded)) {
      assert.ok(!/^border(-[trbl])?(-\d+)?$/.test(token), `a card must not be boxed: ${token}`)
    }
  })

  await run('2005 nothing clones, imports a token file, or names a marketplace', () => {
    const text = (designContainer.textContent ?? '').toLowerCase()
    for (const forbidden of [
      'github',
      'clone',
      'pull',
      'fetch',
      'marketplace',
      'import',
      'browse',
      'url',
    ]) {
      assert.ok(!text.includes(forbidden), `the create screen must not offer "${forbidden}"`)
    }
  })

  act(() => {
    newRoot.unmount()
  })
  designContainer.remove()

  act(() => {
    root.unmount()
  })

  // --- MC-2109: the modal focus trap ---------------------------------------
  // Mounted, not read: the trap is behaviour. jsdom moves no focus on Tab, so
  // what is asserted here is the mechanism the browser's Tab lands on — the
  // sentinel that sits immediately before and after the dialog in the tab
  // order, and where it sends focus when it fires. DOM order does the rest:
  // there is no tabbable node between a sentinel and the dialog it guards.

  const { Modal } = await import('./Modal')
  const { FocusTrap } = await import('./FocusTrap')

  const trapContainer = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(trapContainer)
  const trapRoot = createRoot(trapContainer)
  act(() => {
    trapRoot.render(
      React.createElement(
        Modal,
        { open: true, onClose: () => {} },
        React.createElement('button', { id: 'first', key: 'a' }, 'First'),
        React.createElement('button', { id: 'last', key: 'b' }, 'Last'),
      ),
    )
  })

  const sentinels = Array.from(
    trapContainer.querySelectorAll('[data-focus-sentinel="true"]'),
  ) as HTMLElement[]

  await run('MC-2109 a Modal mounts one sentinel each side of the dialog it declares modal', () => {
    assert.equal(sentinels.length, 2, 'the dialog is guarded on both edges')
    const dialog = trapContainer.querySelector('[role="dialog"]')
    assert.ok(dialog, 'the dialog mounted')
    assert.equal(sentinels[0].nextElementSibling, dialog, 'nothing tabbable sits between the opening sentinel and the dialog')
    assert.equal(sentinels[1].previousElementSibling, dialog, 'nor between the dialog and the closing one')
    for (const sentinel of sentinels) {
      assert.equal(sentinel.getAttribute('tabindex'), '0', 'a sentinel has to be in the tab order to catch the Tab that would leave')
    }
  })

  await run('MC-2109 Tab off the end of the dialog returns to its first control', () => {
    act(() => {
      sentinels[1].focus()
    })
    assert.equal(
      dom.window.document.activeElement?.id,
      'first',
      'the cycle wraps forward instead of walking out into the page behind the scrim',
    )
  })

  await run('MC-2109 Shift+Tab off the front of the dialog returns to its last control', () => {
    act(() => {
      sentinels[0].focus()
    })
    assert.equal(dom.window.document.activeElement?.id, 'last', 'and backward too')
  })

  act(() => {
    trapRoot.unmount()
  })

  // The New sprint dialog stacks its New-item capture as a SIBLING of the
  // dialog it traps. A trap that read its parent element would fold the two
  // into one cycle; this fixture is that shape, reduced.
  const siblingRoot = createRoot(trapContainer)
  act(() => {
    siblingRoot.render(
      React.createElement(
        'div',
        null,
        React.createElement(
          FocusTrap,
          { key: 'trap' },
          React.createElement(
            'div',
            { role: 'dialog', 'aria-modal': 'true', tabIndex: -1 },
            React.createElement('button', { id: 'inside' }, 'Inside'),
          ),
        ),
        React.createElement('button', { key: 'sibling', id: 'sibling' }, 'Sibling'),
      ),
    )
  })

  await run('MC-2109 the trapped region is what the trap wraps, never a sibling beside it', () => {
    const edges = Array.from(
      trapContainer.querySelectorAll('[data-focus-sentinel="true"]'),
    ) as HTMLElement[]
    assert.equal(edges.length, 2, 'the trap mounted its sentinels')
    act(() => {
      edges[1].focus()
    })
    assert.equal(
      dom.window.document.activeElement?.id,
      'inside',
      'a control outside the trap is not part of its cycle',
    )
  })

  act(() => {
    siblingRoot.unmount()
  })
  trapContainer.remove()

  // --- MC-2109: one z ladder, and overlays read it by name -----------------
  // Read from source, not from the tree: the overlay shells this rule polices
  // are whole app screens (the New sprint dialog, the diagnostics overlay, the
  // roster manager) that cannot be mounted here, and the rule is about the
  // literal a developer types. The renderer used to run a private ladder
  // (10/20/30/35/40/50) beside the design system's `--sem-z-*`, and the two
  // disagreed about the top of the stack — a `z-50` modal sat BELOW the z-60
  // menus. Now every overlay layer derives from the tokens, aliased into the
  // app as `--z-*`.
  //
  // Scope is overlay shells: a class string that positions itself `fixed` or
  // paints the `.overlay-scrim`. In-flow depth inside a pane (`z-10` on a HUD,
  // `z-20` on a docked pane, `z-30` on a panel-internal popover) describes
  // depth within one surface, not a layer in the app's stack, and is left alone.
  await run('MC-2109 no overlay shell carries a raw z literal — layering comes from --z-* tokens', () => {
    const rendererRoot = join(process.cwd(), 'src/renderer/src')
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full)
      }
    }
    walk(rendererRoot)

    // A whole class token, so `z-[var(--z-modal)]` and `zoom-50` never match.
    const RAW_Z = /(?:^|\s)(-?z-(?:\d+|\[\d+\]))(?=\s|$)/
    const OVERLAY_SHELL = /(?:^|\s)(?:fixed|overlay-scrim)(?=\s|$)/
    const STRINGS = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g

    const offenders: string[] = []
    for (const path of sources) {
      // Comments first: `Modal.tsx` documents the retired ladder in prose, and
      // prose is not a class string.
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const match of code.matchAll(STRINGS)) {
        const text = match[1] ?? match[2] ?? match[3] ?? ''
        const z = text.match(RAW_Z)
        if (!z || !OVERLAY_SHELL.test(text)) continue
        offenders.push(`${relative(process.cwd(), path)}: ${z[1]}`)
      }
    }
    assert.deepEqual(offenders, [], 'overlay z literals must name a tier: z-[var(--z-modal)] and friends')
  })

  if (failures > 0) {
    console.error(`designSystemConformance.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('designSystemConformance.test.tsx: ok')
}

void main()
