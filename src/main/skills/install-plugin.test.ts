// Installing a plugin into a workspace: EVERY harness gets the skills copied,
// Claude Code included; the two Claude settings keys ride along as an extra
// nothing depends on; and uninstall takes back exactly what install wrote and
// nothing else
// (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyPluginComponents, type ScannedPlugin, type ScannedSkill } from '../../shared/skills'
import { STUDIO_PLUGIN_ID } from '../../shared/studio-plugin'
import { readSkillProvenance } from './install'
import {
  CLAUDE_SETTINGS_RELATIVE_PATH,
  claudePluginKey,
  installPlugin,
  mcpServerConfigFromScanned,
  readEnabledClaudePlugins,
  selectPluginItems,
  uninstallPlugin,
} from './install-plugin'
import { mergeInstalledPluginRecord } from './plugin-install-store'

function skill(id: string): ScannedSkill {
  return {
    id,
    name: id.split('/').pop() ?? id,
    description: '',
    group: '',
    files: [
      { path: 'SKILL.md', size: 1, blobSha: '', isEntry: true },
      { path: 'reference/notes.md', size: 1, blobSha: '', isEntry: false },
    ],
    allowedTools: [],
    hasExecutables: false,
  }
}

function plugin(over: Partial<ScannedPlugin> = {}): ScannedPlugin {
  return {
    id: 'security-guidance',
    name: 'security-guidance',
    description: 'Warns before risky edits',
    version: '2.0.7',
    category: 'security',
    author: 'Anthropic',
    homepage: '',
    origin: { kind: 'in-tree', path: 'plugins/security-guidance' },
    strict: true,
    tags: [],
    keywords: [],
    componentsKnown: true,
    components: {
      ...emptyPluginComponents(),
      skills: [skill('plugins/security-guidance/skills/review')],
      hooks: [{ event: 'PreToolUse', matcher: 'Edit', command: 'node check.js' }],
      mcpServers: [
        {
          id: 'context7',
          name: 'context7',
          description: '',
          transport: 'http',
          command: '',
          args: [],
          url: 'https://mcp.context7.com/mcp',
          env: {},
          envVarNames: ['CONTEXT7_API_KEY'],
          headers: { Authorization: '${CONTEXT7_API_KEY:-}' },
          declaredIn: '.mcp.json',
          declaredBy: 'security-guidance',
        },
      ],
    },
    ...over,
  }
}

const READ = async (_skill: ScannedSkill, file: { path: string }): Promise<Buffer> =>
  Buffer.from(`bytes of ${file.path}\n`, 'utf8')

