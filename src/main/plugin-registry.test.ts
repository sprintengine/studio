import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPluginRegistry,
  validateManifestSource,
} from './plugin-registry'
import { renderPluginLaunch } from './plugin-render'

const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')
const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures', 'plugin-manifests')

async function main(): Promise<void> {
  await testBundledManifestsLoad()
  await testClaudeBundledRenderMatchesExpected()
  await testCodexBundledRenderMatchesExpected()
  await testFixtureManifestsValidate()
  await testUserPluginOverridesBundled()
  await testInvalidManifestRejectedWithIssues()
  await testIdDirectoryMismatchRejected()
  await testMissingPermissionPresetsRejected()
  await testInvalidArgvTokenRejected()
  await testSendAfterReadyRequiresReadiness()
  await testCompletionFallbackValidated()

  console.log('plugin-registry tests passed')
}

async function testBundledManifestsLoad(): Promise<void> {
  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot: join(await mkdtemp(join(tmpdir(), 'multicode-no-user-plugins-')), 'plugins'),
  })
  const report = await registry.load()
  assert.deepEqual(
    report.rejected,
    [],
    `bundled manifests should validate cleanly: ${JSON.stringify(report.rejected, null, 2)}`
  )

  const ids = registry.list().map((p) => p.id).sort()
  assert.deepEqual(ids, ['claude-code', 'codex', 'generic-shell'])

  for (const id of ids) {
    const plugin = registry.get(id)
    assert.ok(plugin, `${id} should be retrievable`)
    assert.equal(plugin!.source, 'bundled')
  }
}

async function testClaudeBundledRenderMatchesExpected(): Promise<void> {
  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot: join(await mkdtemp(join(tmpdir(), 'multicode-no-user-plugins-')), 'plugins'),
  })
  await registry.load()
  const plugin = registry.get('claude-code')
  assert.ok(plugin)

  const launched = renderPluginLaunch(plugin!.manifest, {
    sessionId: 'sid_demo',
    prompt: 'do the thing',
    permissionPreset: 'bypass_all',
  })
  assert.deepEqual(launched.argv, [
    'claude',
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    'sid_demo',
    'do the thing',
  ])

  const launchedNoPreset = renderPluginLaunch(plugin!.manifest, {
    sessionId: 'sid_demo',
  })
  assert.deepEqual(launchedNoPreset.argv, ['claude', '--session-id', 'sid_demo'])
}

async function testCodexBundledRenderMatchesExpected(): Promise<void> {
  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot: join(await mkdtemp(join(tmpdir(), 'multicode-no-user-plugins-')), 'plugins'),
  })
  await registry.load()
  const plugin = registry.get('codex')
  assert.ok(plugin)

  const launched = renderPluginLaunch(plugin!.manifest, {
    prompt: 'fix the parser',
    permissionPreset: 'auto_workspace',
  })
  assert.deepEqual(launched.argv, [
    'codex',
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
    'fix the parser',
  ])
}

async function testFixtureManifestsValidate(): Promise<void> {
  const registry = createPluginRegistry({
    bundledRoot: FIXTURE_ROOT,
    userRoot: join(await mkdtemp(join(tmpdir(), 'multicode-no-user-plugins-')), 'plugins'),
  })
  const report = await registry.load()
  assert.deepEqual(
    report.rejected,
    [],
    `fixture manifests should validate cleanly: ${JSON.stringify(report.rejected, null, 2)}`
  )
  const ids = registry.list().map((p) => p.id).sort()
  assert.deepEqual(ids, ['aider', 'opencode', 'pi'])
}

async function testUserPluginOverridesBundled(): Promise<void> {
  const userRootParent = await mkdtemp(join(tmpdir(), 'multicode-user-plugins-'))
  const userRoot = join(userRootParent, 'plugins')
  const overrideRoot = join(userRoot, 'claude-code')
  await mkdir(overrideRoot, { recursive: true })

  const overrideManifest = {
    id: 'claude-code',
    displayName: 'Claude Code (Custom Fork)',
    version: 2,
    binary: '/usr/local/bin/claude',
    permissionPresets: {
      default: { label: 'Default', args: [] },
    },
    launch: { argv: ['{{binary}}', '--custom'] },
    promptInjection: { mode: 'positional-arg' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: false,
      sessionIdFromCaller: true,
      toolUse: true,
      mcpServers: false,
    },
  }
  await writeFile(
    join(overrideRoot, 'plugin.json'),
    JSON.stringify(overrideManifest, null, 2),
    'utf-8'
  )

  const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
  await registry.load()
  const loaded = registry.get('claude-code')
  assert.ok(loaded)
  assert.equal(loaded!.source, 'user')
  assert.equal(loaded!.manifest.displayName, 'Claude Code (Custom Fork)')
  assert.equal(loaded!.manifest.binary, '/usr/local/bin/claude')

  const list = registry.list().filter((p) => p.id === 'claude-code')
  assert.equal(list.length, 1, 'overridden plugin should appear only once')
}

async function testInvalidManifestRejectedWithIssues(): Promise<void> {
  const result = validateManifestSource('not json')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /not valid JSON/)
}

async function testIdDirectoryMismatchRejected(): Promise<void> {
  const userRootParent = await mkdtemp(join(tmpdir(), 'multicode-mismatch-'))
  const userRoot = join(userRootParent, 'plugins')
  const dir = join(userRoot, 'wrong-dir-name')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({
      id: 'plugin-id',
      displayName: 'X',
      version: 1,
      binary: 'x',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    }),
    'utf-8'
  )
  const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
  const report = await registry.load()
  const mismatch = report.rejected.find((r) => r.manifestPath.includes('wrong-dir-name'))
  assert.ok(mismatch, 'mismatched directory should be rejected')
  assert.match(mismatch!.issues[0].message, /does not match its containing directory/)
}

async function testMissingPermissionPresetsRejected(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      id: 'x',
      displayName: 'X',
      version: 1,
      binary: 'x',
      permissionPresets: {},
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((i) => i.path === 'permissionPresets'))
}

async function testInvalidArgvTokenRejected(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      id: 'x',
      displayName: 'X',
      version: 1,
      binary: 'x',
      permissionPresets: { default: { label: 'D', args: [] } },
      launch: { argv: [{ unknownDirective: 'foo' }] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((i) => i.message.includes('argv directive')))
}

async function testSendAfterReadyRequiresReadiness(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      id: 'x',
      displayName: 'X',
      version: 1,
      binary: 'x',
      permissionPresets: { default: { label: 'D', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'send-after-ready' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((i) => i.path === 'promptInjection.readiness'))
}

async function testCompletionFallbackValidated(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      id: 'x',
      displayName: 'X',
      version: 1,
      binary: 'x',
      permissionPresets: { default: { label: 'D', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'positional-arg' },
      completion: {
        mode: 'output-sentinel',
        sentinel: 'done',
        fallback: { mode: 'idle-at-prompt' },
      },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(
    result.issues.some((i) => i.path.startsWith('completion.fallback.')),
    'fallback completion validation should surface issues with fallback fields'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
