import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ConversationProviderManifest } from '../shared/plugin-manifest'
import { canonicalManifestPayload } from '../shared/modules/third-party-manifest'
import {
  createPluginRegistry,
  validateManifestSource,
} from './plugin-registry'
import { renderPluginLaunch } from './plugin-render'
import { manifestFingerprint, verifyModuleSignature } from './modules/module-signature'
import { createAppPluginRegistryOptions } from './plugin-registry-instance'

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
  await testSkillIntegrationValidated()
  await testInvalidSkillIntegrationRejected()
  await testProviderManifestLoadsThroughProviderListOnly()
  await testOpenAiCompatibleProviderConfigValidated()
  await testProviderCliFieldMixingRejected()
  await testCliProviderFieldMixingRejected()
  await testBundledExecutableProviderClassifiedAsExecutable()
  await testUnsignedExecutableProviderBlockedInProduction()
  await testUnsignedExecutableProviderBlockedEvenWhenContentTrusted()
  await testSignedTrustedExecutableProviderClassifiedAsExecutable()
  await testAppRegistryTrustStoreClassifiesSignedProviderExecutable()
  await testTamperedExecutableProviderBlocked()
  await testTamperedExecutableProviderEntryBlocked()
  await testUnsafeExecutableProviderEntryRejected()

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
  assert.deepEqual(ids, ['claude-code', 'codex', 'generic-shell', 'opencode'])
  assert.equal(
    registry.listConversationProviders().some((provider) => provider.id === 'openrouter'),
    true
  )
  const codexEntry = registry.list().find((entry) => entry.id === 'codex')
  assert.equal(codexEntry?.skillIntegration?.support, 'native')
  assert.equal(codexEntry?.skillIntegration?.harnessId, 'codex')
  assert.equal(codexEntry?.skillIntegration?.installTargetCount, 1)
  assert.equal(codexEntry?.skillIntegration?.invocation?.fileDropTemplate, 'Use ${{skillId}} to work {{path}}.')
  assert.equal(
    registry.list().some((entry) => entry.id === 'openrouter'),
    false,
    'bundled provider manifests must not appear in the terminal CLI catalog'
  )

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

async function testSkillIntegrationValidated(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      id: 'pi',
      displayName: 'Pi',
      version: 1,
      binary: 'pi',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'stdin-pipe' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
      skillIntegration: {
        support: 'native',
        harnessId: 'pi',
        installTargets: [
          {
            scope: 'workspace',
            path: '{{workspaceRoot}}/.pi/skills/{{skillId}}',
            format: 'generic',
          },
        ],
        invocation: {
          fileDropTemplate: 'pi skill {{skillId}} {{path}}',
        },
      },
    })
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.kind, undefined)
  assert.equal(result.manifest.skillIntegration?.support, 'native')
}

async function testInvalidSkillIntegrationRejected(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      id: 'bad-skill-cli',
      displayName: 'Bad Skill CLI',
      version: 1,
      binary: 'bad',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'stdin-pipe' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
      skillIntegration: {
        support: 'native',
        harnessId: 'bad',
        installTargets: [
          {
            scope: 'workspace',
            path: '{{home}}/.bad/skills/{{skillId}}',
            format: 'generic',
          },
        ],
        invocation: {
          fileDropTemplate: 'bad {{unknown}}',
        },
      },
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'skillIntegration.installTargets[0].path'))
  assert.ok(result.issues.some((issue) => issue.path === 'skillIntegration.invocation.fileDropTemplate'))
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

