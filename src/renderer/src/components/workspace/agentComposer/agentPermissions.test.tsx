import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'
import { agentPermissionChipLabel, agentPermissionOptions, PermissionPresetMenuRows } from './agentSpawnShared'

test('Codex and Claude use their own permission vocabulary without changing stored ids', () => {
  for (const cli of ['codex', 'claude-code', 'claude-agent']) {
    const options = agentPermissionOptions(cli)
    assert.deepEqual(
      options.map((option) => option.value),
      ['bypass', 'auto', 'manual', 'none'],
      'four presets, bypass (the default) first and No flag last',
    )
    const label = cli === 'codex' ? 'YOLO' : 'Bypass permissions'
    assert.equal(options.find((option) => option.value === 'bypass')?.label, label)
    assert.equal(agentPermissionChipLabel('bypass', cli), cli === 'codex' ? 'YOLO' : 'Bypass')
    const markup = renderToStaticMarkup(
      createElement(PermissionPresetMenuRows, { cli, value: 'bypass', onSelect: () => {} }),
    )
    assert.ok(markup.includes(`>${label}<`))
    assert.equal((markup.match(/aria-checked="true"/g) ?? []).length, 1)
    assert.ok(!markup.includes(cli === 'codex' ? 'Claude' : 'Codex'))
  }
})

test('Codex help names YOLO and its sandbox for what they are, and the no-flag row inherits configuration', () => {
  const byValue = (cli: string) => new Map(agentPermissionOptions(cli).map((option) => [option.value, option]))
  const codex = byValue('codex')
  assert.match(codex.get('bypass')!.title, /without approval prompts or sandbox restrictions/)
  assert.match(codex.get('auto')!.title, /inside the workspace sandbox without asking/)
  assert.match(codex.get('none')!.title, /configured permissions/)
  const claude = byValue('claude-code')
  assert.equal(claude.get('none')!.label, 'No flag')
  assert.match(claude.get('auto')!.title, /edit files in the workspace without asking/)
  assert.match(claude.get('manual')!.title, /Ask before every action that changes something/)
  assert.match(byValue('cursor').get('auto')!.summary, /Cursor runs what it judges safe/)
  assert.equal(agentPermissionChipLabel('none', 'codex'), 'No flag')
  assert.equal(agentPermissionChipLabel('auto', 'codex'), 'Auto')
  assert.equal(agentPermissionChipLabel('manual', 'claude-code'), 'Manual')
})

test('a preset the provider cannot run stays listed, dimmed, with its reason', () => {
  const markup = renderToStaticMarkup(
    createElement(PermissionPresetMenuRows, {
      cli: 'codex',
      value: 'none',
      onSelect: () => {},
      disabledReasons: { bypass: 'This provider does not support this permission preset.' },
    }),
  )
  assert.ok(markup.includes('>YOLO<'))
  assert.equal((markup.match(/role="menuitemradio"/g) ?? []).length, 4)
  assert.equal((markup.match(/ disabled=""/g) ?? []).length, 1)
  assert.equal((markup.match(/does not support this permission preset/g) ?? []).length, 1)
})
