import assert from 'node:assert/strict'

import type { PluginManifest } from '../shared/plugin-manifest'
import { renderPluginLaunch, renderPluginResume } from './plugin-render'

function baseManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test',
    displayName: 'Test',
    version: 1,
    binary: 'test',
    permissionPresets: {
      default: { label: 'Default', args: [] },
      bypass: { label: 'Bypass', args: ['--yes', '--no-confirm'] },
    },
    launch: {
      argv: ['{{binary}}'],
    },
    promptInjection: { mode: 'positional-arg' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: false,
      sessionIdFromCaller: true,
      toolUse: true,
      mcpServers: false,
    },
    ...overrides,
  }
}

async function main(): Promise<void> {
  testLiteralSubstitution()
  testContextOverridesBinary()
  testPermissionArgsSpread()
  testValueIfPresentAndAbsent()
  testEnvSubstitution()
  testVariableDefaults()
  testResumeReusesLaunchWhenNoArgvOverride()
  testResumeDisabledReturnsNull()
  testClaudeManifestProducesExpectedArgv()
  testCodexManifestProducesExpectedArgv()
  testFilesSpreadEmpty()

  console.log('plugin-render tests passed')
}

function testLiteralSubstitution(): void {
  const manifest = baseManifest({
    launch: { argv: ['{{binary}}', '--session-id', '{{sessionId}}'] },
  })
  const out = renderPluginLaunch(manifest, { sessionId: 'exec_abc' })
  assert.deepEqual(out.argv, ['test', '--session-id', 'exec_abc'])
}

function testContextOverridesBinary(): void {
  const manifest = baseManifest({ launch: { argv: ['{{binary}}'] } })
  const out = renderPluginLaunch(manifest, { binary: '/opt/claude/bin/claude' })
  assert.deepEqual(out.argv, ['/opt/claude/bin/claude'])
}

function testPermissionArgsSpread(): void {
  const manifest = baseManifest({
    launch: {
      argv: ['{{binary}}', { spreadIf: 'permissionArgs' }, '--session-id', '{{sessionId}}'],
    },
  })

  const withPreset = renderPluginLaunch(manifest, {
    sessionId: 'exec_1',
    permissionPreset: 'bypass',
  })
  assert.deepEqual(withPreset.argv, ['test', '--yes', '--no-confirm', '--session-id', 'exec_1'])

  const withDefault = renderPluginLaunch(manifest, { sessionId: 'exec_2' })
  assert.deepEqual(withDefault.argv, ['test', '--session-id', 'exec_2'])
}

function testValueIfPresentAndAbsent(): void {
  const manifest = baseManifest({
    launch: {
      argv: ['{{binary}}', { valueIf: 'prompt', value: '{{prompt}}' }],
    },
  })
  const withPrompt = renderPluginLaunch(manifest, { prompt: 'hello there' })
  assert.deepEqual(withPrompt.argv, ['test', 'hello there'])

  const withoutPrompt = renderPluginLaunch(manifest, {})
  assert.deepEqual(withoutPrompt.argv, ['test'])
}

function testEnvSubstitution(): void {
  const manifest = baseManifest({
    launch: {
      argv: ['{{binary}}'],
      env: {
        SOME_KEY: '{{provider}}',
        SOME_OTHER: 'static-value',
        EMPTY_DROPPED: '{{missing}}',
      },
    },
    variables: {
      provider: { type: 'string', label: 'Provider', default: 'anthropic' },
    },
  })
  const out = renderPluginLaunch(manifest, { variables: { provider: 'openai' } })
  assert.equal(out.env.SOME_KEY, 'openai')
  assert.equal(out.env.SOME_OTHER, 'static-value')
  assert.equal(out.env.EMPTY_DROPPED, undefined, 'empty env values are dropped')
}

function testVariableDefaults(): void {
  const manifest = baseManifest({
    launch: { argv: ['{{binary}}'], env: { K: '{{thing}}' } },
    variables: {
      thing: { type: 'string', label: 'Thing', default: 'fallback' },
    },
  })
  const out = renderPluginLaunch(manifest, {})
  assert.equal(out.env.K, 'fallback', 'manifest default is used when context omits the var')
}

