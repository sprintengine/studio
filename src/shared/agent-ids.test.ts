import assert from 'node:assert/strict'
import { test } from 'vitest'

import { instantiateTemplateAgentIds, newAgentId, newAgentIdSuffix } from './agent-ids'
import { EMPTY_CHAT_TEMPLATE, LAYOUT_TEMPLATES } from './layouts/templates'

/** Every agent id a layout's nodes name, in layout order. */
function layoutAgentIds(layout: unknown): string[] {
  return [...JSON.stringify(layout).matchAll(/"agentId":"([^"]+)"/g)].map((match) => match[1]!)
}

test('a minted agent id is lower-case, long, and keeps the agent- prefix', () => {
  assert.match(newAgentIdSuffix(), /^[0-9a-z]{16}$/)
  assert.match(newAgentId(), /^agent-[0-9a-z]{16}$/)
  assert.match(newAgentId('claude-code'), /^agent-claude-code-[0-9a-z]{16}$/)
  assert.match(newAgentId('  '), /^agent-[0-9a-z]{16}$/)
  const minted = new Set(Array.from({ length: 2000 }, () => newAgentId()))
  assert.equal(minted.size, 2000)
})

test('every template agent takes a fresh id, everywhere the layout names it, and the template is untouched', () => {
  for (const template of [...LAYOUT_TEMPLATES, EMPTY_CHAT_TEMPLATE]) {
    const before = structuredClone(template.layout)
    const placeholders = layoutAgentIds(template.layout)
    const first = instantiateTemplateAgentIds(template.layout)
    const second = instantiateTemplateAgentIds(template.layout)

    assert.deepEqual(template.layout, before, `${template.id}: the shared template is not rewritten`)
    assert.deepEqual(Object.keys(first.agentIds), placeholders, `${template.id}: one id per template agent`)
    assert.deepEqual(layoutAgentIds(first.layout), Object.values(first.agentIds), `${template.id}: tabs follow`)
    const minted = [...layoutAgentIds(first.layout), ...layoutAgentIds(second.layout)]
    assert.equal(new Set(minted).size, placeholders.length * 2, `${template.id}: no id recurs across workspaces`)
    for (const id of minted) assert.equal(placeholders.includes(id), false)
  }
})

test('an agent named in a border, twice, or by another component all follow the one new id', () => {
  const layout = {
    global: {},
    borders: [
      {
        type: 'border',
        location: 'bottom',
        children: [{ type: 'tab', component: 'agent', config: { agentId: 'agent-2' } }],
      },
    ],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          children: [
            { type: 'tab', component: 'agent', config: { agentId: 'agent-1', extra: true } },
            { type: 'tab', component: 'agent', config: { agentId: 'agent-1' } },
            { type: 'tab', component: 'module.panel', config: { agentId: 'agent-2' } },
            // Names no template agent: left as it is.
            { type: 'tab', component: 'module.panel', config: { agentId: 'someone-else' } },
          ],
        },
      ],
    },
  }
  let next = 0
  const { layout: instantiated, agentIds } = instantiateTemplateAgentIds(layout as never, {
    assign: { 'agent-2': 'agent-assigned' },
    mint: () => `agent-new-${++next}`,
  })
  assert.deepEqual(agentIds, { 'agent-1': 'agent-new-1', 'agent-2': 'agent-assigned' })
  // JSON order: the borders come before the main layout.
  assert.deepEqual(layoutAgentIds(instantiated), [
    'agent-assigned',
    'agent-new-1',
    'agent-new-1',
    'agent-assigned',
    'someone-else',
  ])
  assert.match(JSON.stringify(instantiated), /"extra":true/)
})
