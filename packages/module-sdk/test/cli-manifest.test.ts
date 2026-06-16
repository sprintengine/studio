import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseCliPluginManifest,
  validateCliPluginManifest,
  type CliPluginManifest,
} from '../src/cli-manifest.js'

// A minimal-but-complete valid CLI plugin manifest.
const VALID: CliPluginManifest = {
  id: 'my-cli',
  displayName: 'My CLI',
  version: 1,
  binary: 'my-cli',
  permissionPresets: { default: { label: 'Default', args: [] } },
  launch: { argv: ['my-cli', { spreadIf: 'extraArgs' }] },
  promptInjection: { mode: 'positional-arg' },
  completion: { mode: 'process-exit' },
  capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
}

test('accepts a minimal valid CLI manifest', () => {
  const result = validateCliPluginManifest(VALID)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.id, 'my-cli')
})

test('reports the offending path for each invalid field', () => {
  const result = validateCliPluginManifest({
    id: 'Bad Id',
    displayName: '',
    version: 0,
    binary: 'x',
    permissionPresets: {},
    launch: { argv: [] },
    promptInjection: { mode: 'nope' },
    completion: { mode: 'output-sentinel' },
    capabilities: { resumeSession: 'yes' },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  const paths = result.issues.map((issue) => issue.path)
  assert.ok(paths.includes('id'))
  assert.ok(paths.includes('displayName'))
  assert.ok(paths.includes('version'))
  assert.ok(paths.includes('permissionPresets'))
  assert.ok(paths.includes('launch.argv'))
  assert.ok(paths.includes('promptInjection.mode'))
  assert.ok(paths.includes('completion.sentinel'))
  assert.ok(paths.includes('capabilities.resumeSession'))
})

test('requires a readiness signal for send-after-ready injection', () => {
  const result = validateCliPluginManifest({ ...VALID, promptInjection: { mode: 'send-after-ready' } })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'promptInjection.readiness'))
})

test('parseCliPluginManifest surfaces JSON errors', () => {
  const result = parseCliPluginManifest('{ not json')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.issues[0].message, /Invalid JSON/)
})

test('accepts themeSelection with a light/dark schemes map', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    themeSelection: {
      args: ['-c', 'tui.theme="{{themeName}}"'],
      schemes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
    },
  })
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
})

test('rejects a themeSelection schemes map missing a scheme', () => {
  const result = validateCliPluginManifest({
    ...VALID,
    themeSelection: { args: ['-c', 'tui.theme="{{themeName}}"'], schemes: { light: 'catppuccin-latte' } },
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'themeSelection.schemes.dark'))
})

test('accepts the bundled codex plugin.json (app and SDK agree)', () => {
  // The validator must accept manifests the running app ships and loads.
  const source = readFileSync(
    join(process.cwd(), 'resources', 'plugins', 'codex', 'plugin.json'),
    'utf8'
  )
  const result = parseCliPluginManifest(source)
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues))
})
