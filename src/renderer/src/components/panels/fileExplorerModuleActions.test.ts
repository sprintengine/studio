import assert from 'node:assert/strict'

import {
  groupFileExplorerModuleActions,
  visibleFileExplorerModuleActions,
  type FileExplorerModuleActionEntry,
} from './fileExplorerModuleActions'
import type { FileActionContext, RegisteredFileAction } from '../../modules/renderer-host'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  return { id, moduleId, moduleLabel: moduleId === 'atlas' ? 'Atlas' : 'Weather Deck', label, order, disabled: false }
}

run('a single module stays one group headed by its display name, ordered then labelled', () => {
  const grouped = groupFileExplorerModuleActions([
    entry('atlas.chart-from-notes', 'atlas', 'Chart from notes…', 30),
    entry('atlas.chart-from-plan', 'atlas', 'Chart from plan…', 10),
    entry('atlas.chart-from-outline', 'atlas', 'Chart from outline…', 20),
  ])
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0]?.heading, 'Atlas')
  assert.deepEqual(
    grouped[0]?.actions.map((action) => action.label),
    ['Chart from plan…', 'Chart from outline…', 'Chart from notes…'],
  )
})

run('two modules become two groups sorted by module id', () => {
  const grouped = groupFileExplorerModuleActions([
    entry('weather-deck.open-notes', 'weather-deck', 'Open forecast notes…', 10),
    entry('atlas.chart-from-plan', 'atlas', 'Chart from plan…', 10),
  ])
  assert.deepEqual(grouped.map((group) => group.moduleId), ['atlas', 'weather-deck'])
  assert.equal(grouped[0]?.heading, 'Atlas')
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
      id: 'atlas.chart-from-plan',
      moduleId: 'atlas',
      label: 'Chart from plan…',
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
      id: 'atlas.chart-from-source',
      moduleId: 'atlas',
      label: 'Chart from source…',
      isVisible: () => false,
      run() {},
    },
  ]
  const visible = visibleFileExplorerModuleActions({
    actions,
    moduleEnabled: (moduleId) => moduleId === 'atlas',
    moduleLabel: (moduleId) => (moduleId === 'atlas' ? 'Atlas' : moduleId),
    context,
  })
  assert.deepEqual(visible.map((action) => action.id), ['atlas.chart-from-plan'])
  assert.equal(visible[0]?.moduleLabel, 'Atlas')
  assert.equal(visible[0]?.disabled, false)
})

// Source contract: the explorer renders those groups rather than hard-coding a
// module's items into its own menu.
run('the explorer renders registered file actions under a module group', () => {
  const explorerSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/panels/FileExplorer.tsx'),
    'utf8',
  )
  assert.match(
    explorerSource,
    /groupFileExplorerModuleActions\(contextMenu\.fileActions\)/,
    'the explorer groups whatever the registry gave it',
  )
})

if (failures > 0) process.exit(1)
