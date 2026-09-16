import assert from 'node:assert/strict'

import { automationCliFieldError } from './automationsFormat'
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
  const error = automationCliFieldError('generic-shell', CATALOG)
  assert.ok(error, 'a value outside the picker catalog is rejected, not silently accepted')
  assert.match(error!, /generic-shell/, 'the message names the offending cli')
})

run('accepts a cli the picker actually offers', () => {
  assert.equal(automationCliFieldError('codex', CATALOG), null)
  assert.equal(automationCliFieldError('claude-code', CATALOG), null)
})

run('treats empty/whitespace cli as valid — the executor falls back to the selected CLI', () => {
  assert.equal(automationCliFieldError(undefined, CATALOG), null)
  assert.equal(automationCliFieldError('', CATALOG), null)
  assert.equal(automationCliFieldError('   ', CATALOG), null)
})

run('fails closed: a stale generic-shell is rejected against the not-ready/error fallback catalog', () => {
  // `selectAgentCliCatalog` never returns an empty catalog while the plugin
  // registry is loading or after a load error — it falls back to the bundled
  // codex/claude-code options, the same set the picker offers, and never the
  // hidden generic-shell id. So the validator's caller always passes a
  // populated catalog and a stale unlaunchable value is blocked in every
  // registry state, not silently saved during the loading/error window.
  const fallbackCatalog: AgentCliCatalogOption[] = [
    { value: 'codex', label: 'Codex' },
    { value: 'claude-code', label: 'Claude Code' },
  ]
  const error = automationCliFieldError('generic-shell', fallbackCatalog)
  assert.ok(error, 'generic-shell stays blocked even on the loading/error fallback catalog')
  assert.match(error!, /generic-shell/, 'the message names the offending cli')
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`)
  process.exit(1)
}
console.log('\nall automation cli-field tests passed')
