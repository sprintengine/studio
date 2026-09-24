import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest'

import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { INHERITED_CLAUDE_SESSION_ENV_KEYS, withoutInheritedSessionEnv } from './inherited-session-env'
import {
  cleanupTerminalStartupScript,
  getPlainShellLaunchConfig,
  getShellLaunchConfig,
  getTerminalEnv,
} from './terminal-launch'

vi.mock('electron', () => import('../../tests/stubs/electron'))

let temp = ''
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'sprintengine-session-env-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})
afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

// What a Claude Code session exports to the processes it spawns, as observed
// from inside one: the parent a dev build or a scripted app launch inherits.
const PARENT_SESSION = {
  CLAUDECODE: '1',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-000000000000',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_PID: '4242',
  CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_EXECPATH: '/Users/dev/.local/share/claude/versions/2.1.281',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SSE_PORT: '51234',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge-1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude-messaging.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'token',
}

// What a person sets to configure Claude Code. None of it names the parent
// session, and all of it must reach the agent.
const USER_CONFIGURATION = {
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  ANTHROPIC_API_KEY: 'sk-ant-placeholder',
  ANTHROPIC_MODEL: 'claude-opus-5-5',
  ANTHROPIC_BASE_URL: 'https://gateway.example.com',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_PLUGIN_DIRS: '/Users/dev/plugins',
  CLAUDE_CONFIG_DIR: '/Users/dev/.claude-work',
}

test('every marker is on the list, and the list holds nothing else', () => {
  assert.deepEqual(
    [...INHERITED_CLAUDE_SESSION_ENV_KEYS].sort(),
    Object.keys(PARENT_SESSION).concat('CLAUDE_CODE_INVOKED_SKILLS').sort(),
  )
})

test('the parent session markers are removed and user configuration is kept', () => {
  const env = withoutInheritedSessionEnv({ PATH: '/bin', ...PARENT_SESSION, ...USER_CONFIGURATION })
  for (const key of Object.keys(PARENT_SESSION)) assert.equal(key in env, false, `${key} must not be inherited`)
  assert.deepEqual(env, { PATH: '/bin', ...USER_CONFIGURATION })
})

test('a marker is matched whatever its case, as a Windows environment would', () => {
  const env = withoutInheritedSessionEnv({ Path: 'C:\\Windows', ClaudeCode: '1', claude_code_child_session: '1' })
  assert.deepEqual(env, { Path: 'C:\\Windows' })
})

test('the input record is left alone', () => {
  const input = { CLAUDECODE: '1' }
  withoutInheritedSessionEnv(input)
  assert.deepEqual(input, { CLAUDECODE: '1' })
})

// The launch env itself, built from this process's env the way the app builds
// it. Explicit values rather than whatever the runner inherited: this suite may
// well be running inside a Claude Code session, which is the bug.
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const [key, value] of Object.entries({ ...PARENT_SESSION, ...USER_CONFIGURATION })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('the base env every terminal and agent starts from carries no parent session', () => {
  const env = getTerminalEnv()
  for (const key of INHERITED_CLAUDE_SESSION_ENV_KEYS) assert.equal(key in env, false, `${key} must not reach a launch`)
  for (const [key, value] of Object.entries(USER_CONFIGURATION)) assert.equal(env[key], value, `${key} is the person's`)
})

test('neither an agent launch nor a plain terminal inherits the markers', () => {
  const cwd = join(temp, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const launches = [
    ['claude-code', () => getShellLaunchConfig(cwd, 'sid-agent', false, 'claude-code', undefined, {})],
    ['plain terminal', () => getPlainShellLaunchConfig(cwd, 'sid-shell')],
  ] as const
  for (const [label, launch] of launches) {
    const config = launch()
    try {
      const env = config.env ?? {}
      assert.ok(Object.keys(env).length > 0, 'the launch carries an env')
      for (const key of INHERITED_CLAUDE_SESSION_ENV_KEYS) {
        assert.equal(key in env, false, `${label}: ${key} must not be inherited`)
      }
      assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1', `${label}: user configuration survives`)
    } finally {
      cleanupTerminalStartupScript(config.startupScriptPath)
    }
  }
})