async function testProviderManifestLoadsThroughProviderListOnly(): Promise<void> {
  const userRootParent = await mkdtemp(join(tmpdir(), 'multicode-provider-plugins-'))
  const userRoot = join(userRootParent, 'plugins')
  const providerRoot = join(userRoot, 'openai-compatible')
  await mkdir(providerRoot, { recursive: true })
  await writeFile(
    join(providerRoot, 'plugin.json'),
    JSON.stringify({
      kind: 'provider',
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible',
      version: 1,
      providerType: 'model-provider',
      models: [
        { id: 'gpt-5', displayName: 'GPT-5' },
        { id: 'gpt-5-mini' },
      ],
      auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
    }),
    'utf-8'
  )

  const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  assert.equal(registry.get('openai-compatible'), undefined)
  assert.ok(registry.getConversationProvider('openai-compatible'))
  assert.ok(
    !registry.list().some((entry) => entry.id === 'openai-compatible'),
    'provider manifests must not appear in the terminal CLI catalog'
  )
  assert.deepEqual(registry.listConversationProviders().filter((entry) => entry.id === 'openai-compatible'), [
    {
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible',
      source: 'user',
      version: 1,
      providerType: 'model-provider',
      models: [
        { id: 'gpt-5', displayName: 'GPT-5' },
        { id: 'gpt-5-mini' },
      ],
      supportsDynamicModels: false,
      adapter: {
        kind: 'declarative',
        execution: 'declarative',
        trust: 'not_required',
      },
    },
  ])
}

async function testProviderCliFieldMixingRejected(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      kind: 'provider',
      id: 'mixed-provider',
      displayName: 'Mixed Provider',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      binary: 'demo',
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'binary'))
}

async function testOpenAiCompatibleProviderConfigValidated(): Promise<void> {
  const invalidBase = validateManifestSource(
    JSON.stringify({
      kind: 'provider',
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      openaiCompatible: { baseUrl: 'file:///tmp/provider', chatCompletionsPath: '/v1/chat/completions' },
    })
  )
  assert.equal(invalidBase.ok, false)
  if (!invalidBase.ok) {
    assert.ok(invalidBase.issues.some((issue) => issue.path === 'openaiCompatible.baseUrl'))
  }

  const invalidPath = validateManifestSource(
    JSON.stringify({
      kind: 'provider',
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      openaiCompatible: { baseUrl: 'https://api.example.test', chatCompletionsPath: '../chat' },
    })
  )
  assert.equal(invalidPath.ok, false)
  if (!invalidPath.ok) {
    assert.ok(invalidPath.issues.some((issue) => issue.path === 'openaiCompatible.chatCompletionsPath'))
  }

  const invalidModelsPath = validateManifestSource(
    JSON.stringify({
      kind: 'provider',
      id: 'openrouter',
      displayName: 'OpenRouter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      openaiCompatible: { baseUrl: 'https://openrouter.ai', modelsPath: 'api/v1/models' },
    })
  )
  assert.equal(invalidModelsPath.ok, false)
  if (!invalidModelsPath.ok) {
    assert.ok(invalidModelsPath.issues.some((issue) => issue.path === 'openaiCompatible.modelsPath'))
  }

  const validDynamic = validateManifestSource(
    JSON.stringify({
      kind: 'provider',
      id: 'openrouter',
      displayName: 'OpenRouter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' }],
      auth: { type: 'api-key', label: 'OpenRouter API key', env: 'OPENROUTER_API_KEY' },
      openaiCompatible: {
        baseUrl: 'https://openrouter.ai',
        chatCompletionsPath: '/api/v1/chat/completions',
        modelsPath: '/api/v1/models',
      },
    })
  )
  assert.equal(validDynamic.ok, true, 'a valid OpenRouter manifest with modelsPath passes validation')
}

async function testCliProviderFieldMixingRejected(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      kind: 'cli',
      id: 'mixed-cli',
      displayName: 'Mixed CLI',
      version: 1,
      binary: 'demo',
      permissionPresets: { default: { label: 'D', args: [] } },
      launch: { argv: ['{{binary}}'] },
      promptInjection: { mode: 'positional-arg' },
      completion: { mode: 'process-exit' },
      capabilities: {
        resumeSession: false,
        sessionIdFromCaller: false,
        toolUse: false,
        mcpServers: false,
      },
      providerType: 'model-provider',
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'providerType'))
}

