import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { spawnManagedPython } from './python-runtime'
import { TEST_BUNDLED_WORKFLOW_ROLES_ENV } from '../production-child-env'

const INTERPRETER = '/Users/dev/runtime/python/bin/python3'
const PYTHON_ROOT = '/Users/dev/modules/weather-deck/python'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  killed: boolean
  kill: () => boolean
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.killed = false
  child.kill = () => true
  return child
}

function spawnRecording(captured: { env?: NodeJS.ProcessEnv }) {
  return {
    resolveInterpreter: () => ({ command: INTERPRETER, source: 'venv' as const }),
    spawnProcess: ((
      _command: string,
      _args: readonly string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      captured.env = options.env
      return createFakeChild()
    }) as unknown as typeof import('node:child_process').spawn,
  }
}

function withHostFlag<T>(body: () => T): T {
  const previous = process.env[TEST_BUNDLED_WORKFLOW_ROLES_ENV]
  process.env[TEST_BUNDLED_WORKFLOW_ROLES_ENV] = '1'
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env[TEST_BUNDLED_WORKFLOW_ROLES_ENV]
    else process.env[TEST_BUNDLED_WORKFLOW_ROLES_ENV] = previous
  }
}

{
  const captured: { env?: NodeJS.ProcessEnv } = {}
  withHostFlag(() => {
    spawnManagedPython(
      { pythonRoot: PYTHON_ROOT, module: 'weather_deck_mcp' },
      spawnRecording(captured),
    )
  })
  assert.equal(
    captured.env?.[TEST_BUNDLED_WORKFLOW_ROLES_ENV],
    undefined,
    'production sidecar spawn drops a host-inherited test bundled-roles flag',
  )
}

{
  const captured: { env?: NodeJS.ProcessEnv } = {}
  withHostFlag(() => {
    spawnManagedPython(
      {
        pythonRoot: PYTHON_ROOT,
        module: 'weather_deck_mcp',
        env: { [TEST_BUNDLED_WORKFLOW_ROLES_ENV]: '1' },
      },
      spawnRecording(captured),
    )
  })
  assert.equal(
    captured.env?.[TEST_BUNDLED_WORKFLOW_ROLES_ENV],
    '1',
    'a test harness may opt this child back in',
  )
}

console.log('python-runtime tests passed')
