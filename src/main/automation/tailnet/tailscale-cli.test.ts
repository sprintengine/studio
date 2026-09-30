import assert from 'node:assert/strict'

import { beforeEach, test, vi } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFile }))

import { runTailscale, runTailscaleResult } from './tailscale-cli'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

beforeEach(() => {
  execFile.mockReset()
  execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
    callback(null, '{}', '')
  })
})

function envOfLastRun(): NodeJS.ProcessEnv {
  const options = execFile.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined
  assert.ok(options?.env, 'every Tailscale run passes an explicit environment')
  return options.env
}

// Launched from the Dock, the app has no TERM, and the macOS binary then tries
// to start its GUI and prints that failure to stdout with exit 0. The switch
// has to reach every run, reads and writes alike.
test('a read asks the binary to be the CLI', async () => {
  await runTailscale(['status', '--json'], 1000)
  assert.equal(envOfLastRun().TAILSCALE_BE_CLI, '1')
})

test('a write asks the binary to be the CLI', async () => {
  await runTailscaleResult(['serve', 'status'], 1000)
  assert.equal(envOfLastRun().TAILSCALE_BE_CLI, '1')
})

test('the rest of the environment is kept', async () => {
  process.env.SPRINTENGINE_TEST_CANARY = 'kept'
  try {
    await runTailscale(['status', '--json'], 1000)
    assert.equal(envOfLastRun().SPRINTENGINE_TEST_CANARY, 'kept')
  } finally {
    delete process.env.SPRINTENGINE_TEST_CANARY
  }
})