async function testBundledExecutableProviderClassifiedAsExecutable(): Promise<void> {
  const bundledRoot = await mkdtemp(join(tmpdir(), 'multicode-bundled-provider-'))
  const providerRoot = join(bundledRoot, 'bundled-adapter')
  await mkdir(providerRoot, { recursive: true })
  await writeProviderManifest(providerRoot, {
    kind: 'provider',
    id: 'bundled-adapter',
    displayName: 'Bundled Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  })

  const registry = createPluginRegistry({
    bundledRoot,
    userRoot: join(await mkdtemp(join(tmpdir(), 'multicode-no-user-plugins-')), 'plugins'),
  })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('bundled-adapter')
  assert.ok(provider)
  assert.deepEqual(provider!.adapter, {
    kind: 'trusted-executable',
    execution: 'executable',
    trust: 'trusted',
    entry: 'dist/provider.js',
  })
}

async function testUnsignedExecutableProviderBlockedInProduction(): Promise<void> {
  const userRoot = await createUserProvider('unsigned-adapter', {
    kind: 'provider',
    id: 'unsigned-adapter',
    displayName: 'Unsigned Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  })

  const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot, productionMode: true })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('unsigned-adapter')
  assert.ok(provider)
  assert.equal(provider!.adapter.execution, 'blocked')
  assert.equal(provider!.adapter.trust, 'unsigned')
  assert.match(provider!.adapter.trustError ?? '', /cannot run in production/)
}

async function testUnsignedExecutableProviderBlockedEvenWhenContentTrusted(): Promise<void> {
  const manifest: ConversationProviderManifest = {
    kind: 'provider',
    id: 'trusted-unsigned-adapter',
    displayName: 'Trusted Unsigned Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  }
  const userRoot = await createUserProvider('trusted-unsigned-adapter', manifest)

  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot,
    productionMode: true,
    providerTrustContext: {
      trustedModules: new Map([[manifest.id, manifestFingerprint(manifest)]]),
    },
  })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('trusted-unsigned-adapter')
  assert.ok(provider)
  assert.equal(provider!.adapter.execution, 'blocked')
  assert.equal(provider!.adapter.trust, 'unsigned')
}

async function testSignedTrustedExecutableProviderClassifiedAsExecutable(): Promise<void> {
  const signed = signProviderManifest({
    kind: 'provider',
    id: 'signed-adapter',
    displayName: 'Signed Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  })
  const fingerprint = verifyModuleSignature(signed).fingerprint
  assert.equal(typeof fingerprint, 'string')
  const userRoot = await createUserProvider('signed-adapter', signed)

  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot,
    providerTrustContext: { trustedModules: new Map(), trustedKeyFingerprints: new Set([fingerprint!]) },
  })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('signed-adapter')
  assert.ok(provider)
  assert.equal(provider!.adapter.execution, 'executable')
  assert.equal(provider!.adapter.trust, 'trusted')
  assert.equal(provider!.adapter.fingerprint, fingerprint)
}

async function testAppRegistryTrustStoreClassifiesSignedProviderExecutable(): Promise<void> {
  const signed = signProviderManifest({
    kind: 'provider',
    id: 'app-trusted-adapter',
    displayName: 'App Trusted Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  })
  const userRoot = await createUserProvider('app-trusted-adapter', signed)
  const userDataDir = await mkdtemp(join(tmpdir(), 'multicode-provider-trust-store-'))
  await writeTrustedModules(userDataDir, { [signed.id]: manifestFingerprint(signed) })

  const registry = createPluginRegistry(createAppPluginRegistryOptions(userDataDir, BUNDLED_ROOT, userRoot))
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('app-trusted-adapter')
  assert.ok(provider)
  assert.equal(provider!.adapter.execution, 'executable')
  assert.equal(provider!.adapter.trust, 'trusted')
}

async function testTamperedExecutableProviderBlocked(): Promise<void> {
  const signed = signProviderManifest({
    kind: 'provider',
    id: 'tampered-adapter',
    displayName: 'Tampered Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  })
  const tampered: ConversationProviderManifest = { ...signed, displayName: 'Tampered Adapter Changed' }
  const userRoot = await createUserProvider('tampered-adapter', tampered)

  const registry = createPluginRegistry({ bundledRoot: BUNDLED_ROOT, userRoot })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('tampered-adapter')
  assert.ok(provider)
  assert.equal(provider!.adapter.execution, 'blocked')
  assert.equal(provider!.adapter.trust, 'invalid')
  assert.match(provider!.adapter.trustError ?? '', /tampered/)
}

async function testTamperedExecutableProviderEntryBlocked(): Promise<void> {
  const signed = signProviderManifest({
    kind: 'provider',
    id: 'entry-tampered-adapter',
    displayName: 'Entry Tampered Adapter',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'demo' }],
    adapter: executableAdapterSpec(),
  })
  const userRoot = await createUserProvider('entry-tampered-adapter', signed)
  await writeFile(join(userRoot, 'entry-tampered-adapter', 'dist', 'provider.js'), 'tampered-entry', 'utf-8')

  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot,
    providerTrustContext: {
      trustedModules: new Map([[signed.id, manifestFingerprint(signed)]]),
    },
  })
  const report = await registry.load()
  assert.deepEqual(report.rejected, [])
  const provider = registry.getConversationProvider('entry-tampered-adapter')
  assert.ok(provider)
  assert.equal(provider!.adapter.execution, 'blocked')
  assert.equal(provider!.adapter.trust, 'invalid')
  assert.match(provider!.adapter.trustError ?? '', /hash does not match/)
}

async function testUnsafeExecutableProviderEntryRejected(): Promise<void> {
  const result = validateManifestSource(
    JSON.stringify({
      kind: 'provider',
      id: 'unsafe-adapter',
      displayName: 'Unsafe Adapter',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'demo' }],
      adapter: { kind: 'trusted-executable', entry: '../provider.js', sha256: adapterSha256() },
    })
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.issues.some((issue) => issue.path === 'adapter.entry'))
}

