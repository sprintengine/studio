import assert from 'node:assert/strict'

import { Model, type IJsonModel } from 'flexlayout-react'
import {
  focusOrAddFileTab,
  registerModel,
  unregisterModel,
  togglePanelRailComponent,
  revealNavRailComponent,
} from './modelRegistry'

const WS = 'modelregistry-test-ws'

// Minimal layout: a single agent tabset (stands in for the right-hand
// terminals/agents column the nav pane must never displace).
function freshModel(): Model {
  const json: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [
            { type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'a-1' } },
          ],
        },
      ],
    },
  }
  return Model.fromJson(json)
}

type TabsetJson = { type?: string; component?: string; enableTabStrip?: boolean; children?: TabsetJson[] }
type TabJson = TabsetJson & { enableClose?: boolean; config?: { filePath?: string } }

function tabsets(model: Model): TabsetJson[] {
  const out: TabsetJson[] = []
  const walk = (node: TabsetJson | undefined) => {
    if (!node) return
    if (node.type === 'tabset') out.push(node)
    node.children?.forEach(walk)
  }
  walk((model.toJson() as unknown as { layout: TabsetJson }).layout)
  return out
}

function componentsOf(tabset: TabsetJson): string[] {
  return (tabset.children ?? []).map((child) => child.component ?? '')
}

function allComponents(model: Model): string[] {
  const out: string[] = []
  const walk = (node: TabsetJson | undefined) => {
    if (!node) return
    if (node.type === 'tab' && node.component) out.push(node.component)
    node.children?.forEach(walk)
  }
  walk((model.toJson() as unknown as { layout: TabsetJson }).layout)
  return out
}

function allTabs(model: Model): TabJson[] {
  const out: TabJson[] = []
  const walk = (node: TabJson | undefined) => {
    if (!node) return
    if (node.type === 'tab') out.push(node)
    node.children?.forEach(walk)
  }
  walk((model.toJson() as unknown as { layout: TabJson }).layout)
  return out
}

function navTabsets(model: Model): TabsetJson[] {
  const nav = new Set(['explorer', 'git', 'memory-graph'])
  return tabsets(model).filter((tabset) => componentsOf(tabset).some((c) => nav.has(c)))
}

// First nav toggle docks a strip-less LEFT pane holding only that switch.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'git', 'Git')
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['git'])
  assert.equal(nav[0].enableTabStrip, false)
  unregisterModel(WS)
}

// Selecting another nav switch swaps it in (single-select) and keeps the strip
// hidden — never two nav switches at once.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'git', 'Git')
  togglePanelRailComponent(WS, 'explorer', 'Files')
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['explorer'])
  assert.equal(nav[0].enableTabStrip, false)
  unregisterModel(WS)
}

// Clicking the open switch again closes the nav pane.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
  assert.equal(navTabsets(model).length, 1)
  togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
  assert.equal(navTabsets(model).length, 0)
  unregisterModel(WS)
}

// The Editor is not a strip-less nav switch: its tabset keeps a tab strip so
// open files stay switchable.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'editor', 'Editor')
  const editorTabset = tabsets(model).find((tabset) => componentsOf(tabset).includes('editor'))
  assert.ok(editorTabset)
  assert.equal(editorTabset.enableTabStrip, undefined)
  unregisterModel(WS)
}

// Reveal (command palette / menu) is non-toggling: opening the same switch
// twice leaves exactly one instance, never closing it.
{
  const model = freshModel()
  registerModel(WS, model)
  revealNavRailComponent(WS, 'git', 'Git')
  revealNavRailComponent(WS, 'git', 'Git')
  assert.equal(allComponents(model).filter((c) => c === 'git').length, 1)
  assert.equal(navTabsets(model).length, 1)
  // Revealing a different switch swaps it in (still single-select).
  revealNavRailComponent(WS, 'explorer', 'Files')
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['explorer'])
  unregisterModel(WS)
}

// With a file open, toggling the Editor switch focuses that surface instead of
// stacking a second 'editor' welcome tab.
{
  const json: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [
            { type: 'tab', name: 'app.tsx', component: 'file-editor', config: { filePath: '/app.tsx' } },
          ],
        },
      ],
    },
  }
  const model = Model.fromJson(json)
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'editor', 'Editor')
  assert.equal(allComponents(model).filter((c) => c === 'editor').length, 0)
  assert.equal(allComponents(model).filter((c) => c === 'file-editor').length, 1)
  unregisterModel(WS)
}

// Guided Brief layouts historically set global tabEnableClose=false to protect
// the root Guided Brief tab. File editor tabs must still be explicitly
// closeable so their close affordance and close-active-tab command work.
{
  const json: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          enableTabStrip: false,
          children: [
            { type: 'tab', name: 'Guided Brief', component: 'guided-brief', enableClose: false },
          ],
        },
      ],
    },
  }
  const model = Model.fromJson(json)
  registerModel(WS, model)
  assert.equal(focusOrAddFileTab(WS, '/tmp/brief.md', 'brief.md'), true)
  const fileTab = allTabs(model).find((tab) => tab.component === 'file-editor')
  assert.ok(fileTab)
  assert.equal(fileTab.enableClose, true)
  unregisterModel(WS)
}

console.log('modelRegistry.test.ts: ok')
