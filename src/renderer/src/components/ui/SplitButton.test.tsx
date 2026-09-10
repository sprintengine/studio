import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SplitButton } from './SplitButton'

// The `quiet` variant (design-system/components/split-button → Variants,
// `ds-split-button--quiet`). What has to be true is not "it looks lighter" but
// that it took away exactly the chrome and NOTHING that resolves which half is
// live: the hairline, the per-half hover, the held-open chevron and the inset
// focus ring are what make a split button operable, and a quiet control is not
// a less accessible one. Each of those is asserted below against the rendered
// markup, because a variant that quietly dropped one would still render.

const dom = new JSDOM('<!doctype html><html><body></body></html>')

function group(props: {
  quiet?: boolean
  disabled?: boolean
  items?: React.ComponentProps<typeof SplitButton>['items']
  menuKind?: React.ComponentProps<typeof SplitButton>['menuKind']
  primaryData?: React.ComponentProps<typeof SplitButton>['primaryData']
}): Element {
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    React.createElement(SplitButton, {
      label: 'Open',
      primaryAriaLabel: 'Open in VS Code',
      menuAriaLabel: 'Open in…',
      items: [
        { id: 'vscode', label: 'VS Code', onSelect: () => {}, checked: true },
        { id: 'idea', label: 'IntelliJ IDEA', onSelect: () => {} },
      ],
      onPrimary: () => {},
      ...props,
    }),
  )
  const node = host.querySelector('span.inline-flex')
  assert.ok(node, 'the split button rendered no group')
  return node
}

const halves = (node: Element) => Array.from(node.querySelectorAll('button'))

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

run('quiet drops the outer border, the ground and the raised edge', () => {
  const quiet = (group({ quiet: true }).getAttribute('class') ?? '').split(/\s+/)
  const bordered = (group({}).getAttribute('class') ?? '').split(/\s+/)

  assert.ok(bordered.includes('border'), 'the default group is the bordered one')
  assert.ok(
    bordered.some((c) => c.includes('bg-surface-raised')),
    'the default group sits on the raised ground',
  )
  assert.ok(bordered.includes('control-edge'), 'the default group carries the press edge')

  assert.ok(!quiet.includes('border'), 'quiet has no outer border')
  assert.ok(!quiet.some((c) => c.includes('bg-surface-raised')), 'quiet has no raised ground')
  assert.ok(
    !quiet.includes('control-edge'),
    'quiet has no press edge — the raised ground it would sink is what the variant removes',
  )
})

run('quiet comes down to the hit-target floor, and no lower', () => {
  const quiet = group({ quiet: true }).getAttribute('class') ?? ''
  const bordered = group({}).getAttribute('class') ?? ''
  assert.ok(bordered.includes('h-control-sm'), 'the default group is on the sm control step')
  assert.ok(!quiet.includes('h-control-sm'), 'quiet leaves the control step')
  assert.ok(
    quiet.includes('h-[var(--hit-target-min)]'),
    'quiet is the hit-target floor, from the token — never a bare pixel height',
  )
})

run('quiet keeps the internal hairline — it is what says one object, two halves', () => {
  for (const quiet of [true, false]) {
    const [primary, chevron] = halves(group({ quiet }))
    const primaryClass = primary.getAttribute('class') ?? ''
    const chevronClass = chevron.getAttribute('class') ?? ''
    assert.ok(chevronClass.includes('border-l'), `quiet=${quiet}: the menu half keeps the hairline`)
    assert.ok(
      chevronClass.includes('--border-subtle'),
      `quiet=${quiet}: the hairline is the subtle border token`,
    )
    assert.ok(!primaryClass.includes('border-l'), `quiet=${quiet}: only one hairline, and it is the seam`)
  }
})

run('quiet changes no state treatment: hover, held-open and the inset focus ring survive', () => {
  for (const quiet of [true, false]) {
    for (const half of halves(group({ quiet }))) {
      const className = half.getAttribute('class') ?? ''
      assert.ok(className.includes('hover:bg-[color:var(--bg-hover)]'), `quiet=${quiet}: the half fills on hover`)
      assert.ok(className.includes('focus-ring'), `quiet=${quiet}: the half draws the shared focus ring`)
      assert.ok(className.includes('focus-ring-inset'), `quiet=${quiet}: inset, because the group clips its overflow`)
    }
    const node = group({ quiet })
    assert.ok(node.getAttribute('class')?.includes('overflow-hidden'), `quiet=${quiet}: the group still clips`)
    const chevron = halves(node)[1]
    assert.equal(chevron.getAttribute('aria-haspopup'), 'menu', `quiet=${quiet}: the menu half still announces its menu`)
    assert.equal(chevron.getAttribute('aria-expanded'), 'false', `quiet=${quiet}: and its live expanded state`)
  }
})

