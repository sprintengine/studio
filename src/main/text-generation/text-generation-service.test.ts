import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CliDetectResult } from '../../shared/electron-api'
import type { CommandRun, CommandRunInput } from './run-command'
import { generateChatTitle, type TextGenerationServiceDeps } from './text-generation-service'

const tests: Array<{ name: string; body: () => Promise<void> }> = []
function run(name: string, body: () => Promise<void>): void {
  tests.push({ name, body })
}

function detected(cli: string, overrides: Partial<CliDetectResult> = {}): CliDetectResult {
  return {
    cli,
    binary: cli === 'claude-code' ? 'claude' : cli,
    installed: true,
    version: '1.0.0',
    resolvedPath: cli === 'claude-code' ? '/bin/claude' : '/bin/codex',
    useWsl: false,
    error: null,
    ...overrides,
  }
}

function ok(stdout: string, extra: Partial<CommandRun> = {}): CommandRun {
  return { code: 0, stdout, stderr: '', timedOut: false, spawnError: null, ...extra }
}

const claudeEnvelope = (title: string): string =>
  JSON.stringify({ type: 'result', is_error: false, structured_output: { title } })

function deps(overrides: Partial<TextGenerationServiceDeps> & { runs?: CommandRunInput[] } = {}): TextGenerationServiceDeps & { runs: CommandRunInput[] } {
  const runs: CommandRunInput[] = overrides.runs ?? []
  return {
    detect: async (cli) => detected(cli),
    env: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://x', HOME: '/home' }),
    run: async (input) => {
      runs.push(input)
      return ok(claudeEnvelope('Sidebar flicker on switch'))
    },
    now: (() => {
      let tick = 0
      return () => (tick += 1000)
    })(),
    ...overrides,
    runs,
  }
}

const claudeEngine = { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' }
const codexEngine = { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'low' }

run('a CLI with no backend is refused before anything is probed', async () => {
  let probed = false
  const result = await generateChatTitle(
    { prompt: 'hello', engine: { cli: 'cursor', model: 'auto' } },
    deps({ detect: async (cli) => { probed = true; return detected(cli) } }),
  )
  assert.deepEqual(result, { ok: false, code: 'unsupported', message: 'cursor has no text generation backend.' })
  assert.equal(probed, false)
})

run('an empty model is refused', async () => {
  const result = await generateChatTitle({ prompt: 'hello', engine: { cli: 'codex', model: '  ' } }, deps())
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, 'unsupported')
})

run('an uninstalled or unprobeable CLI is unavailable, and nothing runs', async () => {
  const d = deps({ detect: async (cli) => detected(cli, { installed: false, resolvedPath: null }) })
  const missing = await generateChatTitle({ prompt: 'hello', engine: claudeEngine }, d)
  assert.deepEqual(missing, { ok: false, code: 'unavailable', message: 'claude-code is not installed on this machine.' })
  assert.equal(d.runs.length, 0)

  const errored = await generateChatTitle(
    { prompt: 'hello', engine: claudeEngine },
    deps({ detect: async (cli) => detected(cli, { installed: false, error: 'shell spawn failed' }) }),
  )
  assert.equal(!errored.ok && errored.code, 'unavailable')
  assert.match(!errored.ok ? errored.message : '', /could not be probed/)
})

run('claude: probed path, scratch cwd, prompt on stdin, auth env stripped, title guarded', async () => {
  const d = deps()
  const result = await generateChatTitle({ prompt: 'so basically fix the sidebar', engine: claudeEngine, timeoutMs: 1234 }, d)
  assert.deepEqual(result, { ok: true, value: 'Sidebar flicker on switch', ms: 1000 })
  assert.equal(d.runs.length, 1)
  const call = d.runs[0]!
  assert.equal(call.file, '/bin/claude', 'the probe path is what runs')
  assert.ok(call.cwd.includes('sprintengine-text-'), 'runs in a scratch directory, not a checkout')
  assert.ok(call.stdin.endsWith('User message:\nso basically fix the sidebar'), 'the prompt rides stdin')
  assert.equal(call.timeoutMs, 1234)
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined, 'no API key reaches claude')
  assert.equal(call.env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(call.env.MAX_THINKING_TOKENS, '0', 'thinking is off: a title is not a reasoning task')
  assert.equal(call.env.PATH, '/bin')
  assert.equal(call.env.HOME, '/home')
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-haiku-4-5')
})

