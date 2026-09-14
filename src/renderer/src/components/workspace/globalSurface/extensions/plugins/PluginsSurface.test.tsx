import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { emptyPluginComponents, type ScannedPlugin, type SkillSource } from '../../../../../../../shared/skills'
import { PluginDetailPane, type PluginDetailPaneProps } from './PluginDetailPane'

// What the plugin DETAIL PANE owes: a catalogue of skills and MCP servers
// with per-item Install, hooks disclosed verbatim, and Remove on the plugin
// taking back everything it wrote. There is no bulk install — that is how
// one marketplace plugin used to copy every skill it shipped into every agent.

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
    strict: true,
    tags: [],
    keywords: [],
    componentsKnown: true,
    components: emptyPluginComponents(),
    ...over,
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
      availability={{ enabled: true, reason: null }}
      installedDirNames={new Set()}
      installedMcpIds={new Set()}
      busyItem={null}
      onInstallSkill={() => {}}
      onRemoveSkill={() => {}}
      onInstallMcp={() => {}}
      onRemoveMcp={() => {}}
      onUpdateInstalled={() => {}}
      onUninstall={() => {}}
      onClose={() => {}}
      {...over}
    />,
  )
}

run('the pane discloses hook commands verbatim and does not gate item install on them', () => {
  const markup = pane()
  assert.ok(markup.includes('PreToolUse on Edit|Write: node &quot;${CLAUDE_PLUGIN_ROOT}/hooks/check.js&quot;'), 'the command, verbatim')
  assert.ok(markup.includes('declares a hook command'), 'the warning names what the plugin carries')
  assert.ok(markup.includes('Installing a skill or server here copies no hooks'), 'and what an install here does with it')
  assert.equal(markup.includes('type="checkbox"'), false, 'no acknowledgement gate — hooks are not copied')
  assert.equal(markup.includes('Install to this workspace'), false, 'there is no all-in install')
  assert.equal(markup.includes('Enabled as security-guidance@claude-plugins-official'), false)
  assert.ok(markup.includes('Its hooks are not installed'), 'Claude Code is told what does not land')
  assert.equal(markup.includes('also names security-guidance@claude-plugins-official'), false)
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
  })
  assert.ok(markup.includes('Reading 42Crunch-AI/claude-plugins…'))
  assert.equal(markup.includes('>None<'), false, 'no component row claims emptiness')
  assert.ok(markup.includes('Known once the plugin has been read'))
})

run('each skill is its own install, and Use in agent appears only once it is in the workspace', () => {
  const withSkills = plugin('code-review', {
    components: {
      ...emptyPluginComponents(),
      skills: [
        { id: 'plugins/code-review/skills/review', name: 'review', description: 'Review a diff', group: '', files: [], allowedTools: [], hasExecutables: false },
        { id: 'plugins/code-review/skills/triage', name: 'triage', description: '', group: '', files: [], allowedTools: [], hasExecutables: false },
      ],
    },
  })

  const available = pane({
    plugin: withSkills,
    workspaceRoot: '/ws',
    availability: { enabled: true, reason: null },
  })
  assert.ok(available.includes('>review<') && available.includes('>triage<'), 'each skill by name')
  assert.ok(available.includes('aria-label="Install review"') && available.includes('aria-label="Install triage"'), 'each skill installs itself')
  assert.equal(available.includes('>Use in agent<'), false, 'nothing to use until it is copied')
  assert.ok(available.includes('Review a diff'), 'the description the agent matches on rides along')

  const installed = pane({
    plugin: withSkills,
    workspaceRoot: '/ws',
    availability: { enabled: true, reason: null },
    installedDirNames: new Set(['review', 'triage']),
    install: {
      kind: 'installed',
      record: {
        workspaceRoot: '/ws',
        sourceId: SOURCE.id,
        pluginId: 'code-review',
        pluginName: 'code-review',
        marketplaceName: 'claude-plugins-official',
        claudePluginKey: '',
        skillDirNames: ['review', 'triage'],
        mcpServerIds: [],
        commitSha: '1111111',
        installedAt: '',
      },
    },
  })
  assert.equal(
    (installed.match(/<button[^>]*aria-haspopup="menu"[^>]*>Use in agent<\/button>/g) ?? []).length,
    2,
    'two skills, two menu buttons — the page does not guess which was meant',
  )
  assert.ok(installed.includes('aria-label="Remove review"'), 'and each can be taken back')
  assert.ok(installed.includes('>Remove plugin<'), 'the plugin itself can still be wiped')
})

run('an installed plugin offers Remove plugin and Update installed when the source has moved', () => {
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
  assert.ok(markup.includes('>Remove plugin<'))
  assert.ok(markup.includes('Update installed'))
  assert.ok(markup.includes('Installed from this source at 1111111'))
})

console.log('plugin detail pane: ok')