run('both halves stay real buttons in both variants', () => {
  for (const quiet of [true, false]) {
    const buttons = halves(group({ quiet }))
    assert.equal(buttons.length, 2, `quiet=${quiet}: two halves, both in the tab order`)
    assert.equal(buttons[0].getAttribute('aria-label'), 'Open in VS Code')
    assert.equal(buttons[1].getAttribute('aria-label'), 'Open in…')
    for (const button of buttons) assert.equal(button.getAttribute('type'), 'button')
  }
})

run('a disabled quiet group disables both halves', () => {
  const buttons = halves(group({ quiet: true, disabled: true }))
  assert.equal(buttons.length, 2)
  for (const button of buttons) {
    assert.ok(button.hasAttribute('disabled'), 'a live primary beside a dead menu reads as a bug')
  }
})

// One target is not a split button (Usage: "keep the menu at two or more rows;
// one alternative is a plain button"), and the component holds that rule itself
// rather than asking every caller to. What matters is that the lone arm is the
// SAME half in the SAME group chrome: the conversation peek's pull request mark
// is one or several depending on what the conversation did, and its solo arm
// used to be a text link that lost the 24px floor and the hover fill.
run('fewer than two targets draw the primary half alone, in the same chrome', () => {
  const solo = group({ quiet: true, items: [{ id: 'vscode', label: 'VS Code', onSelect: () => {} }] })
  const pair = group({ quiet: true })
  const buttons = halves(solo)
  assert.equal(buttons.length, 1, 'no chevron over a menu with one row in it')
  assert.equal(solo.querySelector('[aria-haspopup="menu"]'), null, 'and nothing announcing a menu')
  assert.equal(
    solo.getAttribute('class')?.trim(),
    pair.getAttribute('class')?.trim(),
    'the same group: the hit-target floor, the chip radius, the overflow clip',
  )
  assert.equal(
    buttons[0].getAttribute('class'),
    halves(pair)[0].getAttribute('class'),
    'and the same half inside it',
  )
  assert.equal(buttons[0].getAttribute('aria-label'), 'Open in VS Code')
  assert.equal(halves(group({ items: [] })).length, 1, 'no targets at all is the same shape')
})

run('one ALTERNATIVE still earns the caret, where one target does not', () => {
  // The 2026-09-10 ruling (design-system/components/split-button → Usage). The
  // floor above is about TARGETS — choosing one re-points the primary, so a list
  // of one has nothing to choose. An alternative is a different route to the
  // SAME outcome and can never become the primary, so the count was never what
  // made the menu worth opening: Settings › Remote's "Pair a device" would
  // otherwise lose "Paste a pairing link" entirely, or promote it to a second
  // competing verb on the section header.
  const one = [{ id: 'paste', label: 'Paste a pairing link', onSelect: () => {} }]
  const alternatives = group({ items: one, menuKind: 'alternatives' })
  const buttons = halves(alternatives)
  assert.equal(buttons.length, 2, 'the caret survives a one-row alternatives menu')
  assert.ok(
    alternatives.querySelector('[aria-haspopup="menu"]'),
    'and it is a real menu button, not a chevron-shaped decoration',
  )

  assert.equal(
    halves(group({ items: one })).length,
    1,
    'the default is unchanged: one TARGET is still the primary half alone',
  )
  assert.equal(
    halves(group({ items: [], menuKind: 'alternatives' })).length,
    1,
    'and an EMPTY menu has no exemption — a chevron over nothing opens to say nothing',
  )

  assert.equal(
    alternatives.getAttribute('class')?.trim(),
    group({}).getAttribute('class')?.trim(),
    'same group chrome either way — menuKind is a rule about rows, not a restyle',
  )
})

run('the primary half carries the host surface’s own marker when it is given one', () => {
  const marked = group({
    quiet: true,
    primaryData: { name: 'data-pull-request-mark', value: 'https://github.com/acme/app/pull/418' },
  })
  for (const items of [undefined, [{ id: 'one', label: 'One', onSelect: () => {} }]]) {
    const node = items ? group({ quiet: true, items, primaryData: { name: 'data-pull-request-mark', value: 'x' } }) : marked
    const primary = halves(node)[0]
    assert.ok(primary.hasAttribute('data-pull-request-mark'), 'on the half that is pressed, either shape')
  }
})

if (failures > 0) throw new Error(`${failures} SplitButton contract(s) failed`)
console.log('ok - SplitButton: the quiet variant takes chrome away and nothing else')
