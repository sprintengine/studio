import assert from 'node:assert/strict'

import { buildHarnessMap, skillsDirFromTemplate } from './harness-map'
import type { PluginRegistryListEntry, PluginSkillCatalog } from './plugin-manifest'

function entry(id: string, skillIntegration?: PluginSkillCatalog): PluginRegistryListEntry {
  return {
    id,
    displayName: id,
    source: 'bundled',
    version: 1,
    binary: id,
    resumeSession: false,
    sessionIdFromCaller: false,
    ...(skillIntegration ? { skillIntegration } : {}),
  }
}

function nativeOn(harnessId: string, dir: string, restartRequired = true): PluginSkillCatalog {
  return {
    support: 'native',
    harnessId,
    installTargets: [
      {
        scope: 'workspace',
        path: `{{workspaceRoot}}/${dir}/skills/{{skillId}}`,
        format: 'claude-code',
        restartRequired,
      },
    ],
    invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
  }
}

// 1. The template is the declaration: the directory is parsed out of it, and
//    anything that cannot be read literally is refused rather than guessed.
{
  assert.equal(skillsDirFromTemplate('{{workspaceRoot}}/.claude/skills/{{skillId}}'), '.claude/skills')
  assert.equal(skillsDirFromTemplate('{{ workspaceRoot }}/.codex/skills/{{ skillId }}'), '.codex/skills')
  assert.equal(skillsDirFromTemplate('{{workspaceRoot}}/.opencode/skill/{{skillId}}'), '.opencode/skill')

  assert.equal(skillsDirFromTemplate('{{home}}/.codex/skills/{{skillId}}'), null, 'user-scope template')
  assert.equal(skillsDirFromTemplate('{{workspaceRoot}}/.claude/skills'), null, 'no skill id')
  assert.equal(skillsDirFromTemplate('/etc/skills/{{skillId}}'), null, 'absolute')
  assert.equal(skillsDirFromTemplate('{{workspaceRoot}}/../../etc/{{skillId}}'), null, 'escapes the root')
  assert.equal(skillsDirFromTemplate('{{workspaceRoot}}/{{harness}}/skills/{{skillId}}'), null, 'unresolved')
}

// 2. Three CLIs on one harness collapse to one binding, and every one of them is
//    attributed to it — the reason a shared skill is read once, not three times.
{
  const map = buildHarnessMap([
    entry('claude-code', nativeOn('claude', '.claude')),
    entry('kimi-claude', nativeOn('claude', '.claude')),
    entry('zai', nativeOn('claude', '.claude')),
    entry('codex', nativeOn('codex', '.codex')),
  ])

  assert.equal(map.byHarness.size, 2)
  const claude = map.byHarness.get('claude')
  assert.ok(claude)
  assert.deepEqual(claude.pluginIds, ['claude-code', 'kimi-claude', 'zai'])
  assert.equal(claude.skillsDir, '.claude/skills')
  assert.equal(claude.skillFormat, 'claude-code')
  assert.equal(claude.restartRequired, true)

  for (const id of ['claude-code', 'kimi-claude', 'zai']) {
    assert.equal(map.byPlugin.get(id)?.harnessId, 'claude', `${id} binds to the claude harness`)
    assert.equal(map.byPlugin.get(id)?.skillsDir, '.claude/skills')
  }
  assert.equal(map.byPlugin.get('codex')?.skillsDir, '.codex/skills')
}

// 3. An invented CLI resolves with no production change — the acceptance test
//    for "the manifest is the only map".
{
  const map = buildHarnessMap([
    entry('claude-code', nativeOn('claude', '.claude')),
    entry('pi', {
      support: 'native',
      harnessId: 'pi',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.pi/agent-skills/{{skillId}}',
          format: 'generic',
          restartRequired: false,
        },
      ],
      invocation: { explicitTemplate: 'run {{skillId}}' },
    }),
  ])

  const pi = map.byPlugin.get('pi')
  assert.ok(pi)
  assert.equal(pi.harnessId, 'pi')
  assert.equal(pi.skillsDir, '.pi/agent-skills')
  assert.equal(pi.skillFormat, 'generic')
  assert.equal(pi.restartRequired, false)
  assert.deepEqual(pi.pluginIds, ['pi'])
}

// 4. Declared-unsupported and no-declaration are different answers, and neither
//    is an error: `generic-shell` is bound with support 'unsupported', a plugin
//    with no skillIntegration is simply absent from the map.
{
  const map = buildHarnessMap([
    entry('generic-shell', { support: 'unsupported', harnessId: 'generic-shell', installTargets: [] }),
    entry('cursor'),
  ])

  const shell = map.byPlugin.get('generic-shell')
  assert.ok(shell)
  assert.equal(shell.support, 'unsupported')
  assert.equal(shell.skillsDir, null)
  assert.equal(map.byPlugin.has('cursor'), false)
}

// 5. A plugin's own support is what it reports, even when it shares a harness
//    with a CLI that declares more.
{
  const map = buildHarnessMap([
    entry('claude-code', nativeOn('claude', '.claude')),
    entry('shim', { support: 'prompt-shim', harnessId: 'claude', installTargets: [] }),
  ])
  assert.equal(map.byPlugin.get('claude-code')?.support, 'native')
  assert.equal(map.byPlugin.get('shim')?.support, 'prompt-shim')
  assert.equal(map.byHarness.get('claude')?.support, 'native', 'the harness is natively readable')
  assert.equal(map.byPlugin.get('shim')?.skillsDir, '.claude/skills', 'still the shared directory')
}

// 6. The same list resolves to the same map; a new list rebuilds it, so a
//    reloaded registry is never served a stale answer.
{
  const plugins = [entry('claude-code', nativeOn('claude', '.claude'))]
  assert.equal(buildHarnessMap(plugins), buildHarnessMap(plugins))
  assert.notEqual(buildHarnessMap(plugins), buildHarnessMap([...plugins]))
}

console.log('harness-map tests passed')