async function claudeIsCopiedForLikeEveryOtherHarness(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  // A person's own settings must survive untouched.
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH),
    JSON.stringify(
      { permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'other@elsewhere': true } },
      null,
      2,
    ),
  )

  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 'github:anthropics/claude-plugins-official',
    marketplaceName: 'claude-plugins-official',
    marketplaceRepo: 'anthropics/claude-plugins-official',
    plugin: plugin(),
    harnesses: ['claude', 'codex', 'agents'],
    commitSha: '85cce03',
    readSkillFile: READ,
    mcpClients: ['claude-code', 'codex'],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.equal(result.claudePluginKey, 'security-guidance@claude-plugins-official')
  const byHarness = new Map(result.harnesses.map((outcome) => [outcome.harness, outcome]))
  for (const harness of ['claude', 'codex', 'agents'] as const) {
    assert.equal(byHarness.get(harness)?.mode, 'skills', `${harness} is copied for`)
    assert.deepEqual(byHarness.get(harness)?.skillDirNames, ['review'])
  }
  // The same components are unsupported everywhere; only Claude Code is told
  // WHY differently, because it is the one harness that has them.
  assert.match(byHarness.get('codex')?.message ?? '', /hooks have no equivalent here/)
  assert.match(byHarness.get('claude')?.message ?? '', /hooks are not installed/)
  assert.match(byHarness.get('claude')?.message ?? '', /claude plugin install/)

  // The settings file: merged, the other plugin and the permissions kept.
  const settings = JSON.parse(await readFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8'))
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] })
  assert.equal(settings.enabledPlugins['other@elsewhere'], true)
  assert.equal(settings.enabledPlugins['security-guidance@claude-plugins-official'], true)
  assert.deepEqual(settings.extraKnownMarketplaces['claude-plugins-official'], {
    source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
  })
  assert.deepEqual([...(await readEnabledClaudePlugins(workspace))].sort(), [
    'other@elsewhere',
    'security-guidance@claude-plugins-official',
  ])

  // Skills copied for every harness, Claude Code included, with provenance.
  // This is the bug: `.claude/skills/review` used not to exist at all.
  for (const dir of ['.claude', '.codex', '.agents']) {
    const root = join(workspace, dir, 'skills', 'review')
    assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), 'bytes of SKILL.md\n')
    assert.equal(await readFile(join(root, 'reference', 'notes.md'), 'utf8'), 'bytes of reference/notes.md\n')
    const provenance = await readSkillProvenance(root)
    assert.deepEqual(provenance, {
      sourceId: 'github:anthropics/claude-plugins-official',
      skillId: 'plugins/security-guidance/skills/review',
      commitSha: '85cce03',
    })
  }

  // MCP servers come back shaped for the settings store, for Claude Code's own
  // client among others — that is how they reach the workspace's `.mcp.json`.
  assert.equal(result.mcpServers.length, 1)
  assert.equal(result.mcpServers[0].id, 'context7')
  assert.equal(result.mcpServers[0].source, 'source', 'and say which source installed them')
  assert.equal(result.mcpServers[0].riskLevel, 'secrets')
  assert.deepEqual(result.mcpServers[0].clients, ['claude-code', 'codex'])

  // Uninstall: the key goes, the marketplace registration and the other
  // plugin stay, every copy goes — `.claude/skills` included.
  const removed = await uninstallPlugin({
    workspaceRoot: workspace,
    pluginId: 'security-guidance',
    marketplaceName: 'claude-plugins-official',
    skillDirNames: ['review'],
    allHarnesses: ['claude', 'codex', 'agents'],
  })
  assert.equal(removed.ok, true)
  if (!removed.ok) return
  assert.equal(removed.disabledClaudePluginKey, 'security-guidance@claude-plugins-official')
  assert.deepEqual(removed.warnings, [])
  assert.equal(removed.removedPaths.length, 3)
  const after = JSON.parse(await readFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8'))
  assert.deepEqual(Object.keys(after.enabledPlugins), ['other@elsewhere'])
  assert.ok(after.extraKnownMarketplaces['claude-plugins-official'])
  for (const dir of ['.claude', '.codex', '.agents']) {
    assert.equal(existsSync(join(workspace, dir, 'skills', 'review')), false)
  }
}

/**
 * The keys are an extra. A settings file nobody can parse is a warning beside a
 * completed install, because the copy is what delivers the plugin — the whole
 * correction of 2026-09-06.
 */
async function theSettingsKeysAreAnExtraNothingDependsOn(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), '{ "permissions": ')
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 's',
    marketplaceName: 'm',
    marketplaceRepo: 'o/r',
    plugin: plugin(),
    harnesses: ['claude'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: ['claude-code'],
  })
  assert.equal(result.ok, true, 'the skills still land')
  if (!result.ok) return
  assert.equal(existsSync(join(workspace, '.claude', 'skills', 'review', 'SKILL.md')), true)
  assert.equal(result.claudePluginKey, '', 'no key was written, and none is claimed')
  assert.match(result.warnings.join(' '), /not valid JSON, so it was left alone/)
  // The file a person was mid-edit in is untouched.
  assert.equal(await readFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8'), '{ "permissions": ')

  // And the same on the way out: the copies go, the unreadable file is said.
  const removed = await uninstallPlugin({
    workspaceRoot: workspace,
    pluginId: 'security-guidance',
    marketplaceName: 'm',
    skillDirNames: ['review'],
    allHarnesses: ['claude'],
  })
  assert.equal(removed.ok, true)
  if (!removed.ok) return
  assert.equal(existsSync(join(workspace, '.claude', 'skills', 'review')), false)
  assert.match(removed.warnings.join(' '), /not valid JSON/)
}

/**
 * The app's own plugin installs itself, by materialising the bundled template
 * and copying from that (studio-plugin.ts). A catalogue install would be a
 * second copy of the same skills — so it is refused wherever it is reached
 * from, not only hidden on our own tab.
 */
async function theAppsOwnPluginIsNeverInstalledTwice(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 'github:sprintengine/studio-releases',
    marketplaceName: 'sprintengine-studio',
    marketplaceRepo: 'sprintengine/studio-releases',
    plugin: plugin({ id: STUDIO_PLUGIN_ID, name: 'SprintEngine Studio' }),
    harnesses: ['claude', 'codex'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: ['claude-code'],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /built in/)
  assert.equal(existsSync(join(workspace, '.claude')), false, 'nothing was written at all')
}

async function pluginOnlyRepositoryCopiesSkillsToClaudeToo(): Promise<void> {
  // No marketplace name: Claude Code cannot be pointed at it, so it gets the
  // skills copy like everyone else.
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 'github:acme/plugin',
    marketplaceName: '',
    marketplaceRepo: 'acme/plugin',
    plugin: plugin({ components: { ...emptyPluginComponents(), skills: [skill('skills/review')] } }),
    harnesses: ['claude', 'agents'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: [],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.claudePluginKey, '')
  assert.ok(result.harnesses.every((outcome) => outcome.mode === 'skills'))
  assert.equal(existsSync(join(workspace, '.claude', 'skills', 'review', 'SKILL.md')), true)
  assert.equal(existsSync(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH)), false)
}

