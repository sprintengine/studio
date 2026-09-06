import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { emptyPluginComponents, type ScanResult, type ScannedPlugin, type SkillSource } from '../../../../../../../shared/skills'
import { PluginDetailPane, type PluginDetailPaneProps } from './PluginDetailPane'
import { PluginRow } from './PluginRow'
import { PluginsSurface } from './PluginsSurface'

// What the rendered surface owes: a plugin row is one target, the pane
// discloses every hook command verbatim and withholds Install until they are
// acknowledged, a linked plugin says it has not been read, and the source page
// states what else the source holds.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const SOURCE: SkillSource = {
  id: 'github:anthropics/claude-plugins-official',
  kind: 'github',
  name: 'claude-plugins-official',
  repo: 'anthropics/claude-plugins-official',
  monogram: 'AC',
  blurb: '',
  commitSha: '85cce0381e7860082641b59d961a2b8c368b8b79',
  scannedAt: '2026-09-05T09:00:00Z',
}

function plugin(id: string, over: Partial<ScannedPlugin> = {}): ScannedPlugin {
  return {
    id,
    name: id,
    description: `${id} does a thing`,
    version: '1.2.0',
    category: 'security',
    author: 'Anthropic',
    homepage: '',
    origin: { kind: 'in-tree', path: `plugins/${id}` },
    componentsKnown: true,
    components: emptyPluginComponents(),
    ...over,
  }
}

function scanOf(plugins: ScannedPlugin[]): ScanResult {
  return {
    skills: [{ id: 'plugins/a/skills/x', name: 'x', description: '', group: '', files: [], allowedTools: [], hasExecutables: false }],
    groups: [],
    groupingSignal: 'none',
    fileCount: 1,
    commitSha: SOURCE.commitSha,
    shape: 'claude-marketplace',
    marketplaceName: 'claude-plugins-official',
    plugins,
    mcpServers: [],
  }
}