function testResumeReusesLaunchWhenNoArgvOverride(): void {
  const manifest = baseManifest({
    launch: { argv: ['{{binary}}', '--launch'] },
    resume: { supported: true },
  })
  const out = renderPluginResume(manifest, {})
  assert.deepEqual(out?.argv, ['test', '--launch'])
}

function testResumeDisabledReturnsNull(): void {
  const manifest = baseManifest({
    launch: { argv: ['{{binary}}'] },
    resume: { supported: false },
  })
  assert.equal(renderPluginResume(manifest, {}), null)
}

function testClaudeManifestProducesExpectedArgv(): void {
  const claude: PluginManifest = {
    id: 'claude-code',
    displayName: 'Claude Code',
    version: 1,
    binary: 'claude',
    permissionPresets: {
      default: { label: 'Default', args: [] },
      bypass_all: { label: 'Bypass', args: ['--permission-mode', 'bypassPermissions'] },
    },
    launch: {
      argv: [
        '{{binary}}',
        { spreadIf: 'permissionArgs' },
        '--session-id',
        '{{sessionId}}',
        { valueIf: 'prompt', value: '{{prompt}}' },
      ],
    },
    resume: {
      supported: true,
      argv: [
        '{{binary}}',
        { spreadIf: 'permissionArgs' },
        '--resume',
        '{{sessionId}}',
        { valueIf: 'prompt', value: '{{prompt}}' },
      ],
    },
    promptInjection: { mode: 'positional-arg' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: true,
      sessionIdFromCaller: true,
      toolUse: true,
      mcpServers: true,
    },
  }

  const launched = renderPluginLaunch(claude, {
    sessionId: 'sid_42',
    prompt: 'build the auth flow',
    permissionPreset: 'bypass_all',
  })
  assert.deepEqual(launched.argv, [
    'claude',
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    'sid_42',
    'build the auth flow',
  ])

  const resumed = renderPluginResume(claude, {
    sessionId: 'sid_42',
    permissionPreset: 'default',
  })
  assert.deepEqual(resumed?.argv, ['claude', '--resume', 'sid_42'])
}

function testCodexManifestProducesExpectedArgv(): void {
  const codex: PluginManifest = {
    id: 'codex',
    displayName: 'Codex',
    version: 1,
    binary: 'codex',
    permissionPresets: {
      default: { label: 'Default', args: [] },
      auto_workspace: {
        label: 'Auto',
        args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
      },
    },
    launch: {
      argv: ['{{binary}}', { spreadIf: 'permissionArgs' }, { valueIf: 'prompt', value: '{{prompt}}' }],
    },
    resume: {
      supported: true,
      argv: ['{{binary}}', { spreadIf: 'permissionArgs' }, 'resume'],
    },
    promptInjection: { mode: 'positional-arg' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: true,
      sessionIdFromCaller: false,
      toolUse: true,
      mcpServers: true,
    },
  }

  const launched = renderPluginLaunch(codex, {
    prompt: 'fix the parser bug',
    permissionPreset: 'auto_workspace',
  })
  assert.deepEqual(launched.argv, [
    'codex',
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
    'fix the parser bug',
  ])

  const resumed = renderPluginResume(codex, { permissionPreset: 'default' })
  assert.deepEqual(resumed?.argv, ['codex', 'resume'])
}

function testFilesSpreadEmpty(): void {
  const manifest = baseManifest({
    launch: { argv: ['{{binary}}', { spreadIf: 'files' }] },
  })
  const withFiles = renderPluginLaunch(manifest, { files: ['src/a.ts', 'src/b.ts'] })
  assert.deepEqual(withFiles.argv, ['test', 'src/a.ts', 'src/b.ts'])

  const withoutFiles = renderPluginLaunch(manifest, {})
  assert.deepEqual(withoutFiles.argv, ['test'])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
