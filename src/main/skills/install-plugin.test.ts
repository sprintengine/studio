// Installing a plugin into a workspace: Claude Code gets the native enablement
// keys merged into its settings, every other harness gets the skills copied,
// and uninstall takes back exactly what install wrote and nothing else.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyPluginComponents, type ScannedPlugin, type ScannedSkill } from '../../shared/skills'
import { readSkillProvenance } from './install'
import {
  CLAUDE_SETTINGS_RELATIVE_PATH,
  claudePluginKey,
  installPlugin,
  mcpServerConfigFromScanned,
  readEnabledClaudePlugins,
  uninstallPlugin,
} from './install-plugin'

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

async function nativeForClaudeSkillsForOthers(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  // A person's own settings must survive untouched.
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH),
    JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'other@elsewhere': true } }, null, 2)
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
  assert.equal(byHarness.get('claude')?.mode, 'native')
  assert.equal(byHarness.get('codex')?.mode, 'skills')
  assert.deepEqual(byHarness.get('codex')?.skillDirNames, ['review'])
  assert.equal(byHarness.get('agents')?.mode, 'skills')
  assert.match(byHarness.get('codex')?.message ?? '', /hooks have no equivalent/)

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

  // Skills copied for the non-native harnesses, with provenance, and NOT for
  // Claude, which loads the plugin itself.
  for (const dir of ['.codex', '.agents']) {
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
  assert.equal(existsSync(join(workspace, '.claude', 'skills', 'review')), false)

  // MCP servers come back shaped for the settings store.
  assert.equal(result.mcpServers.length, 1)
  assert.equal(result.mcpServers[0].id, 'context7')
  assert.equal(result.mcpServers[0].source, 'custom')
  assert.equal(result.mcpServers[0].riskLevel, 'secrets')
  assert.deepEqual(result.mcpServers[0].clients, ['claude-code', 'codex'])

  // Uninstall: the key goes, the marketplace registration and the other
  // plugin stay, the copies go.
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
  assert.equal(removed.removedPaths.length, 2)
  const after = JSON.parse(await readFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8'))
  assert.deepEqual(Object.keys(after.enabledPlugins), ['other@elsewhere'])
  assert.ok(after.extraKnownMarketplaces['claude-plugins-official'])
  assert.equal(existsSync(join(workspace, '.codex', 'skills', 'review')), false)
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
    plugin: plugin({ components: { ...emptyPluginComponents(), hooks: [{ event: 'Stop', matcher: '', command: 'x' }] } }),
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
    harnesses: ['codex'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: [],
  })
  assert.equal(unread.ok, false)
}

async function settingsThatDoNotParseAreLeftAlone(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'multicode-plugin-install-'))
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), '{ "permissions": ')
  const result = await installPlugin({
    workspaceRoot: workspace,
    sourceId: 's',
    marketplaceName: 'm',
    marketplaceRepo: 'o/r',
    plugin: plugin({ components: emptyPluginComponents() }),
    harnesses: ['claude'],
    commitSha: 'abc',
    readSkillFile: READ,
    mcpClients: [],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /not valid JSON, so it was left alone/)
  assert.equal(await readFile(join(workspace, CLAUDE_SETTINGS_RELATIVE_PATH), 'utf8'), '{ "permissions": ')
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
    ['codex']
  )
  assert.equal(stdio.riskLevel, 'local-command')
  assert.equal(stdio.command, 'npx')
  assert.equal(stdio.url, undefined)
  assert.equal(stdio.description, 'Declared by the p plugin.')
}

async function main(): Promise<void> {
  await nativeForClaudeSkillsForOthers()
  await pluginOnlyRepositoryCopiesSkillsToClaudeToo()
  await nothingToInstallIsSaidNotHidden()
  await settingsThatDoNotParseAreLeftAlone()
  shapes()
  console.log('skills plugin install tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
