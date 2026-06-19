import assert from 'node:assert/strict'

import { automationCliFieldError, automationCliSelectItems } from './automationsFormat'
import type { AgentCliCatalogOption } from '../../workspace/newWorkspace/cliRuntimeOptions'

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

// The picker catalog the editor reuses — codex + claude-code, never the hidden
// `generic-shell` id from the T7 finding.
const CATALOG: AgentCliCatalogOption[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
]

run('rejects an unlaunchable cli the picker never offers (the T7 generic-shell case)', () => {
  const error = automationCliFieldError('generic-shell', CATALOG, true)
  assert.ok(error, 'a value outside the picker catalog is rejected, not silently accepted')
  assert.match(error!, /generic-shell/, 'the message names the offending cli')
})

run('accepts a cli the picker actually offers', () => {
  assert.equal(automationCliFieldError('codex', CATALOG, true), null)
  assert.equal(automationCliFieldError('claude-code', CATALOG, true), null)
})

run('treats empty/whitespace cli as valid — the executor falls back to the selected CLI', () => {
  assert.equal(automationCliFieldError(undefined, CATALOG, true), null)
  assert.equal(automationCliFieldError('', CATALOG, true), null)
  assert.equal(automationCliFieldError('   ', CATALOG, true), null)
})

run('does not reject while the registry is still loading (catalog not ready)', () => {
  // A still-installing custom CLI must not be flagged before the registry
  // resolves; the constraint enforces only against a ready catalog.
  assert.equal(automationCliFieldError('some-installing-cli', CATALOG, false), null)
})

run('select items lead with a default entry and list the picker catalog', () => {
  const items = automationCliSelectItems(undefined, CATALOG)
  assert.equal(items[0]?.value, '', 'first item is the empty default')
  assert.deepEqual(
    items.slice(1).map((i) => i.value),
    ['codex', 'claude-code'],
    'the picker catalog follows, in order',
  )
  assert.ok(!items.some((i) => i.disabled), 'no unavailable entry when the value is valid')
})

run('surfaces a stale unavailable cli as a disabled, warn-toned trailing item', () => {
  const items = automationCliSelectItems('generic-shell', CATALOG)
  const stale = items.find((i) => i.value === 'generic-shell')
  assert.ok(stale, 'the stored unlaunchable value is still shown, not hidden')
  assert.equal(stale!.disabled, true, 'it cannot be re-selected')
  assert.match(stale!.label, /unavailable/, 'it is labelled unavailable, distinct from a valid choice')
  assert.equal(stale!.tone, 'warn')
})

run('does not duplicate a valid cli as an unavailable entry', () => {
  const items = automationCliSelectItems('codex', CATALOG)
  assert.equal(items.filter((i) => i.value === 'codex').length, 1)
  assert.ok(!items.some((i) => i.disabled))
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall automation cli-field tests passed')
