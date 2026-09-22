// The fixtures are the real output of each CLI on a development machine,
// captured 2026-09-22 (codex-cli 0.155.1, cursor-agent 2026.09.15, grok 1.0.25,
// opencode 1.18.30). The Codex JSON is trimmed to the fields the parser reads
// plus a couple it ignores; its rows are untouched.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  CLI_MODEL_PROBES,
  parseCodexDebugModels,
  parseCursorListModels,
  parseGrokModels,
  parseOpenCodeModels,
} from './probes'
import { CliModelProbeError, type ArgvRunOutcome, type CliModelProbeContext } from './probe-types'

const FIXTURES = join(process.cwd(), 'src', 'main', 'model-discovery', '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

test('Codex: hidden rows are dropped and the rest follow priority, ties in printed order', () => {
  const models = parseCodexDebugModels(fixture('codex-debug-models.json'))
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  )
  assert.equal(
    models.some((model) => model.id === 'gpt-reserve' || model.id === 'codex-auto-review'),
    false,
  )
})

test('Codex: a row carries the label, description, effort levels, default effort and fast tier Codex reports', () => {
  const [astra, , luna] = parseCodexDebugModels(fixture('codex-debug-models.json'))
  assert.deepEqual(astra, {
    id: 'gpt-6-astra',
    displayName: 'GPT-6-Astra',
    description: 'Our most capable model for complex, demanding work.',
    contextWindow: 272000,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
    supportsFastMode: true,
  })
  assert.deepEqual(luna.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('Codex: priority orders even when the JSON does not, and a missing speed tier list says nothing', () => {
  const models = parseCodexDebugModels(
    JSON.stringify({
      models: [{ slug: 'b', priority: 2 }, { slug: 'a', priority: 1, additional_speed_tiers: [] }, { slug: 'c' }],
    }),
  )
  assert.deepEqual(models, [{ id: 'a', supportsFastMode: false }, { id: 'b' }, { id: 'c' }])
})

test('Codex: output that is not the catalog is a failure, not an empty list', () => {
  assert.throws(() => parseCodexDebugModels('error: not logged in'), CliModelProbeError)
  assert.throws(() => parseCodexDebugModels('{"data": []}'), CliModelProbeError)
})

test('Cursor: every `id - label` row under the heading, in order, and nothing after the blank line', () => {
  const models = parseCursorListModels(fixture('cursor-list-models.txt'))
  assert.equal(models.length, 241)
  assert.deepEqual(models[0], { id: 'auto', displayName: 'Auto' }, 'the default marker is not part of the label')
  assert.deepEqual(models[1], { id: 'gpt-5.3-codex-low', displayName: 'Codex 5.3 Low' })
  assert.deepEqual(models.at(-1), { id: 'glm-5.2-max', displayName: 'GLM 5.2 Max' })
  assert.equal(
    models.some((model) => model.id === 'Tip:'),
    false,
  )
})

test('Cursor: invisible padding and doubled spaces do not reach the label', () => {
  const models = parseCursorListModels(fixture('cursor-list-models.txt'))
  const lowFast = models.find((model) => model.id === 'grok-4.7-low-fast')
  assert.deepEqual(lowFast, { id: 'grok-4.7-low-fast', displayName: 'Grok 4.7 Low Fast' })
})

test('Cursor: no heading means no list', () => {
  assert.throws(() => parseCursorListModels('Please log in with `cursor-agent login`.\n'), CliModelProbeError)
})

test('Grok: the default row and the rest, ids only, whether or not signed in', () => {
  assert.deepEqual(parseGrokModels(fixture('grok-models.txt')), [{ id: 'grok-4.6' }, { id: 'grok-4.5' }])
  assert.throws(() => parseGrokModels('You are not authenticated.\n'), CliModelProbeError)
})

test('OpenCode: one provider/model id per line; an empty answer is a failure', () => {
  assert.deepEqual(
    parseOpenCodeModels(fixture('opencode-models.txt')).map((model) => model.id),
    [
      'opencode/big-pickle',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/muse-spark-1.2-contributor-free',
      'opencode/muse-spark-1.3-contributor-free',
      'opencode/nemotron-3-ultra-free',
      'opencode/nemotron-3.5-lightning-free',
    ],
  )
  assert.throws(() => parseOpenCodeModels(''), CliModelProbeError)
  assert.throws(() => parseOpenCodeModels('\n\n'), CliModelProbeError)
})

function context(outcome: ArgvRunOutcome, calls: string[][] = []): CliModelProbeContext {
  return {
    cli: 'codex',
    displayName: 'Codex',
    binary: '/Users/dev/.local/bin/codex',
    useWsl: false,
    timeoutMs: 20_000,
    runArgv: async (args) => {
      calls.push(args)
      return outcome
    },
  }
}

test('the registry runs each CLI with its own listing arguments', async () => {
  const calls: string[][] = []
  const ok = { code: 0, stdout: fixture('codex-debug-models.json'), stderr: '', timedOut: false }
  const models = await CLI_MODEL_PROBES.codex.run(context(ok, calls))
  assert.equal(models.length, 7)
  assert.deepEqual(calls, [['debug', 'models']])
  assert.equal(CLI_MODEL_PROBES.codex.source, 'argv-probe')
  assert.equal(CLI_MODEL_PROBES['claude-code'].source, 'agent-sdk')
  assert.deepEqual(Object.keys(CLI_MODEL_PROBES).sort(), ['claude-code', 'codex', 'cursor', 'grok', 'opencode'])
})

test('a timeout or a failing exit is a sentence, never an empty catalog', async () => {
  await assert.rejects(
    CLI_MODEL_PROBES.opencode.run({
      ...context({ code: 3, stdout: '', stderr: 'probe timed out', timedOut: true }),
      displayName: 'OpenCode',
      binary: '/Users/dev/.opencode/bin/opencode',
    }),
    (error: unknown) =>
      error instanceof CliModelProbeError && error.message === 'OpenCode did not answer `opencode models` within 20 s.',
  )
  await assert.rejects(
    CLI_MODEL_PROBES.codex.run(context({ code: 1, stdout: '', stderr: 'Error: not logged in\nmore', timedOut: false })),
    (error: unknown) =>
      error instanceof CliModelProbeError &&
      error.message === '`codex debug models` exited with code 1: Error: not logged in',
  )
})