async function nothingToInstallIsSaidNotHidden(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  // Hooks only, no marketplace, no Claude: nothing any harness here can use.
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 'github:acme/hooks',
    marketplaceName: '',
    marketplaceRepo: 'acme/hooks',
    plugin: plugin({
      components: { ...emptyPluginComponents(), hooks: [{ event: 'Stop', matcher: '', command: 'x' }] },
    }),
    harnesses: ['codex', 'agents'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: [],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /hooks are Claude Code-format/)

  // An unread linked plugin refuses rather than installing an empty guess.
  const unread = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 's',
    marketplaceName: 'm',
    marketplaceRepo: 'o/r',
    plugin: plugin({ componentsKnown: false, components: emptyPluginComponents() }),
    // Claude Code included: the copy for it sits behind the same guard, so a
    // plugin whose hooks file failed to fetch cannot slip past the
    // acknowledgement by being installed for Claude Code (6803a703d).
    harnesses: ['claude', 'codex'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: [],
  })
  assert.equal(unread.ok, false)
  if (unread.ok) return
  // The shared words, not this file's own: a partly-read plugin is told which
  // files went missing, never that the source lists too many plugins.
  const partial = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 's',
    marketplaceName: 'm',
    marketplaceRepo: 'o/r',
    plugin: plugin({
      componentsKnown: false,
      readState: { status: 'partial', unread: ['hooks/hooks.json'] },
      components: emptyPluginComponents(),
    }),
    harnesses: ['claude'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: [],
  })
  assert.equal(partial.ok, false)
  if (partial.ok) return
  assert.match(partial.message, /hooks\/hooks\.json could not be read/)
  assert.equal(/lists more plugins than one scan reads/.test(partial.message), false)
}

function shapes(): void {
  assert.equal(claudePluginKey('code-review', 'claude-plugins-official'), 'code-review@claude-plugins-official')
  const stdio = mcpServerConfigFromScanned(
    {
      id: 'thing',
      name: 'thing',
      description: '',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'thing'],
      url: '',
      env: {},
      envVarNames: [],
      headers: {},
      declaredIn: '.mcp.json',
      declaredBy: 'p',
    },
    ['codex'],
  )
  assert.equal(stdio.riskLevel, 'local-command')
  assert.equal(stdio.command, 'npx')
  assert.equal(stdio.url, undefined)
  assert.equal(stdio.description, 'Declared by the p plugin.')
  assert.equal(stdio.source, 'custom', 'with no source reference it is a server nothing re-reads')
}

/**
 * The servers an install hands back name the source that installed them, so a
 * later Sync of that source can refresh exactly these entries
 * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
 */
async function installedServersCarryTheirSource(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-mcp-'))
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 'github:anthropics/claude-plugins-official',
    marketplaceName: 'claude-plugins-official',
    marketplaceRepo: 'anthropics/claude-plugins-official',
    plugin: plugin(),
    harnesses: ['codex'],
    commitSha: 'deadbee',
    readSkillFile: READ,
    mcpClients: ['codex', 'claude-code'],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.mcpServers.length, 1)
  const server = result.mcpServers[0]
  assert.equal(server.source, 'source')
  assert.deepEqual(server.sourceRef, {
    sourceId: 'github:anthropics/claude-plugins-official',
    itemId: 'context7',
    commitSha: 'deadbee',
  })
}

