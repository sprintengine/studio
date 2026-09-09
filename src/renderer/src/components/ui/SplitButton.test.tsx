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

function group(props: { quiet?: boolean; disabled?: boolean }): Element {
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

if (failures > 0) throw new Error(`${failures} SplitButton contract(s) failed`)
console.log('ok - SplitButton: the quiet variant takes chrome away and nothing else')
