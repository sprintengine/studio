import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { emptyPluginComponents, type ScannedPlugin, type SkillSource } from '../../../../../../../shared/skills'
import { PluginDetailPane, type PluginDetailPaneProps } from './PluginDetailPane'

// What the plugin DETAIL PANE owes: every hook command verbatim, Install
// withheld until they are acknowledged, and a linked plugin that says it has
// not been read rather than showing an empty component list.
//
// The rows and the source page left this file with the source-tabs ruling
// (2026-09-05): a plugin renders on the shared connector row now — icon chip,
// name and kind badge, one-line summary, one control — and the page around it
// is the catalogue frame, covered in catalogue/extensionsCatalogue.test.tsx.

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
  assert.ok(markup.includes('declares a hook command'), 'the warning names what the plugin carries')
  assert.ok(markup.includes('Installing here copies no hooks'), 'and what an install here does with it')
  assert.ok(markup.includes('type="checkbox"'), 'acknowledgement is a real checkbox')
  assert.ok(/<button[^>]*disabled=""[^>]*>Install to this workspace<\/button>/.test(markup), 'Install is disabled')
  // The Claude Code row: no native-load claim, the settings key named as the
  // extra it is, and the hooks stated as not installed rather than implied
  // (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
  assert.equal(markup.includes('Enabled as security-guidance@claude-plugins-official'), false)
  assert.ok(markup.includes('Its hooks are not installed'), 'Claude Code is told what does not land')
  assert.ok(
    markup.includes('also names security-guidance@claude-plugins-official'),
    'and that the settings key is written for `claude plugin install`',
  )
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

run('an installed plugin lists each of its skills with its own Use in agent', () => {
  const withSkills = plugin('code-review', {
    components: {
      ...emptyPluginComponents(),
      skills: [
        { id: 'plugins/code-review/skills/review', name: 'review', description: 'Review a diff', group: '', files: [], allowedTools: [], hasExecutables: false },
        { id: 'plugins/code-review/skills/triage', name: 'triage', description: '', group: '', files: [], allowedTools: [], hasExecutables: false },
      ],
    },
  })
  const record = {
    workspaceRoot: '/ws',
    sourceId: SOURCE.id,
    pluginId: 'code-review',
    pluginName: 'code-review',
    marketplaceName: 'claude-plugins-official',
    claudePluginKey: 'code-review@claude-plugins-official',
    skillDirNames: ['review', 'triage'],
    mcpServerIds: [],
    commitSha: '1111111',
    installedAt: '',
  }

  const installed = pane({
    plugin: withSkills,
    workspaceRoot: '/ws',
    install: { kind: 'installed', record },
    availability: { enabled: true, reason: null },
  })
  assert.ok(installed.includes('>Use a skill<'), 'the section exists once the plugin is in the workspace')
  assert.ok(installed.includes('>review<') && installed.includes('>triage<'), 'each skill by name')
  assert.equal(
    (installed.match(/<button[^>]*aria-haspopup="menu"[^>]*>Use in agent<\/button>/g) ?? []).length,
    2,
    'two skills, two menu buttons — the page does not guess which was meant',
  )
  assert.ok(installed.includes('Review a diff'), 'the description the agent matches on rides along')

  // Not installed: nothing to use yet, and no "use" that would quietly install
  // past the hook acknowledgement above it.
  const notInstalled = pane({ plugin: withSkills, workspaceRoot: '/ws', availability: { enabled: true, reason: null } })
  assert.equal(notInstalled.includes('>Use a skill<'), false)
  assert.equal(notInstalled.includes('>Use in agent<'), false)
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

console.log('plugin detail pane: ok')
