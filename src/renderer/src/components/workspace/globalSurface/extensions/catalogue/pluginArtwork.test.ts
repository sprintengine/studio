// The artwork ladder: glyph → logo → the GitHub owner's avatar → monogram.
//
// The assertions are aimed at the rungs that are easy to get wrong rather than
// at the happy path: which owner a LINKED plugin borrows (its own repository's,
// not the marketplace's), that a skill takes its plugin's picture but never its
// letters, and that the ladder degrades to two letters rather than to nothing
// for a source with no GitHub account behind it.

import assert from 'node:assert/strict'

import type { ScannedPlugin, SkillSource } from '../../../../../../../shared/skills'
import { extensionIconProps, pluginArtwork, pluginsByFolder, skillArtwork, sourceArtwork } from './pluginArtwork'
import { test } from 'vitest'

test('pluginArtwork', async () => {
  const SIZE = 36

  function plugin(overrides: Partial<ScannedPlugin> = {}): ScannedPlugin {
    return {
      id: 'access',
      name: 'access',
      description: '',
      version: '',
      category: '',
      author: '',
      homepage: '',
      origin: { kind: 'in-tree', path: 'plugins/access' },
      strict: true,
      tags: [],
      keywords: [],
      componentsKnown: true,
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
        missingSkills: [],
      },
      ...overrides,
    }
  }

  function source(overrides: Partial<SkillSource> = {}): SkillSource {
    return {
      id: 'anthropics-plugins',
      kind: 'github',
      name: 'Anthropic',
      repo: 'anthropics/claude-plugins-official',
      monogram: 'AN',
      blurb: '',
      commitSha: '',
      scannedAt: '',
      ...overrides,
    }
  }

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  run('the glyph the plugin gives itself is the answer, and needs no network', () => {
    assert.deepEqual(pluginArtwork(plugin({ icon: '🦀' }), source(), SIZE), { kind: 'glyph', glyph: '🦀' })
    assert.deepEqual(
      pluginArtwork(plugin({ icon: '🦀', logo: 'https://cdn.example.com/a.png' }), source(), SIZE),
      { kind: 'glyph', glyph: '🦀' },
      'a plugin that says it is a crab has answered the question; the picture is a rung below',
    )
  })

  run('the logo when there is no glyph', () => {
    assert.deepEqual(pluginArtwork(plugin({ logo: 'https://cdn.example.com/a.png' }), source(), SIZE), {
      kind: 'image',
      url: 'https://cdn.example.com/a.png',
    })
  })

  run('an in-tree plugin borrows the source repository’s owner', () => {
    assert.deepEqual(pluginArtwork(plugin(), source(), SIZE), {
      kind: 'image',
      url: 'https://github.com/anthropics.png?size=72',
    })
  })

  run('a linked plugin borrows ITS OWN repository’s owner, not the marketplace’s', () => {
    const linked = plugin({
      origin: {
        kind: 'linked',
        repo: 'pbakaus/impeccable',
        ref: '',
        sha: '',
        path: '',
        url: 'https://github.com/pbakaus/impeccable',
      },
    })
    assert.deepEqual(
      pluginArtwork(linked, source(), SIZE),
      { kind: 'image', url: 'https://github.com/pbakaus.png?size=72' },
      'a marketplace lists other people’s plugins; the marketplace owner’s face beside one would be the wrong face',
    )
  })

  run('a linked entry with no repository falls back to the source, then to letters', () => {
    const hosted = plugin({
      origin: { kind: 'linked', repo: '', ref: '', sha: '', path: '', url: 'https://example.com/x.git' },
    })
    assert.deepEqual(pluginArtwork(hosted, source(), SIZE), {
      kind: 'image',
      url: 'https://github.com/anthropics.png?size=72',
    })
    assert.deepEqual(pluginArtwork(hosted, source({ kind: 'local', repo: '', path: '/tmp/x' }), SIZE), {
      kind: 'monogram',
      text: 'AC',
    })
    assert.deepEqual(pluginArtwork(hosted, undefined, SIZE), { kind: 'monogram', text: 'AC' })
  })

  run('the avatar is asked for at twice the slot, so it is sharp on a 2× display', () => {
    assert.deepEqual(pluginArtwork(plugin(), source(), 40), {
      kind: 'image',
      url: 'https://github.com/anthropics.png?size=80',
    })
  })

  run('a skill takes its plugin’s picture, but never its letters', () => {
    const inPlugin = plugin({ name: 'access', icon: '🦀' })
    assert.deepEqual(skillArtwork({ name: 'telegram' }, source(), SIZE, inPlugin), { kind: 'glyph', glyph: '🦀' })
    assert.deepEqual(
      skillArtwork({ name: 'telegram' }, source({ kind: 'local', repo: '', path: '/tmp/x' }), SIZE, plugin()),
      { kind: 'monogram', text: 'TE' },
      'the plugin’s monogram is the PLUGIN’s name; the skill keeps its own',
    )
    assert.deepEqual(skillArtwork({ name: 'telegram' }, source(), SIZE), {
      kind: 'image',
      url: 'https://github.com/anthropics.png?size=72',
    })
  })

  run('a row with no plugin behind it still gets the account’s face', () => {
    assert.deepEqual(sourceArtwork(source(), 'context7', SIZE), {
      kind: 'image',
      url: 'https://github.com/anthropics.png?size=72',
    })
    assert.deepEqual(sourceArtwork(undefined, 'context7', SIZE), { kind: 'monogram', text: 'CO' })
  })

  run('the icon slot’s props: a picture fills the slot, a monogram passes nothing', () => {
    assert.deepEqual(extensionIconProps({ kind: 'glyph', glyph: '🦀' }), { glyph: '🦀' })
    assert.deepEqual(extensionIconProps({ kind: 'image', url: 'https://x/a.png' }), {
      icon: 'https://x/a.png',
      iconPlated: true,
    })
    assert.deepEqual(
      extensionIconProps({ kind: 'monogram', text: 'AC' }),
      {},
      'the slot already has the name; two places to compute the letters is two places for them to disagree',
    )
    assert.deepEqual(extensionIconProps(undefined), {})
  })

  run('plugins are found by the folder a skill’s id names them with, and by their id', () => {
    const byFolder = pluginsByFolder([
      plugin({ id: 'cwc-makers', origin: { kind: 'in-tree', path: 'plugins/cwc-makers' } }),
      plugin({ id: 'discord-access', origin: { kind: 'in-tree', path: 'external_plugins/discord' } }),
      plugin({ id: 'hosted', origin: { kind: 'linked', repo: 'o/r', ref: '', sha: '', path: '', url: '' } }),
    ])
    assert.equal(byFolder.get('cwc-makers')?.id, 'cwc-makers')
    assert.equal(
      byFolder.get('discord')?.id,
      'discord-access',
      'the folder is not always the name the marketplace uses',
    )
    assert.equal(byFolder.get('discord-access')?.id, 'discord-access')
    assert.equal(byFolder.get('hosted')?.id, 'hosted')
    assert.equal(byFolder.get(''), undefined, 'a skill outside any plugin folder matches nothing')
  })

  run('a scan cached before either field existed is a plugin with no artwork, not a crash', () => {
    const cached = plugin()
    delete (cached as Partial<ScannedPlugin>).icon
    delete (cached as Partial<ScannedPlugin>).logo
    assert.deepEqual(pluginArtwork(cached, undefined, SIZE), { kind: 'monogram', text: 'AC' })
  })

  if (failures > 0) {
    console.error(`\npluginArtwork.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('pluginArtwork: all checks passed')
})
