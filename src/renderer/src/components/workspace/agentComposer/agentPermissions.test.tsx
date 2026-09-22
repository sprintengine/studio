import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'
import {
  agentPermissionChipLabel,
  agentPermissionOptions,
  PermissionPresetMenuRows,
  REMOTE_PRESET_DISABLED_REASONS,
} from './agentSpawnShared'
import { permissionPresetLabel } from '../../panels/agentChat/modelPicker'
import { PermissionField } from '../../panels/AutomationsPanel/AgentFields'

test('Codex and Claude use their own permission vocabulary without changing stored ids', () => {
  for (const cli of ['codex', 'claude-code', 'claude-agent']) {
    const options = agentPermissionOptions(cli)
    assert.deepEqual(
      options.map((option) => option.value),
      ['none', 'manual', 'auto', 'bypass'],
    )
    const label = cli === 'codex' ? 'YOLO' : 'Bypass permissions'
    assert.equal(options.find((option) => option.value === 'bypass')?.label, label)
    assert.equal(permissionPresetLabel('bypass', cli), label)
    assert.equal(agentPermissionChipLabel('bypass', cli), cli === 'codex' ? 'YOLO' : 'Bypass')
    const markup = renderToStaticMarkup(
      createElement(PermissionPresetMenuRows, { cli, value: 'bypass', onSelect: () => {} }),
    )
    assert.ok(markup.includes(`>${label}<`))
    assert.equal((markup.match(/aria-checked="true"/g) ?? []).length, 1)
    assert.ok(!markup.includes(cli === 'codex' ? 'Claude' : 'Codex'))
  }
})

test('Codex help distinguishes inheriting configuration, interactive approvals, sandboxed auto and YOLO', () => {
  const options = agentPermissionOptions('codex')
  assert.match(options[0].title, /configured permissions/)
  assert.match(options[1].title, /read-only sandbox/)
  assert.match(options[2].title, /blocked/)
  assert.match(options[3].title, /without approval prompts or sandbox restrictions/)
  assert.equal(agentPermissionOptions('claude-code')[2].summary, 'Claude reviews actions automatically.')
})

test('remote restrictions still disable YOLO and None with a reason', () => {
  const markup = renderToStaticMarkup(
    createElement(PermissionPresetMenuRows, {
      cli: 'codex',
      value: 'auto',
      onSelect: () => {},
      disabledReasons: REMOTE_PRESET_DISABLED_REASONS,
    }),
  )
  assert.ok(markup.includes('>YOLO<'))
  assert.equal((markup.match(/ disabled=""/g) ?? []).length, 2)
  assert.equal((markup.match(/Not available on a remote machine/g) ?? []).length, 2)
})

test('the automation editor names the selected agent’s permission policy', () => {
  const markup = renderToStaticMarkup(
    createElement(PermissionField, { cli: 'codex', show: true, value: 'bypass', onChange: () => {} }),
  )
  assert.ok(markup.includes('YOLO — No approvals or sandbox.'))
  assert.ok(!markup.includes('Bypass'))
})
