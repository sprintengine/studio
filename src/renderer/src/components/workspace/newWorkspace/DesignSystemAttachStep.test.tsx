import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DESIGN_SYSTEM_ATTACHED_PROMPT_LINE,
  type DesignSystemAttachSource,
} from '../../../../../shared/design-system/attach'
import {
  buildDesignSystemKnowledgeNote,
  clearStaleAttachSelection,
  DesignSystemAttachStep,
  FOLDER_ATTACH_TRUST_COPY,
} from './DesignSystemAttachStep'

// Static-markup contract for the attach picker's initial render (effects do
// not run here, so this is the pre-IPC state: library loading, no conflict).
// The rows are aria-pressed toggle buttons in a labelled group — not
// role="radio", which would promise arrow-key movement the Tab-navigated rows
// don't have (T15; the same pattern the retired New workspace hub's GuidedChoiceCard used).

// AC (keyboard-navigable picker with visible focus): the choices are a labeled
// group of native aria-pressed buttons with the shared focus-visible ring.
const initialHtml = renderToStaticMarkup(
  <DesignSystemAttachStep workspaceRoot="/repo" selection={null} onSelect={() => {}} />,
)
assert.match(initialHtml, /role="group"/, 'choices form a labelled group')
assert.match(initialHtml, /aria-label="Design system to attach"/, 'group is labeled')
assert.match(initialHtml, /aria-pressed=/, 'each choice row is an aria-pressed toggle')
assert.doesNotMatch(initialHtml, /role="radio(group)?"/, 'rows no longer claim radio semantics')
assert.match(initialHtml, /focus-visible:focus-ring/, 'rows carry the visible focus indicator')
assert.ok(initialHtml.includes('type="button"'), 'rows are native buttons (Tab/Enter/Space)')
assert.ok(initialHtml.includes('Reading your library'), 'library load state is explicit')
assert.ok(initialHtml.includes('Browse to a bundle folder'), 'browse-to-folder is always offered')

// Null selection reads as "None" pressed; every other row unpressed.
assert.match(initialHtml, /aria-pressed="true"[^>]*>[^<]*<[^>]*>None/s, 'null selection presses the None row')

// A committed folder selection is reflected: that row is pressed, shows the
// path, and the swap affordance appears.
const folderHtml = renderToStaticMarkup(
  <DesignSystemAttachStep
    workspaceRoot="/repo"
    selection={{ kind: 'folder', path: '/bundles/acme' }}
    onSelect={() => {}}
  />,
)
assert.ok(folderHtml.includes('/bundles/acme'), 'folder selection shows the chosen path')
assert.ok(folderHtml.includes('Choose a different folder'), 'folder selection offers a swap')
const pressedCount = (folderHtml.match(/aria-pressed="true"/g) ?? []).length
assert.equal(pressedCount, 1, 'exactly one row is pressed')

// Trust-transfer copy (T20, T16 F2 mitigation): attaching an arbitrary folder
// hands its prose authorship of agent context, so the browse-to-folder row and
// the folder-selected state carry the warning — exactly once per render,
// proving it sits only on the browse/folder row and never on other rows.
const countTrustCopy = (html: string) => html.split(FOLDER_ATTACH_TRUST_COPY).length - 1
assert.equal(countTrustCopy(initialHtml), 1, 'browse row carries the trust-transfer copy once')
assert.equal(countTrustCopy(folderHtml), 1, 'folder-selected state carries the trust-transfer copy once')

// Stale-selection clearing (T15): a selection made before the conflict
// pre-check trips would ride into a folder attach refuses, with the picker
// withheld and no way to unselect. The decision lives in
// clearStaleAttachSelection, wired from the pre-check effect.
{
  const calls: Array<unknown> = []
  const onSelect = (source: unknown) => calls.push(source)
  // A library selection is a REGISTRATION ID now (item 2004): the library is a
  // registry of paths, and two cloned repos can hold the same name@version.
  const selection: DesignSystemAttachSource = { kind: 'library', id: 'f6a9ae4a' }

  clearStaleAttachSelection({ existingBundle: true, selection, onSelect })
  assert.deepEqual(calls, [null], 'conflict + selection clears to null')

  calls.length = 0
  clearStaleAttachSelection({ existingBundle: true, selection: null, onSelect })
  assert.equal(calls.length, 0, 'conflict with nothing selected is a no-op')

  clearStaleAttachSelection({ existingBundle: false, selection, onSelect })
  assert.equal(calls.length, 0, 'no conflict keeps the selection')

  clearStaleAttachSelection({ existingBundle: null, selection, onSelect })
  assert.equal(calls.length, 0, 'pre-check still running keeps the selection')
}

// Source contracts for the two clearing layers (effects do not run under
// renderToStaticMarkup, so assert the wiring in source):
// 1. The attach step calls clearStaleAttachSelection from an effect keyed on
//    the pre-check result and the selection.
const stepSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/newWorkspace/DesignSystemAttachStep.tsx'),
  'utf8',
)
assert.match(
  stepSource,
  /useEffect\(\(\) => \{\s*clearStaleAttachSelection\(\{ existingBundle, selection, onSelect \}\)\s*\}, \[existingBundle, selection, onSelect\]\)/,
  'attach step wires clearStaleAttachSelection from the pre-check effect',
)
// Library rows never carry the trust-transfer copy: they were authored on this
// machine, and their detail line is the entry summary alone. (Effects do not
// run under renderToStaticMarkup, so library rows are asserted in source.)
assert.match(
  stepSource,
  /detail=\{entry\.summary\}/,
  'library rows take their detail from the entry summary alone — no trust-transfer copy',
)
// 2. (Retired 2026-09-04 with the New workspace hub: the wizard that reset the
//    selection on a folder change is gone; the step's only host is now the
//    Design settings tab, which is scoped to one project.)

// KG pointer note is composed from the shared launch-line contract so the
// note and the injected prompt line can never drift.
const note = buildDesignSystemKnowledgeNote('acme', '1.2.0')
assert.ok(note.includes('acme@1.2.0'), 'note names the attached bundle release')
assert.ok(note.includes(DESIGN_SYSTEM_ATTACHED_PROMPT_LINE), 'note body carries the shared prompt-line contract')
assert.ok(note.startsWith('# Design system'), 'note is a titled markdown document')

console.log('DesignSystemAttachStep.test.tsx: ok')
