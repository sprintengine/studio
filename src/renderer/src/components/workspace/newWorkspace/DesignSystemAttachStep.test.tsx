import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { DESIGN_SYSTEM_ATTACHED_PROMPT_LINE } from '../../../../../shared/design-system/attach'
import { buildDesignSystemKnowledgeNote, DesignSystemAttachStep } from './DesignSystemAttachStep'

// Static-markup contract for the attach picker's initial render (effects do
// not run here, so this is the pre-IPC state: library loading, no conflict).
// Mirrors ModeCard.test.tsx — the wizard's radio-row convention is the
// keyboard/a11y surface the acceptance criteria name.

// AC (keyboard-navigable picker with visible focus): the choices are a labeled
// radiogroup of native buttons with the shared focus-visible ring.
const initialHtml = renderToStaticMarkup(
  <DesignSystemAttachStep workspaceRoot="/repo" selection={null} onSelect={() => {}} />,
)
assert.match(initialHtml, /role="radiogroup"/, 'choices form a radiogroup')
assert.match(initialHtml, /aria-label="Design system to attach"/, 'radiogroup is labeled')
assert.match(initialHtml, /role="radio"/, 'each choice row is a radio')
assert.match(initialHtml, /focus-visible:ring-2/, 'rows carry the visible focus ring')
assert.ok(initialHtml.includes('type="button"'), 'rows are native buttons (Tab/Enter/Space)')
assert.ok(initialHtml.includes('Reading your library'), 'library load state is explicit')
assert.ok(initialHtml.includes('Browse to a bundle folder'), 'browse-to-folder is always offered')

// Null selection reads as "None" checked; every other row unchecked.
assert.match(initialHtml, /aria-checked="true"[^>]*>[^<]*<[^>]*>None/s, 'null selection checks the None row')

// A committed folder selection is reflected: that row is checked, shows the
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
const checkedCount = (folderHtml.match(/aria-checked="true"/g) ?? []).length
assert.equal(checkedCount, 1, 'exactly one row is checked')

// KG pointer note is composed from the shared launch-line contract so the
// note and the injected prompt line can never drift.
const note = buildDesignSystemKnowledgeNote('acme', '1.2.0')
assert.ok(note.includes('acme@1.2.0'), 'note names the attached bundle release')
assert.ok(note.includes(DESIGN_SYSTEM_ATTACHED_PROMPT_LINE), 'note body carries the shared prompt-line contract')
assert.ok(note.startsWith('# Design system'), 'note is a titled markdown document')

console.log('DesignSystemAttachStep.test.tsx: ok')