function aPluginIsACatalogueOfItems(): void {
  const pack = plugin({
    components: {
      ...emptyPluginComponents(),
      skills: [skill('plugins/x/skills/review'), skill('plugins/x/skills/audit')],
      mcpServers: plugin().components.mcpServers,
    },
  })
  const one = selectPluginItems(pack, { skillIds: ['plugins/x/skills/review'] })
  assert.equal(one.ok, true)
  if (!one.ok) return
  assert.equal(one.filtered, true)
  assert.deepEqual(
    one.plugin.components.skills.map((item) => item.id),
    ['plugins/x/skills/review'],
  )
  assert.deepEqual(one.plugin.components.mcpServers, [])

  const server = selectPluginItems(pack, { mcpServerIds: ['context7'] })
  assert.equal(server.ok, true)
  if (!server.ok) return
  assert.equal(server.plugin.components.skills.length, 0)
  assert.deepEqual(
    server.plugin.components.mcpServers.map((item) => item.id),
    ['context7'],
  )

  const missing = selectPluginItems(pack, { skillIds: ['plugins/x/skills/nope'] })
  assert.equal(missing.ok, false)
  const empty = selectPluginItems(pack, { skillIds: [] })
  assert.equal(empty.ok, false)
  const all = selectPluginItems(pack, {})
  assert.equal(all.ok, true)
  if (!all.ok) return
  assert.equal(all.filtered, false)
  assert.equal(all.plugin.components.skills.length, 2)
}

async function aFilteredInstallCopiesOnlyTheChosenSkill(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-item-'))
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ enabledPlugins: { 'other@elsewhere': true } }, null, 2),
  )
  const pack = plugin({
    components: {
      ...emptyPluginComponents(),
      skills: [skill('plugins/security-guidance/skills/review'), skill('plugins/security-guidance/skills/audit')],
      mcpServers: plugin().components.mcpServers,
    },
  })
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 'github:anthropics/claude-plugins-official',
    marketplaceName: 'claude-plugins-official',
    marketplaceRepo: 'anthropics/claude-plugins-official',
    plugin: pack,
    skillIds: ['plugins/security-guidance/skills/review'],
    harnesses: ['claude', 'codex', 'agents'],
    commitSha: '85cce03',
    readSkillFile: READ,
    mcpClients: ['claude-code', 'codex'],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.claudePluginKey, '', 'a one-item install does not enable the whole plugin for Claude Code')
  assert.deepEqual(result.mcpServers, [])
  for (const dir of ['.claude', '.codex', '.agents']) {
    assert.equal(existsSync(join(workspace, dir, 'skills', 'review', 'SKILL.md')), true)
    assert.equal(existsSync(join(workspace, dir, 'skills', 'audit')), false)
  }
  const settings = JSON.parse(await readFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8'))
  assert.deepEqual(Object.keys(settings.enabledPlugins ?? {}), ['other@elsewhere'])
}

function receiptsAccumulateItems(): void {
  const first = {
    workspaceRoot: '/ws',
    sourceId: 'github:acme/skills',
    pluginId: 'code-review',
    pluginName: 'code-review',
    marketplaceName: 'acme-plugins',
    claudePluginKey: '',
    skillDirNames: ['review'],
    mcpServerIds: [] as string[],
    commitSha: 'aaa',
    installedAt: '2026-09-12T00:00:00.000Z',
  }
  const merged = mergeInstalledPluginRecord(first, {
    ...first,
    skillDirNames: ['triage'],
    mcpServerIds: ['linear'],
    commitSha: 'bbb',
    installedAt: '2026-09-12T00:05:00.000Z',
  })
  assert.deepEqual(merged.skillDirNames, ['review', 'triage'])
  assert.deepEqual(merged.mcpServerIds, ['linear'])
  assert.equal(merged.commitSha, 'bbb')
  assert.equal(merged.installedAt, first.installedAt)
}

async function main(): Promise<void> {
  await claudeIsCopiedForLikeEveryOtherHarness()
  await theSettingsKeysAreAnExtraNothingDependsOn()
  await theAppsOwnPluginIsNeverInstalledTwice()
  await pluginOnlyRepositoryCopiesSkillsToClaudeToo()
  await nothingToInstallIsSaidNotHidden()
  await installedServersCarryTheirSource()
  aPluginIsACatalogueOfItems()
  await aFilteredInstallCopiesOnlyTheChosenSkill()
  receiptsAccumulateItems()
  shapes()
  console.log('skills plugin install tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
