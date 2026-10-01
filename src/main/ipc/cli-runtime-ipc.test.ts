import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { CliInstallResult } from '../../shared/electron-api'

// An install or update the app ran ends by detecting its CLI again on the
// machine it ran on. That answer — and only that one CLI on that one machine —
// becomes what the version check compares, so the badge clears without a
// re-scan of every CLI.

const calls = vi.hoisted(() => ({
  noted: [] as unknown[][],
  recorded: [] as unknown[][],
  discovered: [] as unknown[],
  result: null as CliInstallResult | null,
}))

vi.mock('../cli-runtime-install', () => ({
  cliInstallMethods: async () => [],
  detectCli: async (cli: string) => ({
    cli,
    binary: cli,
    installed: true,
    version: '1.0.0',
    resolvedPath: `/usr/local/bin/${cli}`,
    hostId: 'local',
    error: null,
  }),
  installCli: async () => calls.result,
  updateCli: async () => calls.result,
}))
vi.mock('../cli-version-advisory-service', () => ({
  noteCliDetected: async (...args: unknown[]) => void calls.noted.push(args),
}))
vi.mock('../cli-availability', () => ({
  recordCliDetection: (...args: unknown[]) => void calls.recorded.push(args),
}))
vi.mock('./cli-model-discovery-ipc', () => ({
  discoverAndBroadcastCliModels: async (input: unknown) => void calls.discovered.push(input),
}))

const { registerCliRuntimeIpc } = await import('./cli-runtime-ipc')

type Handler = (event: unknown, input: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
registerCliRuntimeIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never)
const event = { sender: { isDestroyed: () => false, send: () => undefined } }

function result(over: Partial<CliInstallResult> = {}): CliInstallResult {
  return {
    ok: true,
    cli: 'codex',
    installed: true,
    version: '0.41.0',
    resolvedPath: '/home/dev/.local/bin/codex',
    log: '',
    error: null,
    ...over,
  }
}

beforeEach(() => {
  calls.noted.length = 0
  calls.recorded.length = 0
  calls.discovered.length = 0
})

test('an update on a WSL machine records that CLI there, with the version it now reports', async () => {
  calls.result = result()
  const runtime = { command: '', hostId: 'wsl:Ubuntu' }
  await handlers.get('cli-runtime:update')!(event, { cli: 'codex', runtime })
  assert.equal(calls.noted.length, 1)
  const [noteRuntime, detected] = calls.noted[0] as [unknown, Record<string, unknown>]
  assert.deepEqual(noteRuntime, runtime)
  assert.equal(detected.hostId, 'wsl:Ubuntu')
  assert.equal(detected.version, '0.41.0')
  assert.equal(detected.installed, true)
  assert.equal(detected.error, null)
  assert.equal(calls.discovered.length, 1, 'a new binary is a new model list')
})

test('an install that exited badly but left the CLI in place is still recorded', async () => {
  calls.result = result({ ok: false, error: 'Install command exited with code 1.' })
  await handlers.get('cli-runtime:install')!(event, { cli: 'codex', methodId: 'npm', runtime: { command: '' } })
  assert.equal(calls.noted.length, 1)
  assert.equal((calls.noted[0][1] as { hostId: string }).hostId, 'local')
  assert.equal(calls.discovered.length, 0, 'model discovery waits for a clean install')
})

test('an install that left nothing behind records nothing', async () => {
  calls.result = result({ ok: false, installed: false, version: null, resolvedPath: null })
  await handlers.get('cli-runtime:install')!(event, { cli: 'codex', methodId: 'npm' })
  assert.deepEqual(calls.noted, [])
})

test('a row’s own detection becomes the shared answer for that CLI on that machine', async () => {
  const runtime = { command: '/opt/codex' }
  await handlers.get('cli-runtime:detect')!(event, { cli: 'codex', runtime })
  assert.equal(calls.recorded.length, 1)
  assert.deepEqual(calls.recorded[0][0], runtime)
})
