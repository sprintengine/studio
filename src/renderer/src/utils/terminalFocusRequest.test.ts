import assert from 'node:assert/strict'
import type { IJsonModel } from 'flexlayout-react'
import { visibleTerminalTabInLayout } from './modelRegistry'
import { focusRequestWouldInterrupt, terminalFocusRequestMatches } from './terminalFocusRequest'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function agentTab(agentId: string) {
  return { type: 'tab', component: 'agent', config: { agentId } }
}

function terminalTab(terminalId: string) {
  return { type: 'tab', component: 'terminal', config: { terminalId } }
}

// Only the shape the walker reads; the real IJsonModel carries far more.
function layout(root: unknown): IJsonModel {
  return { layout: root } as unknown as IJsonModel
}

run('visibleTerminalTabInLayout reports the selected agent tab, not a buried sibling', () => {
  const model = layout({
    type: 'row',
    children: [
      {
        type: 'tabset',
        selected: 1,
        active: true,
        children: [agentTab('agent-1'), agentTab('agent-2'), agentTab('agent-3')],
      },
    ],
  })
  assert.deepEqual(visibleTerminalTabInLayout(model), { kind: 'agent', agentId: 'agent-2' })
})

run('visibleTerminalTabInLayout defaults to the first tab when a tabset has no selection', () => {
  const model = layout({
    type: 'row',
    children: [{ type: 'tabset', children: [agentTab('agent-1'), agentTab('agent-2')] }],
  })
  assert.deepEqual(visibleTerminalTabInLayout(model), { kind: 'agent', agentId: 'agent-1' })
})

run('visibleTerminalTabInLayout prefers the active tabset over document order', () => {
  const model = layout({
    type: 'row',
    children: [
      { type: 'tabset', selected: 0, children: [agentTab('agent-1')] },
      { type: 'tabset', selected: 0, active: true, children: [terminalTab('term-9')] },
    ],
  })
  assert.deepEqual(visibleTerminalTabInLayout(model), { kind: 'terminal', terminalId: 'term-9' })
})

run('visibleTerminalTabInLayout falls back to document order when no tabset is active', () => {
  // A freshly-opened workspace the user has not driven yet: flexlayout has
  // marked no tabset active, and the first visible terminal is still the answer.
  const model = layout({
    type: 'row',
    children: [
      { type: 'tabset', selected: 0, children: [{ type: 'tab', component: 'explorer' }] },
      { type: 'tabset', selected: 0, children: [agentTab('agent-1')] },
    ],
  })
  assert.deepEqual(visibleTerminalTabInLayout(model), { kind: 'agent', agentId: 'agent-1' })
})

run('visibleTerminalTabInLayout answers null when the visible tabs carry no terminal', () => {
  const model = layout({
    type: 'row',
    children: [
      {
        type: 'tabset',
        selected: 0,
        active: true,
        // The agent tab exists but is stacked behind the editor: focusing it
        // would be focusing something the user cannot see.
        children: [{ type: 'tab', component: 'editor' }, agentTab('agent-1')],
      },
    ],
  })
  assert.equal(visibleTerminalTabInLayout(model), null)
})

run('visibleTerminalTabInLayout answers null for an empty layout', () => {
  assert.equal(visibleTerminalTabInLayout(null), null)
  assert.equal(visibleTerminalTabInLayout(layout({ type: 'row', children: [] })), null)
})

run('terminalFocusRequestMatches pairs a request with the pane it names', () => {
  assert.equal(
    terminalFocusRequestMatches({ workspaceId: 'w1', agentId: 'a1' }, { workspaceId: 'w1', agentId: 'a1' }),
    true,
  )
  assert.equal(
    terminalFocusRequestMatches({ workspaceId: 'w1', terminalId: 't1' }, { workspaceId: 'w1', terminalId: 't1' }),
    true,
  )
})

run('terminalFocusRequestMatches refuses another workspace, another id, and the wrong id kind', () => {
  assert.equal(
    terminalFocusRequestMatches({ workspaceId: 'w1', agentId: 'a1' }, { workspaceId: 'w2', agentId: 'a1' }),
    false,
  )
  assert.equal(
    terminalFocusRequestMatches({ workspaceId: 'w1', agentId: 'a1' }, { workspaceId: 'w1', agentId: 'a2' }),
    false,
  )
  // Same string in two different id spaces must not cross-match.
  assert.equal(
    terminalFocusRequestMatches({ workspaceId: 'w1', agentId: 'x' }, { workspaceId: 'w1', terminalId: 'x' }),
    false,
  )
  assert.equal(
    terminalFocusRequestMatches({ workspaceId: 'w1', terminalId: 'x' }, { workspaceId: 'w1', agentId: 'x' }),
    false,
  )
})

run('terminalFocusRequestMatches refuses a request naming no target at all', () => {
  assert.equal(terminalFocusRequestMatches({ workspaceId: 'w1' }, { workspaceId: 'w1', agentId: 'a1' }), false)
})

// focusRequestWouldInterrupt reads DOM nodes, so stand in the smallest shape it
// touches: `closest`, `tagName`, and the contenteditable flag.
function element(tagName: string, options: { insideTerminal?: boolean; contentEditable?: boolean } = {}) {
  const node = {
    tagName,
    isContentEditable: options.contentEditable ?? false,
    closest: (selector: string) => (selector === '.xterm' && options.insideTerminal ? node : null),
  }
  return node as unknown as Element
}

run('focusRequestWouldInterrupt leaves a typing user alone', () => {
  assert.equal(focusRequestWouldInterrupt(element('INPUT')), true)
  assert.equal(focusRequestWouldInterrupt(element('TEXTAREA')), true)
  assert.equal(focusRequestWouldInterrupt(element('SELECT')), true)
  assert.equal(focusRequestWouldInterrupt(element('DIV', { contentEditable: true })), true)
})

run('focusRequestWouldInterrupt allows the ordinary open-a-workspace cases', () => {
  assert.equal(focusRequestWouldInterrupt(null), false)
  assert.equal(focusRequestWouldInterrupt(element('BODY')), false)
  // The sidebar row that opened the workspace.
  assert.equal(focusRequestWouldInterrupt(element('BUTTON')), false)
})

run("focusRequestWouldInterrupt does not treat an xterm's own textarea as typing", () => {
  // This is the case being corrected: a hidden pane's mount-time focus took the
  // keyboard, and the request redirects it to the visible terminal.
  assert.equal(focusRequestWouldInterrupt(element('TEXTAREA', { insideTerminal: true })), false)
})

console.log('terminal focus request tests passed')
