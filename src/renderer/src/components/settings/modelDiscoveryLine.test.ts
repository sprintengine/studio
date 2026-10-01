import assert from 'node:assert/strict'

import { test } from 'vitest'
import { modelDiscoveryLine } from './modelDiscoveryLine'

const now = Date.parse('2026-09-22T12:00:00Z')
const catalog = (models: { id: string }[], cliVersion?: string) => ({
  models,
  fetchedAt: '2026-09-22T11:58:00Z',
  source: 'agent-sdk' as const,
  ...(cliVersion ? { cliVersion } : {}),
})

test('a CLI that answered names itself, its version and when it was asked', () => {
  assert.equal(
    modelDiscoveryLine({ name: 'Claude Code', catalog: catalog([{ id: 'opus' }], '2.1.280'), now }),
    'Models from Claude Code 2.1.280, checked 2m ago',
  )
  assert.equal(
    modelDiscoveryLine({ name: 'Grok', catalog: catalog([{ id: 'grok-4' }]), now }),
    'Models from Grok, checked 2m ago',
    'no version reported, no version shown',
  )
})

test('no answer yet, or an empty one, is this build’s list', () => {
  assert.equal(modelDiscoveryLine({ name: 'Codex', catalog: undefined, now }), 'Models from this build')
  assert.equal(modelDiscoveryLine({ name: 'Codex', catalog: catalog([]), now }), 'Models from this build')
})

test('a failed probe says so, even over a last good list', () => {
  assert.equal(
    modelDiscoveryLine({
      name: 'Codex',
      catalog: catalog([{ id: 'gpt-5.5' }], '0.153.3'),
      error: 'the probe timed out after 20 s',
      now,
    }),
    "Could not read Codex's models: the probe timed out after 20 s",
  )
  assert.equal(
    modelDiscoveryLine({ name: 'Codex', catalog: undefined, error: '   ', now }),
    'Models from this build',
    'a blank error is no error',
  )
})