async function createUserProvider(id: string, manifest: ConversationProviderManifest): Promise<string> {
  const userRootParent = await mkdtemp(join(tmpdir(), 'multicode-provider-plugins-'))
  const userRoot = join(userRootParent, 'plugins')
  await writeProviderManifest(join(userRoot, id), manifest)
  return userRoot
}

async function writeProviderManifest(root: string, manifest: ConversationProviderManifest): Promise<void> {
  await mkdir(root, { recursive: true })
  if (manifest.adapter?.kind === 'trusted-executable') {
    const entryPath = join(root, manifest.adapter.entry)
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, ADAPTER_CONTENT, 'utf-8')
  }
  await writeFile(join(root, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

function signProviderManifest(manifest: ConversationProviderManifest): ConversationProviderManifest {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, Buffer.from(canonicalManifestPayload(manifest), 'utf8'), privateKey).toString('base64')
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return {
    ...manifest,
    signature: { algorithm: 'ed25519', publicKey: publicKeyB64, signature },
  }
}

async function writeTrustedModules(userDataDir: string, trusted: Record<string, string>): Promise<void> {
  await mkdir(userDataDir, { recursive: true })
  await writeFile(join(userDataDir, 'trusted-modules.json'), JSON.stringify(trusted), 'utf-8')
}

const ADAPTER_CONTENT = 'export default function providerAdapter() { return null }\n'

function executableAdapterSpec(): Extract<ConversationProviderManifest['adapter'], { kind: 'trusted-executable' }> {
  return { kind: 'trusted-executable', entry: 'dist/provider.js', sha256: adapterSha256() }
}

function adapterSha256(): string {
  return createHash('sha256').update(Buffer.from(ADAPTER_CONTENT)).digest('hex')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