run('claude: a bare binary name is used when the probe resolved no path', async () => {
  const d = deps({ detect: async (cli) => detected(cli, { resolvedPath: null }) })
  await generateChatTitle({ prompt: 'x', engine: claudeEngine }, d)
  assert.equal(d.runs[0]!.file, 'claude')
})

run('codex: schema written to scratch, last message read back, env left alone', async () => {
  const d = deps({
    run: async (input) => {
      d.runs.push(input)
      const outputPath = input.args[input.args.indexOf('--output-last-message') + 1]!
      const schemaPath = input.args[input.args.indexOf('--output-schema') + 1]!
      const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as { required?: string[] }
      assert.deepEqual(schema.required, ['title'], 'the schema file is the chat-title schema')
      await writeFile(outputPath, '{"title":"Fix Mobile Sidebar Flicker"}\n', 'utf8')
      return ok('')
    },
  })
  const result = await generateChatTitle({ prompt: 'fix the flicker', engine: codexEngine }, d)
  assert.deepEqual(result, { ok: true, value: 'Fix Mobile Sidebar Flicker', ms: 1000 })
  const call = d.runs[0]!
  assert.equal(call.file, '/bin/codex')
  assert.equal(call.args[0], 'exec')
  assert.equal(call.env.ANTHROPIC_API_KEY, 'sk-secret', 'codex has no subscription/API split to guard')
  assert.equal(call.env.MAX_THINKING_TOKENS, undefined, 'the claude-only thinking switch stays off codex')
  assert.ok(call.args[call.args.indexOf('--output-schema') + 1]!.startsWith(call.cwd), 'schema lives in the scratch dir')
})

run('the scratch directory is removed after every outcome', async () => {
  const scratchRoot = await mkdtemp(path.join(tmpdir(), 'tg-test-'))
  try {
    await generateChatTitle({ prompt: 'x', engine: claudeEngine }, deps({ scratchRoot }))
    await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ scratchRoot, run: async () => ok('', { code: 2, stderr: 'boom' }) }),
    )
    await generateChatTitle(
      { prompt: 'x', engine: claudeEngine },
      deps({ scratchRoot, run: async () => { throw new Error('exploded') } }),
    )
    assert.deepEqual(await readdir(scratchRoot), [], 'nothing left behind')
  } finally {
    await rm(scratchRoot, { recursive: true, force: true })
  }
})

run('failures are typed, never thrown', async () => {
  const timeout = await generateChatTitle(
    { prompt: 'x', engine: claudeEngine },
    deps({ run: async () => ok('', { timedOut: true, code: null }) }),
  )
  assert.deepEqual(timeout, { ok: false, code: 'timeout', message: 'claude-code did not answer in time.' })

  const spawn = await generateChatTitle(
    { prompt: 'x', engine: claudeEngine },
    deps({ run: async () => ok('', { code: null, spawnError: 'spawn claude ENOENT' }) }),
  )
  assert.equal(!spawn.ok && spawn.code, 'unavailable')

  const exit = await generateChatTitle(
    { prompt: 'x', engine: codexEngine },
    deps({ run: async () => ok('', { code: 1, stderr: 'warning: meta\nERROR: model not supported' }) }),
  )
  assert.deepEqual(exit, { ok: false, code: 'transport', message: 'codex exited 1: ERROR: model not supported' })

  const thrown = await generateChatTitle(
    { prompt: 'x', engine: claudeEngine },
    deps({ run: async () => { throw new Error('exploded') } }),
  )
  assert.deepEqual(thrown, { ok: false, code: 'transport', message: 'exploded' })

  const noise = await generateChatTitle(
    { prompt: 'x', engine: claudeEngine },
    deps({ run: async () => ok(claudeEnvelope('ok')) }),
  )
  assert.deepEqual(noise, { ok: false, code: 'guardrail', message: 'claude-code returned no usable title.' })

  const errored = await generateChatTitle(
    { prompt: 'x', engine: claudeEngine },
    deps({ run: async () => ok(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' })) }),
  )
  assert.equal(!errored.ok && errored.code, 'guardrail')
})

async function main(): Promise<void> {
  let failed = 0
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed > 0) throw new Error(`${failed} text-generation-service test(s) failed`)
}

void main()
