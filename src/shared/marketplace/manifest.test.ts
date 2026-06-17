import assert from 'node:assert/strict'

import {
  canonicalManifestPayload,
  parseMarketplaceIndex,
  parseMarketplacePluginManifest,
  validateMarketplaceIndex,
  validateMarketplacePluginAuthoringManifest,
  validateMarketplacePluginManifest,
} from './manifest'

const VALID_SIGNATURE = { algorithm: 'ed25519' as const, publicKey: 'YWJj', signature: 'ZGVm' }
const VALID_DIGEST = 'a'.repeat(64)

const VALID_PLUGIN = {
  id: 'dev-helper',
  displayName: 'Dev Helper',
  version: 1,
  publisher: 'Multicode Labs',
  summary: 'Adds development helpers.',
  category: 'dev-tools',
  permissions: ['network', 'ipc:settings'],
  signature: VALID_SIGNATURE,
  components: {
    mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: VALID_DIGEST }] },
    skills: { path: 'skills/pack', files: [{ path: 'skills/pack/SKILL.md', sha256: VALID_DIGEST }] },
    module: { path: 'module', files: [{ path: 'module/manifest.json', sha256: VALID_DIGEST }] },
    cli: { path: 'cli', files: [{ path: 'cli/plugin.json', sha256: VALID_DIGEST }] },
  },
}

const VALID_MARKETPLACE = {
  schemaVersion: 1,
  plugins: [
    {
      id: 'dev-helper',
      name: 'Dev Helper',
      publisher: { name: 'Multicode Labs', verified: true },
      summary: 'Adds development helpers.',
      category: 'dev-tools',
      icon: 'icons/dev-helper.svg',
      latest: 1,
      source: 'https://github.com/multicode-labs/marketplace/plugins/dev-helper',
      provides: ['mcp', 'skills', 'module', 'cli'],
      signature: VALID_SIGNATURE,
    },
  ],
}

function withoutField<T extends Record<string, unknown>>(value: T, field: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...value }
  delete next[field]
  return next
}

function issuePaths(issues: Array<{ path: string }>): string[] {
  return issues.map((issue) => issue.path)
}

function assertRejectsAt(
  value: unknown,
  path: string,
  validator: (value: unknown) => { ok: true } | { ok: false; issues: Array<{ path: string }> } = validateMarketplacePluginManifest
): void {
  const result = validator(value)
  assert.equal(result.ok, false, `${path} should be rejected`)
  if (!result.ok) assert.ok(issuePaths(result.issues).includes(path), `expected issue at ${path}`)
}

function testValidPluginManifest(): void {
  const result = validateMarketplacePluginManifest(VALID_PLUGIN)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.source, 'third-party')
    assert.deepEqual(result.manifest.permissions, ['network', 'ipc:settings'])
    assert.equal(result.manifest.components.mcp?.path, 'mcp/server.json')
    assert.equal(result.manifest.components.skills?.path, 'skills/pack')
    assert.equal(result.manifest.components.module?.path, 'module')
    assert.equal(result.manifest.components.cli?.path, 'cli')
    assert.deepEqual(result.manifest.components.mcp?.files, [{ path: 'mcp/server.json', sha256: VALID_DIGEST }])
  }
}

function testPluginMissingRequiredFields(): void {
  for (const path of ['id', 'displayName', 'version', 'signature', 'components']) {
    assertRejectsAt(withoutField(VALID_PLUGIN, path), path)
  }
}

function testPluginRejectsInvalidComponentCases(): void {
  assertRejectsAt({ ...VALID_PLUGIN, components: {} }, 'components')
  assertRejectsAt({ ...VALID_PLUGIN, components: { mcp: {} } }, 'components.mcp.path')
  assertRejectsAt({ ...VALID_PLUGIN, components: { mcp: { path: '../escape.json' } } }, 'components.mcp.path')
  assertRejectsAt({ ...VALID_PLUGIN, components: { theme: { path: 'theme.json' } } }, 'components.theme')
  assertRejectsAt({ ...VALID_PLUGIN, components: { mcp: { path: 'mcp/server.json' } } }, 'components.mcp.files')
  assertRejectsAt(
    { ...VALID_PLUGIN, components: { mcp: { path: 'mcp/server.json', files: [{ path: 'other/server.json', sha256: VALID_DIGEST }] } } },
    'components.mcp.files[0].path'
  )
  assertRejectsAt(
    { ...VALID_PLUGIN, components: { mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: 'BAD' }] } } },
    'components.mcp.files[0].sha256'
  )
  assertRejectsAt(
    { ...VALID_PLUGIN, components: { mcp: { path: 'mcp/server.json', extra: true } } },
    'components.mcp.extra'
  )
}

