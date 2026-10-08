import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'
import { bundledPermissionModes } from '../../../../../../tests/permission-modes'
import {
  agentPermissionChipLabel,
  agentPermissionOptions,
  PermissionPresetMenuRows,
  selectedPermissionOption,
} from './agentSpawnShared'

const optionsFor = (cli: string) => agentPermissionOptions(bundledPermissionModes(cli))
const labels = (cli: string) => optionsFor(cli).map((option) => option.label)

test('each CLI lists its own modes under its own names, strictest first', () => {
  assert.deepEqual(labels('claude-code'), [
    'Manual',
    'Accept edits',
    'Auto',
    'Don’t ask',
    'Bypass permissions',
    'No flag',
  ])
  assert.deepEqual(labels('codex'), ['Read only', 'Default', 'Auto-review', 'YOLO', 'No flag'])
  assert.deepEqual(labels('cursor'), ['Default', 'Auto-review', 'Run Everything'])
  assert.deepEqual(labels('grok'), ['Default', 'Accept edits', 'Auto', 'Don’t ask', 'Always approve', 'No flag'])
  assert.deepEqual(labels('opencode'), ['Ask', 'Allow edits', 'Auto-approve', 'Your rules'])
  assert.deepEqual(labels('kimi-code'), ['Auto', 'No flag'])
})

test('a mode stores its preset, and the CLI’s own id only where it is not the preset’s own', () => {
  const claude = new Map(optionsFor('claude-code').map((option) => [option.label, option]))
  assert.deepEqual(
    [claude.get('Accept edits')!.value, claude.get('Accept edits')!.mode],
    ['auto', 'acceptEdits'],
    'Accept edits sits at Auto, the level the app reasons with',
  )
  assert.deepEqual([claude.get('Don’t ask')!.value, claude.get('Don’t ask')!.mode], ['manual', 'dontAsk'])
  assert.deepEqual([claude.get('Auto')!.value, claude.get('Auto')!.mode], ['auto', undefined])
  const codex = new Map(optionsFor('codex').map((option) => [option.label, option]))
  assert.deepEqual([codex.get('Default')!.value, codex.get('Default')!.mode], ['auto', 'workspace'])
  assert.deepEqual([codex.get('Read only')!.value, codex.get('Read only')!.mode], ['manual', undefined])
})

test('a stored preset selects the CLI’s mode for it; a mode it lacks reads as the preset’s own', () => {
  const claude = optionsFor('claude-code')
  assert.equal(selectedPermissionOption(claude, 'auto')?.label, 'Auto')
  assert.equal(selectedPermissionOption(claude, 'auto', 'acceptEdits')?.label, 'Accept edits')
  assert.equal(selectedPermissionOption(claude, 'auto', 'workspace')?.label, 'Auto', 'Codex’s mode on Claude')
  assert.equal(selectedPermissionOption(claude, 'bypass', 'acceptEdits')?.label, 'Bypass permissions')
  assert.equal(selectedPermissionOption(optionsFor('cursor'), 'manual'), null, 'Cursor has no Manual')
  assert.equal(agentPermissionChipLabel(optionsFor('cursor'), 'manual'), 'Manual', 'the chip still names it')
  assert.equal(agentPermissionChipLabel(optionsFor('codex'), 'bypass'), 'YOLO')
  assert.equal(agentPermissionChipLabel(optionsFor('codex'), 'auto', 'workspace'), 'Default')
})

test('a CLI the catalog has not listed gets the four presets in the app’s words', () => {
  assert.deepEqual(
    agentPermissionOptions(undefined).map((option) => option.label),
    ['Manual', 'Auto', 'Bypass permissions', 'No flag'],
  )
  const options = agentPermissionOptions([])
  assert.match(options.find((option) => option.value === 'none')!.title, /configured permissions/)
})

test('each mode carries a one-line summary and a tooltip of its own', () => {
  for (const cli of ['claude-code', 'codex', 'cursor', 'grok', 'opencode', 'kimi-code']) {
    for (const option of optionsFor(cli)) {
      assert.ok(option.summary.trim(), `${cli} ${option.id}: summary`)
      assert.ok(option.title.trim(), `${cli} ${option.id}: tooltip`)
    }
  }
  const codex = new Map(optionsFor('codex').map((option) => [option.id, option]))
  assert.match(codex.get('bypass')!.title, /without approval prompts or sandbox restrictions/)
  assert.match(codex.get('auto')!.title, /Codex’s auto-review/)
  assert.match(new Map(optionsFor('grok').map((option) => [option.id, option])).get('auto')!.title, /Grok’s own auto/)
})

test('the rows mark the mode in force, and a mode the target cannot run stays listed, dimmed, with its reason', () => {
  const markup = renderToStaticMarkup(
    createElement(PermissionPresetMenuRows, {
      options: optionsFor('codex'),
      value: 'auto',
      mode: 'workspace',
      onSelect: () => {},
      disabledReasons: { bypass: 'This provider does not support this permission preset.' },
    }),
  )
  assert.ok(markup.includes('>YOLO<'))
  assert.equal((markup.match(/role="menuitemradio"/g) ?? []).length, 5)
  assert.equal((markup.match(/aria-checked="true"/g) ?? []).length, 1)
  assert.ok(/aria-checked="true"[^>]*>[\s\S]*?Default/.test(markup), 'Codex’s Default is the row in force')
  assert.equal((markup.match(/ disabled=""/g) ?? []).length, 1)
  assert.equal((markup.match(/does not support this permission preset/g) ?? []).length, 1)
})

test('every Claude Code mode leads with a glyph of its own', () => {
  const markup = renderToStaticMarkup(
    createElement(PermissionPresetMenuRows, {
      options: optionsFor('claude-code'),
      value: 'auto',
      onSelect: () => {},
    }),
  )
  // Each row's first drawing is its leading glyph; the trailing check is only on the row in force.
  const rows = markup.split('role="menuitemradio"').slice(1)
  const glyphs = rows.map((row) => row.match(/<svg[\s\S]*?<\/svg>/)?.[0])
  assert.equal(glyphs.length, 6)
  assert.equal(new Set(glyphs).size, 6, 'Manual, Accept edits, Auto, Don’t ask, Bypass and No flag are told apart')
})
