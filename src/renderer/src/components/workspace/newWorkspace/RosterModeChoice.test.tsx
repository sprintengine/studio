import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { RosterModeChoice } from './WizardControls'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// The disabled architect radio is the second role="radio" button; its markup
// carries the `disabled` attribute renderToStaticMarkup emits for a disabled
// <button>. Assert on the whole fragment for copy and on the disabled attr.
function render(props: {
  value: 'user' | 'architect'
  architectAvailable: boolean
  architectDisabledHint?: string
}): string {
  return renderToStaticMarkup(
    <RosterModeChoice
      value={props.value}
      onChange={() => {}}
      architectAvailable={props.architectAvailable}
      architectDisabledHint={props.architectDisabledHint}
    />,
  )
}

run('renders both mode options with exact copy', () => {
  const html = render({ value: 'user', architectAvailable: true })
  assert.ok(html.includes('Pick the team yourself'))
  assert.ok(html.includes('Architect picks the team'))
})

run('architect option is enabled when a catalog model is available', () => {
  const html = render({ value: 'user', architectAvailable: true })
  // Only the enabled hint shows; no button carries the disabled attribute.
  // (className has Tailwind `disabled:` variants, so match the emitted attr.)
  assert.ok(html.includes('surveys the work'))
  assert.ok(!html.includes('disabled=""'))
})

run('AC3: empty-catalog cause shows its verbatim disabled hint on a disabled option', () => {
  const html = render({
    value: 'user',
    architectAvailable: false,
    architectDisabledHint: 'Add at least one model to your catalog in Settings',
  })
  assert.ok(html.includes('disabled=""'), 'architect radio is disabled when unavailable')
  assert.ok(html.includes('Add at least one model to your catalog in Settings'))
  // The wrong cause's copy must not leak in.
  assert.ok(!html.includes('No catalog model'))
})

run('AC3: all-CLIs-uninstalled cause shows its verbatim disabled hint', () => {
  const html = render({
    value: 'user',
    architectAvailable: false,
    architectDisabledHint: 'No catalog model’s CLI is installed',
  })
  assert.ok(html.includes('disabled=""'))
  assert.ok(html.includes('No catalog model’s CLI is installed'))
  assert.ok(!html.includes('Add at least one model to your catalog'))
})

console.log('all RosterModeChoice render tests passed')