function testPluginAuthoringManifestAllowsDraftWithoutDigests(): void {
  const result = validateMarketplacePluginAuthoringManifest({
    ...VALID_PLUGIN,
    signature: undefined,
    components: {
      mcp: { path: 'mcp/server.json' },
    },
  })
  assert.equal(result.ok, true)
}

function testPluginRejectsInvalidPermissionsThroughSdkValidator(): void {
  assertRejectsAt({ ...VALID_PLUGIN, permissions: ['network', ''] }, 'permissions[1]')
}

function testPluginRejectsInvalidSignatureThroughSdkValidator(): void {
  assertRejectsAt({ ...VALID_PLUGIN, signature: { algorithm: 'rsa' } }, 'signature.algorithm')
}

function testPluginCanonicalPayloadExcludesSignatureAndUnknownFields(): void {
  const result = validateMarketplacePluginManifest({ ...VALID_PLUGIN, ignored: true })
  assert.equal(result.ok, true)
  if (!result.ok) return

  const payload = canonicalManifestPayload(result.manifest)
  assert.equal(payload.includes('signature'), false)
  assert.equal(payload.includes('ignored'), false)
  assert.ok(payload.includes('components'), 'plugin canonical payload includes validated bundle components')
}

function testParsePluginInvalidJson(): void {
  assert.equal(parseMarketplacePluginManifest('{not json').ok, false)
}

function testValidMarketplaceIndex(): void {
  const result = validateMarketplaceIndex(VALID_MARKETPLACE)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.marketplace.schemaVersion, 1)
    assert.equal(result.marketplace.plugins[0].publisher.verified, true)
    assert.deepEqual(result.marketplace.plugins[0].provides, ['mcp', 'skills', 'module', 'cli'])
  }
}

function testMarketplaceMissingTopLevelFields(): void {
  assertRejectsAt(withoutField(VALID_MARKETPLACE, 'schemaVersion'), 'schemaVersion', validateMarketplaceIndex)
  assertRejectsAt(withoutField(VALID_MARKETPLACE, 'plugins'), 'plugins', validateMarketplaceIndex)
}

function testMarketplaceMissingPluginFields(): void {
  const required = ['id', 'name', 'publisher', 'summary', 'category', 'icon', 'latest', 'source', 'provides', 'signature']
  for (const field of required) {
    const plugin = withoutField(VALID_MARKETPLACE.plugins[0], field)
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [plugin] }, `plugins[0].${field}`, validateMarketplaceIndex)
  }
}

function testMarketplaceRejectsNestedInvalidFields(): void {
  assertRejectsAt(
    { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], publisher: { verified: true } }] },
    'plugins[0].publisher.name',
    validateMarketplaceIndex
  )
  assertRejectsAt(
    { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], publisher: { name: 'Multicode Labs' } }] },
    'plugins[0].publisher.verified',
    validateMarketplaceIndex
  )
  assertRejectsAt(
    { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], provides: ['mcp', 'theme'] }] },
    'plugins[0].provides[1]',
    validateMarketplaceIndex
  )
  assertRejectsAt(
    { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], signature: { algorithm: 'rsa' } }] },
    'plugins[0].signature.algorithm',
    validateMarketplaceIndex
  )
}

function testParseMarketplaceInvalidJson(): void {
  assert.equal(parseMarketplaceIndex('{not json').ok, false)
}

testValidPluginManifest()
testPluginMissingRequiredFields()
testPluginRejectsInvalidComponentCases()
testPluginAuthoringManifestAllowsDraftWithoutDigests()
testPluginRejectsInvalidPermissionsThroughSdkValidator()
testPluginRejectsInvalidSignatureThroughSdkValidator()
testPluginCanonicalPayloadExcludesSignatureAndUnknownFields()
testParsePluginInvalidJson()
testValidMarketplaceIndex()
testMarketplaceMissingTopLevelFields()
testMarketplaceMissingPluginFields()
testMarketplaceRejectsNestedInvalidFields()
testParseMarketplaceInvalidJson()
console.log('marketplace manifest tests passed')
