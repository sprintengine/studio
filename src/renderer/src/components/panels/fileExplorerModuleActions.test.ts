import assert from 'node:assert/strict'

import {
  groupFileExplorerModuleActions,
  visibleFileExplorerModuleActions,
  type FileExplorerModuleActionEntry,
} from './fileExplorerModuleActions'
import type { FileActionContext, RegisteredFileAction } from '../../modules/renderer-host'

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

function entry(
  id: string,
  moduleId: string,
  label: string,
  order: number,
): FileExplorerModuleActionEntry {
  return { id, moduleId, moduleLabel: moduleId === 'sprint-engine' ? 'Sprint Engine' : 'Weather Deck', label, order, disabled: false }
}

run('a single module stays one group headed by its display name, ordered then labelled', () => {
  const grouped = groupFileExplorerModuleActions([
    entry('sprint-engine.run-from-generic-handoff', 'sprint-engine', 'Generic handoff…', 30),
    entry('sprint-engine.run-from-product-plan', 'sprint-engine', 'Product plan…', 10),
    entry('sprint-engine.run-from-implementation-plan', 'sprint-engine', 'Implementation plan…', 20),
  ])
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0]?.heading, 'Sprint Engine')
  assert.deepEqual(
    grouped[0]?.actions.map((action) => action.label),
    ['Product plan…', 'Implementation plan…', 'Generic handoff…'],
  )
})

run('two modules become two groups sorted by module id', () => {
  const grouped = groupFileExplorerModuleActions([
    entry('weather-deck.open-notes', 'weather-deck', 'Open forecast notes…', 10),
    entry('sprint-engine.run-from-product-plan', 'sprint-engine', 'Product plan…', 10),
  ])
  assert.deepEqual(grouped.map((group) => group.moduleId), ['sprint-engine', 'weather-deck'])
  assert.equal(grouped[0]?.heading, 'Sprint Engine')
  assert.equal(grouped[1]?.heading, 'Weather Deck')
})

run('visibleFileExplorerModuleActions drops disabled modules and invisible rows', () => {
  const context: FileActionContext = {
    workspaceId: 'ws-1',
    workspaceRoot: '/Users/dev/app',
    entries: [{ name: 'plan.md', path: '/Users/dev/app/plan.md', isDir: false }],
  }
  const actions: RegisteredFileAction[] = [
    {
      id: 'sprint-engine.run-from-product-plan',
      moduleId: 'sprint-engine',
      label: 'Product plan…',
      isVisible: (next) => next.entries.some((item) => item.name.endsWith('.md')),
      run() {},
    },
    {
      id: 'weather-deck.open-notes',
      moduleId: 'weather-deck',
      label: 'Open forecast notes…',
      run() {},
    },
    {
      id: 'sprint-engine.run-from-source-bundle',
      moduleId: 'sprint-engine',
      label: 'Run a sprint from source…',
      isVisible: () => false,
      run() {},
    },
  ]
  const visible = visibleFileExplorerModuleActions({
    actions,
    moduleEnabled: (moduleId) => moduleId === 'sprint-engine',
    moduleLabel: (moduleId) => (moduleId === 'sprint-engine' ? 'Sprint Engine' : moduleId),
    context,
  })
  assert.deepEqual(visible.map((action) => action.id), ['sprint-engine.run-from-product-plan'])
  assert.equal(visible[0]?.moduleLabel, 'Sprint Engine')
  assert.equal(visible[0]?.disabled, false)
})

if (failures > 0) process.exit(1)
