import assert from 'node:assert/strict'

import {
  MARKETPLACE_COMPONENT_KINDS,
  canonicalManifestPayload,
  marketplaceAutomationPayloadIssues,
  parseMarketplaceIndex,
  parseMarketplacePluginManifest,
  validateMarketplaceIndex,
  validateMarketplacePluginAuthoringManifest,
  validateMarketplacePluginManifest,
} from './manifest'
import { MARKETPLACE_CANONICAL_SOURCE } from './index'
import { test } from 'vitest'

test('manifest', async () => {
  const VALID_SIGNATURE = { algorithm: 'ed25519' as const, publicKey: 'YWJj', signature: 'ZGVm' }
  const VALID_DIGEST = 'a'.repeat(64)

  const VALID_PLUGIN = {
    id: 'dev-helper',
    displayName: 'Dev Helper',
    version: 1,
    publisher: 'SprintEngine Labs',
    summary: 'Adds development helpers.',
    category: 'dev-tools',
    permissions: ['network', 'ipc:settings'],
    signature: VALID_SIGNATURE,
    components: {
      mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: VALID_DIGEST }] },
      skills: { path: 'skills/pack', files: [{ path: 'skills/pack/SKILL.md', sha256: VALID_DIGEST }] },
      module: { path: 'module', files: [{ path: 'module/manifest.json', sha256: VALID_DIGEST }] },
      cli: { path: 'cli', files: [{ path: 'cli/plugin.json', sha256: VALID_DIGEST }] },
      automation: {
        path: 'automation/automation.json',
        files: [{ path: 'automation/automation.json', sha256: VALID_DIGEST }],
      },
    },
  }

  // The payload an `automation` component points at: a JSON automation
  // definition draft. Only its structure is checked at the manifest tier.
  const VALID_AUTOMATION_PAYLOAD = {
    name: 'Nightly dependency sweep',
    status: 'paused',
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '03:00' }, timezone: 'UTC' },
    },
    action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
  }

  const VALID_MARKETPLACE = {
    schemaVersion: 1,
    plugins: [
      {
        id: 'dev-helper',
        name: 'Dev Helper',
        publisher: { name: 'SprintEngine Labs', verified: true },
        summary: 'Adds development helpers.',
        category: 'dev-tools',
        icon: 'icons/dev-helper.svg',
        latest: 1,
        source: 'https://github.com/sprintengine/studio-releases/plugins/dev-helper',
        provides: ['mcp', 'skills', 'module', 'cli'],
        signature: VALID_SIGNATURE,
      },
    ],
  }

  // Inline-MCP entry: no bundle source, no signature, categories[]/tags[], and a
  // raw MCP server config.
  const VALID_INLINE_MCP_ENTRY = {
    id: 'live-search-mcp',
    name: 'Live Search MCP',
    publisher: { name: 'Community Author', verified: false },
    summary: 'Adds a hosted web search MCP server.',
    categories: ['Search', 'Web'],
    tags: ['search', 'web'],
    icon: 'icons/live-search.svg',
    latest: 1,
    provides: ['mcp'],
    mcp: {
      servers: [
        {
          id: 'live-search',
          name: 'Live Search',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          clients: ['codex', 'claude'],
        },
      ],
    },
  }

  // Inline-CLI entry: no bundle source, no signature — the entry
  // surfaces an app-bundled CLI plugin whose install spec the runtime installer
  // executes; `cli.pluginId` names that plugin in the plugin registry.
  const VALID_INLINE_CLI_ENTRY = {
    id: 'claude-code',
    name: 'Claude Code',
    publisher: { name: 'SprintEngine Labs', verified: true },
    summary: "Anthropic's terminal coding agent.",
    category: 'Agent CLI',
    icon: 'icons/claude-code.svg',
    latest: 1,
    provides: ['cli'],
    cli: { pluginId: 'claude-code' },
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
    validator: (
      value: unknown,
    ) => { ok: true } | { ok: false; issues: Array<{ path: string }> } = validateMarketplacePluginManifest,
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
      assert.equal(result.manifest.components.automation?.path, 'automation/automation.json')
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
      {
        ...VALID_PLUGIN,
        components: { mcp: { path: 'mcp/server.json', files: [{ path: 'other/server.json', sha256: VALID_DIGEST }] } },
      },
      'components.mcp.files[0].path',
    )
    assertRejectsAt(
      {
        ...VALID_PLUGIN,
        components: { mcp: { path: 'mcp/server.json', files: [{ path: 'mcp/server.json', sha256: 'BAD' }] } },
      },
      'components.mcp.files[0].sha256',
    )
    assertRejectsAt(
      { ...VALID_PLUGIN, components: { mcp: { path: 'mcp/server.json', extra: true } } },
      'components.mcp.extra',
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
      const entry = result.marketplace.plugins[0]
      assert.equal(result.marketplace.schemaVersion, 1)
      assert.equal(entry.publisher.verified, true)
      assert.deepEqual(entry.provides, ['mcp', 'skills', 'module', 'cli'])
      // Legacy singular category parses and no widened fields are invented.
      assert.equal(entry.category, 'dev-tools')
      assert.equal(entry.categories, undefined)
      assert.equal(entry.tags, undefined)
      assert.equal(entry.mcp, undefined)
    }
  }

  function testInlineMcpEntryValidates(): void {
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [VALID_INLINE_MCP_ENTRY] })
    assert.equal(result.ok, true)
    if (result.ok) {
      const entry = result.marketplace.plugins[0]
      assert.equal(entry.source, undefined)
      assert.equal(entry.signature, undefined)
      assert.deepEqual(entry.provides, ['mcp'])
      assert.deepEqual(entry.categories, ['Search', 'Web'])
      assert.deepEqual(entry.tags, ['search', 'web'])
      assert.equal(entry.category, 'Search') // derived from categories[0]
      assert.equal(entry.mcp?.servers.length, 1)
      assert.equal(entry.mcp?.servers[0].transport, 'http')
      assert.equal(entry.mcp?.servers[0].url, 'https://mcp.example.com/mcp')
    }
  }

  function testBundleEntryWithoutSignatureValidates(): void {
    const unsigned = withoutField(VALID_MARKETPLACE.plugins[0], 'signature')
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [unsigned] })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.marketplace.plugins[0].signature, undefined)
  }

  function testGeneratedClaudePluginShapedEntryValidates(): void {
    // The shape a claude-plugins-official entry took in the frozen registry:
    // unsigned, source-bearing, skills-providing, data-URI icon, categories +
    // tags arrays, latest pinned to 1. No entry like this ships any more — the
    // retirement (2026-09-06) removed all 256 — but the schema still has to
    // accept one, because the format is what a signed skill bundle would use.
    const generated = {
      id: 'anthropic-github',
      name: 'github',
      publisher: { name: 'Anthropic', verified: false },
      summary: 'GitHub workflows for Claude Code.',
      category: 'development',
      categories: ['development'],
      tags: ['git', 'automation'],
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      source: 'https://github.com/anthropics/claude-plugins-official',
    }
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [generated] })
    assert.equal(result.ok, true)
    if (result.ok) {
      const entry = result.marketplace.plugins[0]
      assert.equal(entry.signature, undefined)
      assert.deepEqual(entry.provides, ['skills'])
      assert.equal(entry.category, 'development')
      assert.equal(entry.icon.startsWith('data:image/svg+xml;base64,'), true)
    }
  }

  function testBundledSkillsValidateAndSurvive(): void {
    // Enumerated per-plugin skills must ride through the field-by-field
    // entry rebuild — a dropped array would silently blank every "Skills N"
    // detail. Path is optional; empty arrays are normalized away.
    const generated = {
      id: 'anthropic-huggingface-skills',
      name: 'huggingface-skills',
      publisher: { name: 'Anthropic', verified: false },
      summary: 'Build, train, evaluate, and use open source AI models.',
      category: 'development',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      source: 'https://github.com/huggingface/skills.git',
      skills: [
        { name: 'hf-cli', description: 'Hugging Face Hub CLI.', path: 'skills/hf-cli' },
        { name: 'huggingface-datasets', description: 'Dataset Viewer API workflows.' },
      ],
    }
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [generated] })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.marketplace.plugins[0].skills, [
        { name: 'hf-cli', description: 'Hugging Face Hub CLI.', path: 'skills/hf-cli' },
        { name: 'huggingface-datasets', description: 'Dataset Viewer API workflows.' },
      ])
    }
    // An empty skills array normalizes to an absent field.
    const empty = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [] }] })
    assert.equal(empty.ok, true)
    if (empty.ok) assert.equal(empty.marketplace.plugins[0].skills, undefined)
    // Malformed shapes are rejected at their path, never silently dropped.
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: 'not-an-array' }] },
      'plugins[0].skills',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [{ description: 'nameless' }] }] },
      'plugins[0].skills[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [{ name: 'x', description: 'y', path: '' }] }] },
      'plugins[0].skills[0].path',
      validateMarketplaceIndex,
    )
    // A traversal or backslash path would escape the payload root when the
    // install derives the folder — rejected even for metadata-only skills.
    for (const evil of ['../escape', 'skills/..\\..\\evil', '/abs/skill', 'skills/./x']) {
      assertRejectsAt(
        { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [{ name: 'x', description: 'y', path: evil }] }] },
        'plugins[0].skills[0].path',
        validateMarketplaceIndex,
      )
    }
  }

  function testBundledSkillContentDigestsValidateAndSurvive(): void {
    const digest = 'a'.repeat(64)
    const files = [
      { path: 'SKILL.md', sha256: digest, size: 42 },
      { path: 'scripts/run.py', sha256: 'b'.repeat(64), size: 7 },
    ]
    const generated = {
      id: 'anthropic-vercel',
      name: 'vercel',
      publisher: { name: 'Anthropic', verified: false },
      summary: 'Vercel skills.',
      category: 'development',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      source: 'https://github.com/vercel/skills.git',
      skills: [{ name: 'vercel', description: 'Deploy.', path: 'skills/vercel', files, contentDigest: digest }],
    }
    // Content digests ride through the rebuild — the offline install
    // verifies bundled bytes against exactly these.
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [generated] })
    assert.equal(result.ok, true, JSON.stringify(!result.ok && result.issues))
    if (result.ok) {
      assert.deepEqual(result.marketplace.plugins[0].skills?.[0].files, files)
      assert.equal(result.marketplace.plugins[0].skills?.[0].contentDigest, digest)
    }

    const withSkill = (skill: Record<string, unknown>) => ({
      ...VALID_MARKETPLACE,
      plugins: [{ ...generated, skills: [skill] }],
    })
    const base = { name: 'vercel', description: 'Deploy.', path: 'skills/vercel' }
    // files and contentDigest only come as a pair.
    assertRejectsAt(withSkill({ ...base, files }), 'plugins[0].skills[0]', validateMarketplaceIndex)
    assertRejectsAt(withSkill({ ...base, contentDigest: digest }), 'plugins[0].skills[0]', validateMarketplaceIndex)
    // A digest-bearing skill needs the folder path used to locate the payload.
    assertRejectsAt(
      withSkill({ name: 'vercel', description: 'Deploy.', files, contentDigest: digest }),
      'plugins[0].skills[0].path',
      validateMarketplaceIndex,
    )
    // Malformed digests, traversal paths, and duplicates all fail the index.
    assertRejectsAt(
      withSkill({ ...base, files: [{ path: 'SKILL.md', sha256: 'nope', size: 1 }], contentDigest: digest }),
      'plugins[0].skills[0].files[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files: [{ path: '../escape.md', sha256: digest, size: 1 }], contentDigest: digest }),
      'plugins[0].skills[0].files[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files: [files[0], files[0]], contentDigest: digest }),
      'plugins[0].skills[0].files[1].path',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files: [], contentDigest: digest }),
      'plugins[0].skills[0].files',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files, contentDigest: 'not-hex' }),
      'plugins[0].skills[0].contentDigest',
      validateMarketplaceIndex,
    )
  }

  function testEntryRejectsSourceAndMcpTogether(): void {
    const hybrid = { ...VALID_MARKETPLACE.plugins[0], mcp: VALID_INLINE_MCP_ENTRY.mcp }
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [hybrid] }, 'plugins[0]', validateMarketplaceIndex)
  }

  function testEntryRejectsNeitherSourceNorMcp(): void {
    const bare = withoutField(VALID_INLINE_MCP_ENTRY, 'mcp')
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [bare] }, 'plugins[0]', validateMarketplaceIndex)
  }

  function testInlineCliEntryValidates(): void {
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [VALID_INLINE_CLI_ENTRY] })
    assert.equal(result.ok, true, 'inline-CLI entry should validate')
    if (result.ok) {
      const entry = result.marketplace.plugins[0]
      assert.deepEqual(entry.provides, ['cli'])
      assert.equal(entry.source, undefined)
      assert.deepEqual(entry.cli, { pluginId: 'claude-code' })
    }
  }

  function testInlineCliRejectsOtherShapesAndBadPluginId(): void {
    assertRejectsAt(
      {
        ...VALID_MARKETPLACE,
        plugins: [{ ...VALID_INLINE_CLI_ENTRY, source: 'https://github.com/sprintengine/studio-releases' }],
      },
      'plugins[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, mcp: VALID_INLINE_MCP_ENTRY.mcp }] },
      'plugins[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, provides: ['cli', 'skills'] }] },
      'plugins[0].provides',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, cli: {} }] },
      'plugins[0].cli.pluginId',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, cli: { pluginId: 'Not A Plugin Id' } }] },
      'plugins[0].cli.pluginId',
      validateMarketplaceIndex,
    )
  }

  function testInlineMcpRejectsNonMcpProvides(): void {
    const bad = { ...VALID_INLINE_MCP_ENTRY, provides: ['mcp', 'skills'] }
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [bad] }, 'plugins[0].provides', validateMarketplaceIndex)
  }

  function testInlineMcpRejectsInvalidAndEmptyServers(): void {
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_MCP_ENTRY, mcp: { servers: [{ id: 'broken' }] } }] },
      'plugins[0].mcp.servers[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_MCP_ENTRY, mcp: { servers: [] } }] },
      'plugins[0].mcp.servers',
      validateMarketplaceIndex,
    )
  }

  function testCategoriesAndTagsMustBeStringArrays(): void {
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_MCP_ENTRY, categories: 'Search' }] },
      'plugins[0].categories',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_MCP_ENTRY, tags: [''] }] },
      'plugins[0].tags[0]',
      validateMarketplaceIndex,
    )
  }

  function testCanonicalSourceConstantExported(): void {
    assert.deepEqual(MARKETPLACE_CANONICAL_SOURCE, { owner: 'sprintengine', repo: 'studio-releases', ref: 'main' })
  }

  function testMarketplaceMissingTopLevelFields(): void {
    assertRejectsAt(withoutField(VALID_MARKETPLACE, 'schemaVersion'), 'schemaVersion', validateMarketplaceIndex)
    assertRejectsAt(withoutField(VALID_MARKETPLACE, 'plugins'), 'plugins', validateMarketplaceIndex)
  }

  function testMarketplaceMissingPluginFields(): void {
    // source and signature are now optional; a bundle entry with source but no
    // signature stays valid, and the source/mcp XOR check owns the missing-source
    // rejection (covered by testEntryRejectsNeitherSourceNorMcp).
    const required = ['id', 'name', 'publisher', 'summary', 'category', 'icon', 'latest', 'provides']
    for (const field of required) {
      const plugin = withoutField(VALID_MARKETPLACE.plugins[0], field)
      assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [plugin] }, `plugins[0].${field}`, validateMarketplaceIndex)
    }
  }

  function testMarketplaceRejectsNestedInvalidFields(): void {
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], publisher: { verified: true } }] },
      'plugins[0].publisher.name',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      {
        ...VALID_MARKETPLACE,
        plugins: [{ ...VALID_MARKETPLACE.plugins[0], publisher: { name: 'SprintEngine Labs' } }],
      },
      'plugins[0].publisher.verified',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], provides: ['mcp', 'theme'] }] },
      'plugins[0].provides[1]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], signature: { algorithm: 'rsa' } }] },
      'plugins[0].signature.algorithm',
      validateMarketplaceIndex,
    )
  }

  function testParseMarketplaceInvalidJson(): void {
    assert.equal(parseMarketplaceIndex('{not json').ok, false)
  }

  function testAutomationIsAComponentKind(): void {
    assert.deepEqual([...MARKETPLACE_COMPONENT_KINDS], ['mcp', 'skills', 'module', 'cli', 'automation'])
    const result = validateMarketplaceIndex({
      ...VALID_MARKETPLACE,
      plugins: [{ ...VALID_MARKETPLACE.plugins[0], provides: ['automation'] }],
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.marketplace.plugins[0]?.provides, ['automation'])
  }

  function testAutomationPayloadStructure(): void {
    assert.deepEqual(marketplaceAutomationPayloadIssues(JSON.stringify(VALID_AUTOMATION_PAYLOAD)), [])

    assert.deepEqual(issuePaths(marketplaceAutomationPayloadIssues('{not json')), ['components.automation'])
    assert.deepEqual(issuePaths(marketplaceAutomationPayloadIssues('[]')), ['components.automation'])

    for (const [field, path] of [
      ['name', 'components.automation.name'],
      ['trigger', 'components.automation.trigger'],
      ['action', 'components.automation.action'],
    ] as const) {
      const issues = marketplaceAutomationPayloadIssues(JSON.stringify(withoutField(VALID_AUTOMATION_PAYLOAD, field)))
      assert.deepEqual(issuePaths(issues), [path], `missing ${field} must be reported at ${path}`)
    }

    const untypedTrigger = marketplaceAutomationPayloadIssues(
      JSON.stringify({ ...VALID_AUTOMATION_PAYLOAD, trigger: { config: {} } }),
    )
    assert.deepEqual(issuePaths(untypedTrigger), ['components.automation.trigger.kind'])
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
  testInlineMcpEntryValidates()
  testBundleEntryWithoutSignatureValidates()
  testGeneratedClaudePluginShapedEntryValidates()
  testBundledSkillsValidateAndSurvive()
  testBundledSkillContentDigestsValidateAndSurvive()
  testEntryRejectsSourceAndMcpTogether()
  testEntryRejectsNeitherSourceNorMcp()
  testInlineCliEntryValidates()
  testInlineCliRejectsOtherShapesAndBadPluginId()
  testInlineMcpRejectsNonMcpProvides()
  testInlineMcpRejectsInvalidAndEmptyServers()
  testCategoriesAndTagsMustBeStringArrays()
  testCanonicalSourceConstantExported()
  testMarketplaceMissingTopLevelFields()
  testMarketplaceMissingPluginFields()
  testMarketplaceRejectsNestedInvalidFields()
  testParseMarketplaceInvalidJson()
  testAutomationIsAComponentKind()
  testAutomationPayloadStructure()
  console.log('marketplace manifest tests passed')
})