function pane(over: Partial<PluginDetailPaneProps> = {}): string {
  return renderToStaticMarkup(
    <PluginDetailPane
      source={SOURCE}
      shape="claude-marketplace"
      marketplaceName="claude-plugins-official"
      plugin={plugin('security-guidance', {
        components: {
          ...emptyPluginComponents(),
          hooks: [{ event: 'PreToolUse', matcher: 'Edit|Write', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/check.js"' }],
        },
      })}
      reading={false}
      readError={null}
      onRetryRead={() => {}}
      harnesses={['claude', 'codex', 'agents']}
      install={{ kind: 'not-installed' }}
      availability={{ enabled: false, reason: 'Review the hook commands above, then confirm they may run.' }}
      installing={false}
      hooksAcknowledged={false}
      onHooksAcknowledgedChange={() => {}}
      onInstall={() => {}}
      onUninstall={() => {}}
      onClose={() => {}}
      {...over}
    />,
  )
}

run('the pane discloses hook commands verbatim and withholds Install until acknowledged', () => {
  const markup = pane()
  assert.ok(markup.includes('PreToolUse on Edit|Write: node &quot;${CLAUDE_PLUGIN_ROOT}/hooks/check.js&quot;'), 'the command, verbatim')
  assert.ok(markup.includes('runs a command on your machine'), 'the warning names what happens')
  assert.ok(markup.includes('type="checkbox"'), 'acknowledgement is a real checkbox')
  assert.ok(/<button[^>]*disabled=""[^>]*>Install to this workspace<\/button>/.test(markup), 'Install is disabled')
  assert.ok(markup.includes('Enabled as security-guidance@claude-plugins-official'), 'Claude Code gets native enablement')
  assert.ok(markup.includes('Its hooks are Claude Code-format'), 'Codex is told nothing lands')
  assert.ok(markup.includes('Open on GitHub'))
})

run('an unread linked plugin says its components are unknown, not empty', () => {
  const markup = pane({
    plugin: plugin('42crunch', {
      origin: { kind: 'linked', repo: '42Crunch-AI/claude-plugins', ref: 'v1', sha: '', path: 'plugins/x', url: 'https://github.com/42Crunch-AI/claude-plugins.git' },
      componentsKnown: false,
    }),
    reading: true,
    availability: { enabled: true, reason: null },
  })
  assert.ok(markup.includes('Reading 42Crunch-AI/claude-plugins…'))
  assert.equal(markup.includes('>None<'), false, 'no component row claims emptiness')
  assert.ok(markup.includes('Known once the plugin has been read'))
})

run('an installed plugin offers Remove and says which key it enabled', () => {
  const markup = pane({
    plugin: plugin('code-review'),
    install: {
      kind: 'update-available',
      record: {
        workspaceRoot: '/ws',
        sourceId: SOURCE.id,
        pluginId: 'code-review',
        pluginName: 'code-review',
        marketplaceName: 'claude-plugins-official',
        claudePluginKey: 'code-review@claude-plugins-official',
        skillDirNames: [],
        mcpServerIds: [],
        commitSha: '1111111',
        installedAt: '',
      },
    },
    availability: { enabled: true, reason: null },
  })
  assert.ok(markup.includes('>Remove<'))
  assert.ok(markup.includes('Update in this workspace'))
  assert.ok(markup.includes('Installed from this source at 1111111'))
})

run('a plugin row is one target with its state in words', () => {
  const markup = renderToStaticMarkup(
    <PluginRow
      item={{
        pluginId: 'a',
        name: 'a',
        description: 'does a thing',
        components: '4 skills · 1 MCP',
        hasHooks: false,
        linked: false,
        install: { kind: 'installed', record: { workspaceRoot: '', sourceId: '', pluginId: 'a', pluginName: 'a', marketplaceName: '', claudePluginKey: '', skillDirNames: [], mcpServerIds: [], commitSha: '', installedAt: '' } },
      }}
      selected
      onOpen={() => {}}
    />,
  )
  assert.equal((markup.match(/<button/g) ?? []).length, 1)
  assert.ok(markup.includes('aria-current="true"'))
  assert.ok(markup.includes('Installed'))
  assert.ok(markup.includes('4 skills · 1 MCP'))
})

run('the source page states the shape, the count, and what else the source holds', () => {
  const scan = scanOf([plugin('a'), plugin('b')])
  const markup = renderToStaticMarkup(
    <PluginsSurface
      sources={{
        sources: [SOURCE],
        sourcesLoad: { status: 'ready' },
        scans: { [SOURCE.id]: { status: 'ready', scan } },
        installedDirNames: new Set(),
        installedRead: { status: 'ready' },
        installedPlugins: [],
        installedPluginsRead: { status: 'ready' },
        refreshSources: () => {},
        refreshScan: () => {},
        refreshInstalled: () => {},
        applySync: () => {},
      }}
      workspaceRoot="/ws"
      harnesses={['claude']}
      selectedSourceId={SOURCE.id}
      onSelectSource={() => {}}
      onBrowseSkills={() => {}}
      onAddMcpServers={() => {}}
      onRemoveMcpServers={() => {}}
      onConfigureGitHubToken={() => {}}
      registry={{
        entries: [],
        load: { status: 'ready' },
        registryUrl: null,
        mcpSettings: { syncEnabled: true, servers: {} },
        onInstalled: () => {},
        onUpsertMcpServer: () => {},
      }}
    />,
  )
  assert.ok(markup.includes('Claude Code plugin marketplace · 2 plugins · 85cce03'))
  assert.ok(markup.includes('Also from this source:'))
  assert.ok(markup.includes('1 skill'))
  assert.ok(markup.includes('aria-label="Plugin sources"'), 'the sources rail is a nested nav')
  assert.ok(markup.includes('Plugins on GitHub'), 'the Discover foot says what it searches')
  assert.equal(markup.includes('Filter 2 plugins'), false, 'a short list is not filtered')
})

console.log('plugins surface: ok')
