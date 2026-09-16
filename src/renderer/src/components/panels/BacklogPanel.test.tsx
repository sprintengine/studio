import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  groupBacklogModuleActions,
  overflowItemsForBacklogModuleActions,
  type BacklogModuleActionEntry,
} from '../backlog/backlogModuleActions'
import type { BacklogItemActionCategory } from '../../modules/renderer-host'

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

const panelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/BacklogPanel.tsx'),
  'utf8',
)
const handToAgentSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/backlog/BacklogHandToAgentButton.tsx'),
  'utf8',
)
const contextMenuSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/backlog/BacklogItemContextMenu.tsx'),
  'utf8',
)
const agentRuntimeSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/agent-runtime-module.ts'),
  'utf8',
)

function moduleAction(
  id: string,
  label: string,
  order: number,
  category: BacklogItemActionCategory = 'execute',
): BacklogModuleActionEntry {
  return { id, label, category, order, disabled: false, run: () => {} }
}

// Four marketplace-style execute actions on one item. Order ties break on label
// so the sequence is stable without the shell picking a primary.
const fourExecuteActions = [
  moduleAction('weather-deck.forecast', 'Forecast weather', 30),
  moduleAction('docs.publish', 'Publish notes', 10),
  moduleAction('qa.replay', 'Replay session', 10),
  moduleAction('atlas.chart-item', 'Chart this item', 20),
]

function menuLabels(actions: ReadonlyArray<BacklogModuleActionEntry>): string[] {
  return overflowItemsForBacklogModuleActions(actions).flatMap((item) =>
    item.kind === 'separator' || item.kind === 'heading' || item.kind === 'swatch' || item.kind === 'flyout'
      ? []
      : [item.label],
  )
}

run('the detail header shows Hand to agent as its own primary and no module action as a button — modules cannot compete for the header', () => {
  assert.match(handToAgentSource, /<PrimaryButton/, 'Hand to agent is the header primary')
  assert.match(handToAgentSource, /Hand to agent/, 'the primary control keeps its label')
  assert.match(panelSource, /<BacklogHandToAgentButton /, 'the detail pane mounts the shell handoff button')
  assert.match(panelSource, /<BacklogOpenAgentButton/, 'Open agent is a shell control beside it')
  assert.equal(
    panelSource.includes('const Button = index === 0 ? PrimaryButton : GhostButton'),
    false,
    'registered module actions no longer become header buttons',
  )
  assert.match(
    panelSource,
    /overflowItemsForBacklogModuleActions\(/,
    'module actions go into the More-actions menu instead',
  )
  // Four execute registrants still cannot earn a header button: the strip only
  // mounts the two shell controls.
  const actionBand = panelSource.slice(
    panelSource.indexOf('{canHandToAgent || showOpenAgent ? ('),
    panelSource.indexOf('{/* Only the identity header stays pinned.'),
  )
  assert.match(actionBand, /BacklogHandToAgentButton/)
  assert.match(actionBand, /BacklogOpenAgentButton/)
  assert.equal(actionBand.includes('externalActions.map'), false)
  assert.equal(actionBand.includes('action.label'), false)
})

run('with four execute module actions the More menu and the row menu list them in order then label', () => {
  const grouped = groupBacklogModuleActions(fourExecuteActions)
  assert.equal(grouped.length, 1, 'a single category stays a flat list')
  assert.equal(grouped[0]?.heading, null)
  assert.deepEqual(
    grouped[0]?.actions.map((action) => action.label),
    ['Publish notes', 'Replay session', 'Chart this item', 'Forecast weather'],
  )
  assert.deepEqual(
    menuLabels(fourExecuteActions),
    ['Publish notes', 'Replay session', 'Chart this item', 'Forecast weather'],
  )
  assert.match(panelSource, /overflowItemsForBacklogModuleActions\(/, 'the More menu consumes that sequence')
  assert.match(contextMenuSource, /groupBacklogModuleActions\(itemActions\)/, 'the row menu consumes the same grouping')
  // Every row in the menu comes from the registry: the panel names no module's
  // action id of its own.
  assert.equal(
    /id: '[a-z-]+\.(start|open)-[a-z-]+'/.test(panelSource),
    false,
    'the shell special-cases no module action in the panel',
  )
})

run('a module action offers itself in both menus and nowhere else as a button', () => {
  const chartItem = moduleAction('atlas.chart-item', 'Chart this item', 10)
  const overflow = overflowItemsForBacklogModuleActions([chartItem])
  const item = overflow.find((entry) => entry.kind !== 'separator' && 'label' in entry && entry.label === 'Chart this item')
  assert.ok(item, 'the action is a More-menu item')
  assert.notEqual(item?.kind, 'heading')
  assert.match(contextMenuSource, /<BacklogModuleActionMenuItems/, 'the row menu lists the same module actions')
  assert.equal(
    /<(PrimaryButton|GhostButton)[^>]*>\s*Chart this item/.test(panelSource),
    false,
    'the detail pane draws no module action as a header button',
  )
  assert.equal(
    handToAgentSource.includes('Chart this item'),
    false,
    'and neither do the shell header controls',
  )
})

run('Open agent is a shell header control and no longer a registered module action', () => {
  assert.match(handToAgentSource, />Open agent</, 'the detail pane owns the Open agent button')
  assert.equal(
    agentRuntimeSource.includes('registerBacklogItemAction'),
    false,
    'agent-runtime no longer registers a Backlog item action',
  )
  assert.equal(agentRuntimeSource.includes('agent-runtime.open-agent'), false)
})

run('mixed categories become group headings; a single category stays flat', () => {
  const mixed = [
    moduleAction('a.execute', 'Run checks', 10, 'execute'),
    moduleAction('b.review', 'Review diff', 5, 'review'),
    moduleAction('c.analyze', 'Scan logs', 20, 'analyze'),
  ]
  const grouped = groupBacklogModuleActions(mixed)
  assert.deepEqual(
    grouped.map((group) => [group.heading, group.actions.map((action) => action.label)]),
    [
      ['Execute', ['Run checks']],
      ['Analyze', ['Scan logs']],
      ['Review', ['Review diff']],
    ],
  )
  const overflow = overflowItemsForBacklogModuleActions(mixed)
  assert.equal(overflow[0]?.kind, 'heading')
  assert.equal(overflow[0] && 'label' in overflow[0] ? overflow[0].label : null, 'Execute')
})

if (failures > 0) {
  console.error(`BacklogPanel.test.tsx: ${failures} failed`)
  process.exit(1)
}

console.log('BacklogPanel.test.tsx: ok')
