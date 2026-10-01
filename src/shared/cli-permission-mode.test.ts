import assert from 'node:assert/strict'
import { test } from 'vitest'
import { defaultPermissionPresetFor, parseCliPermissionModeId } from './cli-permission-mode'
import {
  applyAgentLaunchSettingsPatch,
  emptyAgentLaunchSettings,
  normalizeAgentLaunchSettings,
  normalizeAgentLaunchSettingsPatch,
  resolveAgentSpawnPermission,
} from './launch-settings'
import { validateCliPluginManifest } from './cli-plugin-manifest'
import { conversationPermissionModes } from './conversation-harness'
import { bundledPermissionModes } from '../../tests/permission-modes'

test('a mode id is a runtime’s own name, never a preset or a retired spelling of one', () => {
  assert.equal(parseCliPermissionModeId('acceptEdits'), 'acceptEdits')
  assert.equal(parseCliPermissionModeId('workspace'), 'workspace')
  for (const generic of ['none', 'manual', 'auto', 'bypass', 'default', 'auto_workspace', 'bypass_all'])
    assert.equal(parseCliPermissionModeId(generic), null, generic)
  for (const junk of ['', '../x', '-flag', 'a b', 'x'.repeat(41), 42, null, undefined])
    assert.equal(parseCliPermissionModeId(junk), null, String(junk))
})

test('a launch nobody chose for runs Auto, or no flag on a CLI that has no Auto', () => {
  assert.equal(defaultPermissionPresetFor(null), 'auto')
  assert.equal(defaultPermissionPresetFor(['none', 'manual', 'auto', 'bypass']), 'auto')
  assert.equal(defaultPermissionPresetFor(['none', 'bypass']), 'none', 'never something looser in Auto’s place')
})

test('a spawn takes the CLI’s own mode only beside that CLI’s own preset', () => {
  const settings = {
    ...emptyAgentLaunchSettings(),
    cliPermissionPresets: { 'claude-code': 'auto' as const },
    cliPermissionModes: { 'claude-code': 'acceptEdits' },
  }
  assert.deepEqual(resolveAgentSpawnPermission(settings, 'claude-code'), { preset: 'auto', mode: 'acceptEdits' })
  assert.deepEqual(
    resolveAgentSpawnPermission(settings, 'claude-code', 'auto'),
    { preset: 'auto' },
    'a caller that names a preset gets that preset’s own mode',
  )
  assert.deepEqual(resolveAgentSpawnPermission(settings, 'codex'), { preset: 'auto' }, 'nobody chose for Codex')
  assert.deepEqual(
    resolveAgentSpawnPermission(emptyAgentLaunchSettings(), 'kimi-code', undefined, ['none', 'bypass']),
    { preset: 'none' },
    'a CLI with no Auto passes no flag rather than something looser',
  )
  const chosen = { ...emptyAgentLaunchSettings(), lastAgentSpawnPermissionPreset: 'bypass' as const }
  assert.deepEqual(
    resolveAgentSpawnPermission(chosen, 'claude-code', undefined, ['none', 'manual', 'auto', 'bypass']),
    { preset: 'bypass' },
    'a person who chose Bypass keeps it',
  )
  assert.deepEqual(resolveAgentSpawnPermission({ ...chosen, cliPermissionModes: {} }, 'constructor'), {
    preset: 'bypass',
  })
})

test('a preset written without a mode clears the mode, so a window that knows only presets never strands one', () => {
  const held = {
    ...emptyAgentLaunchSettings(),
    cliPermissionPresets: { 'claude-code': 'auto' as const, codex: 'auto' as const },
    cliPermissionModes: { 'claude-code': 'acceptEdits', codex: 'workspace' },
  }
  const next = applyAgentLaunchSettingsPatch(
    held,
    normalizeAgentLaunchSettingsPatch({ cliPermissionPresets: { 'claude-code': 'auto' } }),
  )
  assert.deepEqual(next.cliPermissionModes, { codex: 'workspace' }, 'only the CLI the patch named')
  const both = applyAgentLaunchSettingsPatch(
    held,
    normalizeAgentLaunchSettingsPatch({
      cliPermissionPresets: { 'claude-code': 'manual' },
      cliPermissionModes: { 'claude-code': 'dontAsk' },
    }),
  )
  assert.equal(both.cliPermissionModes['claude-code'], 'dontAsk')
  assert.deepEqual(
    normalizeAgentLaunchSettings({ cliPermissionModes: { 'claude-code': 'acceptEdits', codex: '../x', grok: 'auto' } })
      .cliPermissionModes,
    { 'claude-code': 'acceptEdits' },
    'a stored value that is not a mode id is dropped',
  )
})

test('a manifest’s own modes name their level; a key that names none is ignored, as before', () => {
  const manifest = (permissionPresets: Record<string, unknown>) =>
    validateCliPluginManifest({
      id: 'acme',
      displayName: 'Acme',
      version: 1,
      binary: 'acme',
      permissionPresets,
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'none' },
      completion: { mode: 'process-exit' },
      capabilities: { resumeSession: false, sessionIdFromCaller: false },
    })
  // Only what the permission entries are told: the rest of this manifest is a stub.
  const issues = (result: ReturnType<typeof manifest>) =>
    result.ok ? [] : result.issues.map((issue) => issue.path).filter((path) => path.startsWith('permissionPresets'))
  assert.deepEqual(
    issues(manifest({ careful: { label: 'Careful', args: ['--careful'], level: 'manual', summary: 'Asks.' } })),
    [],
  )
  assert.deepEqual(issues(manifest({ yolo: { label: 'YOLO', args: ['--yolo'] } })), [], 'an old key with no level')
  assert.deepEqual(issues(manifest({ wild: { label: 'Wild', args: [], level: 'everything' } })), [
    'permissionPresets.wild.level',
  ])
  assert.deepEqual(issues(manifest({ auto: { label: 'Auto', args: [], level: 'bypass' } })), [
    'permissionPresets.auto.level',
  ])
})

test('every mode a chat runs is one its CLI’s manifest names, at the level the chat maps it to', () => {
  const chatLevels: Record<string, Record<string, string>> = {
    'claude-code': { acceptEdits: 'auto', dontAsk: 'manual' },
    codex: { workspace: 'auto' },
    grok: { acceptEdits: 'auto', dontAsk: 'manual' },
  }
  for (const cli of ['claude-code', 'codex', 'cursor', 'grok', 'opencode']) {
    const declared = new Map(bundledPermissionModes(cli).map((mode) => [mode.id, mode.level]))
    for (const mode of conversationPermissionModes(cli)) {
      assert.equal(declared.get(mode), chatLevels[cli]?.[mode], `${cli}: ${mode}`)
    }
  }
})
