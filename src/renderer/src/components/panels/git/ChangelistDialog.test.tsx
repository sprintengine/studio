import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChangelistDialog, type ChangelistDialogProps } from './ChangelistDialog'

// New changelist… / Edit changelist… (epic `git-commit-window`, T6; adversarial
// review). SSR, because everything asserted here is in the first paint: which
// fields exist, what the dialog is called, and — the reason this file exists —
// that the activate checkbox has ONE label rather than a kit `<label>` nested
// inside a hand-written one.

const dom = new JSDOM('<!doctype html><html><body></body></html>')

const NOOP = (): void => {}

function render(over: Partial<ChangelistDialogProps> = {}): Element {
  const props: ChangelistDialogProps = {
    open: true,
    mode: 'new',
    initial: { name: '', comment: '', activate: false },
    onCancel: NOOP,
    onSubmit: NOOP,
    ...over,
  }
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(React.createElement(ChangelistDialog, props))
  const dialog = host.querySelector('[role="dialog"]')
  assert.ok(dialog, 'the dialog rendered nothing')
  return dialog
}

// ── one label per control ────────────────────────────────────────────────────
{
  const dialog = render()
  const checkbox = dialog.querySelector('input[type="checkbox"]')
  assert.ok(checkbox, 'the "make this active" question is asked on `new`')

  const labels = Array.from(dialog.querySelectorAll('label'))
  const owning = labels.filter((label) => label.contains(checkbox!))
  assert.equal(owning.length, 1, 'the kit Checkbox IS the label — a second one around it nests two')
  assert.equal(
    owning[0].textContent?.trim(),
    'Make this the active changelist',
    'and the words are the label’s own, not a sibling the input never knew about',
  )
  assert.equal(checkbox!.getAttribute('aria-label'), null, 'no second accessible name: the visible label is the name')
}

// ── what each mode asks ──────────────────────────────────────────────────────
{
  const created = render()
  assert.match(created.textContent ?? '', /New changelist/)
  assert.equal(created.querySelectorAll('input[type="checkbox"]').length, 1)

  const edited = render({ mode: 'edit', initial: { name: 'Spike', comment: 'the spike', activate: true } })
  assert.match(edited.textContent ?? '', /Edit changelist/)
  assert.equal(
    edited.querySelectorAll('input[type="checkbox"]').length,
    0,
    'an existing list is made active from the menu, beside the lists it is exclusive with',
  )
  assert.equal(
    (edited.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null)?.getAttribute('value'),
    'Spike',
    'and it opens on the list it is editing',
  )
}

// ── the name field offers an example of something ────────────────────────────
{
  const dialog = render()
  const name = dialog.querySelector('input:not([type="checkbox"])')
  assert.equal(
    name?.getAttribute('placeholder'),
    'Feature name',
    'not "Modal header group", which was a stray from another form',
  )
  assert.equal(dialog.querySelector('textarea')?.getAttribute('placeholder'), 'What this set of changes is')
}

// ── closed is closed ─────────────────────────────────────────────────────────
{
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    React.createElement(ChangelistDialog, {
      open: false,
      mode: 'new' as const,
      initial: { name: '', comment: '', activate: false },
      onCancel: NOOP,
      onSubmit: NOOP,
    }),
  )
  assert.equal(host.innerHTML, '', 'a closed dialog mounts no scrim and no aria-modal')
}

console.log('ok - the changelist dialog asks two questions and labels its checkbox once')
