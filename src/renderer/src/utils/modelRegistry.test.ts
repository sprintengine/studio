import assert from 'node:assert/strict'

import { Actions, Model, Rect, type IJsonModel } from 'flexlayout-react'
import {
  addAgentTabTiled,
  addTerminalTab,
  captureRailWidthFraction,
  captureRailWidthFractions,
  consumePendingAgentFlash,
  flashAgentTab,
  focusedAgentTabInLayout,
  focusOrAddFileTab,
  registerModel,
  restoreRailWidthFraction,
  restoreRailWidthFractions,
  revealAgentTab,
  unregisterModel,
  togglePanelRailComponent,
  revealNavRailComponent,
  NAV_RAIL_COMPONENTS,
  RIGHT_RAIL_COMPONENTS,
} from './modelRegistry'

const WS = 'modelregistry-test-ws'

// addAgentTabTiled schedules its spawn-flash cleanup via window.setTimeout; node
// has no window, so provide a no-op shim.
const globalWithWindow = globalThis as unknown as { window?: { setTimeout: () => number } }
if (!globalWithWindow.window) globalWithWindow.window = { setTimeout: () => 0 }

// A workspace whose only open panel is the strip-less sidebar nav pane (Backlog
// here) — the regression case where a terminal/agent used to spawn buried under
// the sidebar.
function navOnlyModel(): Model {
  const json: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          enableTabStrip: false,
          children: [{ type: 'tab', name: 'Backlog', component: 'backlog' }],
        },
      ],
    },
  }
  return Model.fromJson(json)
}

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

type TabsetJson = { type?: string; component?: string; enableTabStrip?: boolean; minWidth?: number; children?: TabsetJson[] }
type TabJson = TabsetJson & { name?: string; enableClose?: boolean; className?: string; contentClassName?: string; config?: { agentId?: string; filePath?: string } }

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

function tabNames(model: Model): string[] {
  return allTabs(model).map((tab) => tab.name ?? '')
}

function navTabsets(model: Model): TabsetJson[] {
  const nav = new Set(['explorer', 'git', 'backlog', 'memory-graph'])
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

// Backlog is a strip-less nav switch: first toggle docks the shared LEFT pane
// with the strip hidden, exactly like Files / Git / Knowledge Graph.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'backlog', 'Backlog')
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['backlog'])
  assert.equal(nav[0].enableTabStrip, false)
  unregisterModel(WS)
}

// Backlog is exclusive with the other nav switches: opening Backlog over Git
// swaps it in (single-select), and clicking Backlog again closes the pane.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'git', 'Git')
  togglePanelRailComponent(WS, 'backlog', 'Backlog')
  let nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['backlog'])
  assert.equal(nav[0].enableTabStrip, false)
  // Swapping back to Knowledge Graph keeps the pane single-select.
  togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
  nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['memory-graph'])
  // Closing the open switch collapses the nav pane.
  togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
  assert.equal(navTabsets(model).length, 0)
  unregisterModel(WS)
}

// Sprint Engines is NOT a nav-rail component: the survey is the instance-global
// Sprints door surface, outside any workspace layout.
{
  assert.equal(NAV_RAIL_COMPONENTS.has('sprint-engines'), false)
}

// Agent reveal activates the target workspace and focuses the concrete agent
// tab when the workspace's live FlexLayout model is mounted.
{
  const model = freshModel()
  const active: string[] = []
  let updatedLayout: IJsonModel | null = null
  registerModel(WS, model)
  assert.equal(revealAgentTab({
    workspaceId: WS,
    agentId: 'a-1',
  }, {
    getWorkspace: () => ({
      id: WS,
      layoutModel: model.toJson(),
      agents: { 'a-1': { name: 'Review agent' } },
    }),
    setActiveWorkspace: (workspaceId) => active.push(workspaceId),
    updateLayout: (_workspaceId, layoutModel) => { updatedLayout = layoutModel },
  }), true)
  assert.deepEqual(active, [WS])
  assert.equal(updatedLayout, null)
  assert.deepEqual(tabNames(model), ['Review agent'])
  unregisterModel(WS)
}

// Reveal into the hidden Automations host: "Open agent" activates the host
// workspace and focuses the run's concrete agent tab, preserving the green-flash
// reveal. The host is mode-agnostic to the reveal ports (its hidden-ness is
// enforced at the WorkspaceManager activation layer, T4), so the fixture stands
// in for the host's own layout — a mounted model whose only content is the run's
// agent terminal.
{
  const hostJson: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [
            { type: 'tab', name: 'agent', component: 'agent', config: { agentId: 'host-run-1' } },
          ],
        },
      ],
    },
  }
  const hostModel = Model.fromJson(hostJson)
  const HOST_WS = 'automations-host-ws'
  const active: string[] = []
  let updatedLayout: IJsonModel | null = null
  registerModel(HOST_WS, hostModel)
  assert.equal(revealAgentTab({
    workspaceId: HOST_WS,
    agentId: 'host-run-1',
    name: 'Nightly digest',
  }, {
    getWorkspace: () => ({
      id: HOST_WS,
      layoutModel: hostModel.toJson(),
      agents: { 'host-run-1': { name: 'Nightly digest' } },
    }),
    setActiveWorkspace: (workspaceId) => active.push(workspaceId),
    updateLayout: (_workspaceId, layoutModel) => { updatedLayout = layoutModel },
  }), true)
  // The host was activated, the live model was used (no persisted-layout fallback),
  // and the agent tab was renamed to the run's display name.
  assert.deepEqual(active, [HOST_WS])
  assert.equal(updatedLayout, null)
  assert.deepEqual(tabNames(hostModel), ['Nightly digest'])
  // The green spawn-flash is re-applied so the revealed run is called out.
  const revealedTab = allTabs(hostModel).find((tab) => tab.config?.agentId === 'host-run-1')
  assert.equal(revealedTab?.className, 'agent-tab-spawn-flash', 'the reveal flashes the host agent tab green')
  unregisterModel(HOST_WS)
}

// If activation has not mounted the live model yet, reveal mutates the
// persisted layout so the concrete agent tab appears and is selected on mount.
{
  const base = freshModel()
  const active: string[] = []
  let updatedLayout: IJsonModel | null = null
  unregisterModel(WS)
  assert.equal(revealAgentTab({
    workspaceId: WS,
    agentId: 'a-2',
  }, {
    getWorkspace: () => ({
      id: WS,
      layoutModel: base.toJson(),
      agents: { 'a-2': { name: 'Spawned agent' } },
    }),
    setActiveWorkspace: (workspaceId) => active.push(workspaceId),
    updateLayout: (_workspaceId, layoutModel) => { updatedLayout = layoutModel },
  }), true)
  assert.deepEqual(active, [WS])
  assert.ok(updatedLayout)
  const updatedModel = Model.fromJson(updatedLayout)
  assert.deepEqual(
    allTabs(updatedModel).filter((tab) => tab.component === 'agent').map((tab) => tab.config?.agentId),
    ['a-1', 'a-2']
  )
  assert.deepEqual(tabNames(updatedModel), ['Agent', 'Spawned agent'])
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
  assert.deepEqual(tabsets(model).map(componentsOf), [['editor'], ['agent']])
  unregisterModel(WS)
}

// Opening a real file while a terminal/agent tabset is active creates a
// document tabset to its left instead of stacking the editor into the terminal
// strip.
{
  const model = freshModel()
  registerModel(WS, model)
  assert.equal(focusOrAddFileTab(WS, '/tmp/app.ts', 'app.ts'), true)
  const orderedTabsets = tabsets(model)
  assert.deepEqual(orderedTabsets.map(componentsOf), [['file-editor'], ['agent']])
  const fileTab = allTabs(model).find((tab) => tab.component === 'file-editor')
  assert.ok(fileTab)
  assert.equal(fileTab.enableClose, true)
  unregisterModel(WS)
}

// With the nav rail open, file tabs land to its right and still to the left of
// terminals/agents: Files/Git/Knowledge -> Editor -> terminals/agents.
{
  const model = freshModel()
  registerModel(WS, model)
  revealNavRailComponent(WS, 'explorer', 'Files')
  assert.equal(focusOrAddFileTab(WS, '/tmp/app.ts', 'app.ts'), true)
  assert.deepEqual(tabsets(model).map(componentsOf), [['explorer'], ['file-editor'], ['agent']])
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.equal(nav[0].enableTabStrip, false)
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

// A terminal spawned when the sidebar nav pane is the only open panel docks as
// its own column to the RIGHT, never inside the strip-less nav pane.
{
  const model = navOnlyModel()
  registerModel(WS, model)
  assert.equal(addTerminalTab(WS, 'term-1', 'Terminal'), true)
  assert.deepEqual(tabsets(model).map(componentsOf), [['backlog'], ['terminal']])
  // The nav pane stays a clean, strip-less sidebar — the terminal did not land in it.
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['backlog'])
  assert.equal(nav[0].enableTabStrip, false)
  unregisterModel(WS)
}

// An agent tiled when the sidebar nav pane is the only open panel docks as its
// own column to the RIGHT, never inside the nav pane.
{
  const model = navOnlyModel()
  registerModel(WS, model)
  assert.equal(addAgentTabTiled(WS, 'a-9', 'Spawned agent'), true)
  assert.deepEqual(tabsets(model).map(componentsOf), [['backlog'], ['agent']])
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['backlog'])
  unregisterModel(WS)
}

// With the sidebar nav pane open AND active over an existing content tabset, a
// new terminal joins the content tabset rather than the active nav pane.
{
  const model = freshModel()
  registerModel(WS, model)
  // Opening Git selects the nav pane, making it the active tabset.
  revealNavRailComponent(WS, 'git', 'Git')
  assert.equal(addTerminalTab(WS, 'term-2', 'Terminal'), true)
  assert.deepEqual(tabsets(model).map(componentsOf), [['git'], ['agent', 'terminal']])
  // The git nav pane was not used as the spawn target.
  const nav = navTabsets(model)
  assert.equal(nav.length, 1)
  assert.deepEqual(componentsOf(nav[0]), ['git'])
  unregisterModel(WS)
}

// --- Nav rail width is preserved when a sibling terminal/agent is closed ---

// solo-dev-shaped layout: strip-less nav rail (Git) + editor + agent, all
// siblings in the root row. Tabs carry ids so the agent can be deleted by id.
function navRailDevModel(): Model {
  const json: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 18,
          enableTabStrip: false,
          children: [{ type: 'tab', id: 'nav-git', name: 'Git', component: 'git' }],
        },
        { type: 'tabset', weight: 52, children: [{ type: 'tab', id: 'ed', name: 'Editor', component: 'editor' }] },
        {
          type: 'tabset',
          weight: 30,
          children: [{ type: 'tab', id: 'agent-x', name: 'Agent', component: 'agent', config: { agentId: 'x' } }],
        },
      ],
    },
  }
  return Model.fromJson(json)
}

// Headless models never run the view layout pass, so seed the rects the capture
// reads: root row 1000px wide, nav rail 180px ⇒ an 18% share.
function seedNavRailRects(model: Model): void {
  const navTab = model.getNodeById('nav-git')
  const navTabset = navTab?.getParent()
  const rootRow = navTabset?.getParent()
  assert.ok(navTabset && rootRow, 'expected nav tabset under the root row')
  rootRow!.setRect(new Rect(0, 0, 1000, 800))
  navTabset!.setRect(new Rect(0, 0, 180, 800))
}

// Reads the live weight of the tabset that holds a tab with the given component.
// toJson omits an attribute left at its default, so an absent weight is
// flexlayout's default of 100, not zero.
function tabsetWeight(model: Model, component: string): number {
  type WeightedTabset = TabsetJson & { weight?: number }
  let weight = 0
  const walk = (node: WeightedTabset | undefined) => {
    if (!node) return
    if (node.type === 'tabset' && (node.children ?? []).some((c) => c.component === component)) {
      weight = node.weight ?? 100
    }
    node.children?.forEach((child) => walk(child as WeightedTabset))
  }
  walk((model.toJson() as unknown as { layout: WeightedTabset }).layout)
  return weight
}

// captureRailWidthFraction reports the rail's share of its parent row.
{
  const model = navRailDevModel()
  seedNavRailRects(model)
  const fraction = captureRailWidthFraction(model, 'left')
  assert.ok(fraction != null && Math.abs(fraction - 0.18) < 0.001, `expected 0.18, got ${fraction}`)
  // Nothing is docked on the right in this layout.
  assert.equal(captureRailWidthFraction(model, 'right'), null)
}

// Regression: closing the agent WITHOUT re-pinning lets flexlayout spread the
// freed weight into the nav rail — it grows from 18% to ~26% of the row.
{
  const model = navRailDevModel()
  model.doAction(Actions.deleteTab('agent-x'))
  const navW = tabsetWeight(model, 'git')
  const edW = tabsetWeight(model, 'editor')
  const fraction = navW / (navW + edW)
  assert.ok(Math.abs(fraction - 18 / 70) < 0.01, `expected the bug's ~0.257, got ${fraction}`)
}

// Fix: capture the rail before the close, delete the agent, then restore — the
// rail holds its 18% and the freed space flows to the editor instead.
{
  const model = navRailDevModel()
  seedNavRailRects(model)
  const fraction = captureRailWidthFraction(model, 'left')
  assert.ok(fraction != null)
  model.doAction(Actions.deleteTab('agent-x'))
  restoreRailWidthFraction(model, fraction!, 'left')
  const navW = tabsetWeight(model, 'git')
  const edW = tabsetWeight(model, 'editor')
  const preserved = navW / (navW + edW)
  assert.ok(Math.abs(preserved - 0.18) < 0.005, `expected the rail pinned at 0.18, got ${preserved}`)
  // The editor absorbed the closed agent's space (was 52%, now ~82%).
  assert.ok(edW / (navW + edW) > 0.8, 'editor should absorb the freed space')
}

// restoreRailWidthFraction is a no-op when there are no content siblings left
// (rail alone fills the row) and ignores out-of-range fractions.
{
  const model = navRailDevModel()
  model.doAction(Actions.deleteTab('agent-x'))
  model.doAction(Actions.deleteTab('ed'))
  const before = tabsetWeight(model, 'git')
  restoreRailWidthFraction(model, 0.18, 'left')
  assert.equal(tabsetWeight(model, 'git'), before, 'rail weight unchanged with no siblings')
}

// --- The right rail: a second exclusive group, not a fifth nav component ---

function skillsTabsets(model: Model): TabsetJson[] {
  return tabsets(model).filter((tabset) => componentsOf(tabset).includes('skills'))
}

// Skills is its own rail, so it is NOT in the left set — that is what keeps
// opening it from closing Backlog.
{
  assert.equal(NAV_RAIL_COMPONENTS.has('skills'), false)
  assert.deepEqual([...RIGHT_RAIL_COMPONENTS], ['skills'])
}

// First Skills toggle docks a strip-less pane on the RIGHT of the root row,
// past the terminals.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  const skills = skillsTabsets(model)
  assert.equal(skills.length, 1)
  assert.deepEqual(componentsOf(skills[0]), ['skills'])
  assert.equal(skills[0].enableTabStrip, false)
  // Rightmost sibling in the row, with the agent tabset still to its left.
  assert.deepEqual(tabsets(model).map(componentsOf), [['agent'], ['skills']])
  unregisterModel(WS)
}

// The pairing the whole design exists for: Backlog left and Skills right stay
// open together, with the terminal tabset between them. Neither closes the
// other, in either open order.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'backlog', 'Backlog')
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  assert.deepEqual(tabsets(model).map(componentsOf), [['backlog'], ['agent'], ['skills']])
  // Swapping the left switch to Files leaves Skills untouched.
  togglePanelRailComponent(WS, 'explorer', 'Files')
  assert.deepEqual(tabsets(model).map(componentsOf), [['explorer'], ['agent'], ['skills']])
  // Closing Skills leaves the left rail alone, and vice versa.
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  assert.deepEqual(tabsets(model).map(componentsOf), [['explorer'], ['agent']])
  unregisterModel(WS)
}

// Opening the right aside preserves the active agent tabset. If it selected
// itself here, the pane would mount with no remembered target and fall back to
// the first agent in document order.
{
  const model = Model.fromJson({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          selected: 0,
          children: [
            { type: 'tab', component: 'agent', name: 'First', config: { agentId: 'a-first' } },
          ],
        },
        {
          type: 'tabset',
          active: true,
          selected: 0,
          children: [
            {
              type: 'tab',
              component: 'agent',
              name: 'Current',
              config: { agentId: 'a-current', sessionId: 's-current' },
            },
          ],
        },
      ],
    },
  })
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  assert.deepEqual(
    focusedAgentTabInLayout(model.toJson()),
    { agentId: 'a-current', sessionId: 's-current' },
    'opening Skills must not retarget from the current agent to the first agent',
  )
  unregisterModel(WS)
}

// Re-toggling Skills collapses its pane; revealing it again re-docks right.
{
  const model = freshModel()
  registerModel(WS, model)
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  assert.equal(skillsTabsets(model).length, 0)
  revealNavRailComponent(WS, 'skills', 'Skills and MCPs')
  revealNavRailComponent(WS, 'skills', 'Skills and MCPs')
  assert.equal(allComponents(model).filter((c) => c === 'skills').length, 1)
  unregisterModel(WS)
}

// New terminals never dock into the Skills pane — it is a rail, like the nav
// pane on the other edge.
{
  const model = freshModel()
  registerModel(WS, model)
  // Revealing Skills keeps the content tabset active; it is an aside acting on
  // that content, not a new send target.
  revealNavRailComponent(WS, 'skills', 'Skills and MCPs')
  assert.equal(addTerminalTab(WS, 'term-2', 'Terminal'), true)
  assert.deepEqual(tabsets(model).map(componentsOf), [['agent', 'terminal'], ['skills']])
  unregisterModel(WS)
}

// The freshly docked right rail is pinned to its ~348px default rather than
// flexlayout's default weight of 100, which would take half the row.
{
  const model = freshModel()
  registerModel(WS, model)
  model.getRoot().setRect(new Rect(0, 0, 1200, 800))
  togglePanelRailComponent(WS, 'skills', 'Skills and MCPs')
  const skillsW = tabsetWeight(model, 'skills')
  const agentW = tabsetWeight(model, 'agent')
  const share = skillsW / (skillsW + agentW)
  assert.ok(Math.abs(share - 348 / 1200) < 0.005, `expected a 348/1200 share, got ${share}`)
  assert.equal(skillsTabsets(model)[0].minWidth, 280)
  unregisterModel(WS)
}

// --- Both rails survive a sibling close, from the same capture/restore pair ---

// Backlog left · editor · agent · Skills right, all siblings in the root row.
// The editor is what should absorb a closed agent's space.
function bothRailsModel(): Model {
  const json: IJsonModel = {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 18,
          enableTabStrip: false,
          children: [{ type: 'tab', id: 'nav-backlog', name: 'Backlog', component: 'backlog' }],
        },
        { type: 'tabset', weight: 22, children: [{ type: 'tab', id: 'ed', name: 'Editor', component: 'editor' }] },
        {
          type: 'tabset',
          weight: 30,
          children: [{ type: 'tab', id: 'agent-x', name: 'Agent', component: 'agent', config: { agentId: 'x' } }],
        },
        {
          type: 'tabset',
          weight: 30,
          enableTabStrip: false,
          children: [{ type: 'tab', id: 'aside-skills', name: 'Skills and MCPs', component: 'skills' }],
        },
      ],
    },
  }
  const model = Model.fromJson(json)
  // Headless models never run the view layout pass, so seed the rects the
  // capture reads: root row 1000px, Backlog 180px (18%), Skills 300px (30%).
  const backlogTabset = model.getNodeById('nav-backlog')?.getParent()
  const skillsTabset = model.getNodeById('aside-skills')?.getParent()
  const rootRow = backlogTabset?.getParent()
  assert.ok(backlogTabset && skillsTabset && rootRow, 'expected both rails under the root row')
  rootRow!.setRect(new Rect(0, 0, 1000, 800))
  backlogTabset!.setRect(new Rect(0, 0, 180, 800))
  skillsTabset!.setRect(new Rect(700, 0, 300, 800))
  return model
}

// Regression the width fix exists for, now on the right edge too: closing the
// agent WITHOUT re-pinning lets flexlayout spread its weight into both rails —
// Skills grows from 30% of the row to ~43%.
{
  const model = bothRailsModel()
  model.doAction(Actions.deleteTab('agent-x'))
  const total = ['backlog', 'editor', 'skills'].reduce((sum, c) => sum + tabsetWeight(model, c), 0)
  assert.ok(
    tabsetWeight(model, 'skills') / total > 0.4,
    `expected the bug's ~0.43 right-rail share, got ${tabsetWeight(model, 'skills') / total}`
  )
  assert.ok(
    tabsetWeight(model, 'backlog') / total > 0.24,
    'the left rail grows the same way'
  )
}

// Fix: ONE capture/restore pair pins BOTH rails — there is no second copy of
// this logic for the right edge — and the freed space flows to the editor.
{
  const model = bothRailsModel()
  const fractions = captureRailWidthFractions(model)
  assert.ok(fractions != null)
  assert.ok(Math.abs(fractions!.left! - 0.18) < 0.001, `left ${fractions!.left}`)
  assert.ok(Math.abs(fractions!.right! - 0.30) < 0.001, `right ${fractions!.right}`)
  model.doAction(Actions.deleteTab('agent-x'))
  restoreRailWidthFractions(model, fractions!)
  const total = ['backlog', 'editor', 'skills'].reduce((sum, c) => sum + tabsetWeight(model, c), 0)
  const leftShare = tabsetWeight(model, 'backlog') / total
  const rightShare = tabsetWeight(model, 'skills') / total
  assert.ok(Math.abs(leftShare - 0.18) < 0.005, `expected the left rail pinned at 0.18, got ${leftShare}`)
  assert.ok(Math.abs(rightShare - 0.30) < 0.005, `expected the right rail pinned at 0.30, got ${rightShare}`)
  // The editor absorbed the closed agent's space (was 22%, now ~52%).
  assert.ok(tabsetWeight(model, 'editor') / total > 0.5, 'editor should absorb the freed space')
}

// flashAgentTab re-applies the green spawn-flash classes to an agent tab that
// already exists — the "Open agent" highlight — and reports it flashed live.
{
  const model = freshModel()
  registerModel(WS, model)
  const agentTab = () => allTabs(model).find((tab) => tab.config?.agentId === 'a-1')
  assert.equal(agentTab()?.className ?? '', '', 'tab starts without the flash class')
  assert.equal(flashAgentTab(WS, 'a-1'), true)
  assert.equal(agentTab()?.className, 'agent-tab-spawn-flash')
  assert.equal(agentTab()?.contentClassName, 'agent-tab-spawn-flash-panel')
  unregisterModel(WS)
}

// A user-colored agent tab keeps its existing class; the flash class is added
// alongside, not in place of it.
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
            { type: 'tab', name: 'Agent', component: 'agent', className: 'tab-color-violet', config: { agentId: 'a-1' } },
          ],
        },
      ],
    },
  }
  const model = Model.fromJson(json)
  registerModel(WS, model)
  assert.equal(flashAgentTab(WS, 'a-1'), true)
  const className = allTabs(model).find((tab) => tab.config?.agentId === 'a-1')?.className ?? ''
  assert.ok(className.includes('tab-color-violet'), 'keeps the existing color class')
  assert.ok(className.includes('agent-tab-spawn-flash'), 'adds the flash class')
  unregisterModel(WS)
}

// With no live model, flashAgentTab latches; consumePendingAgentFlash applies it
// once the workspace's model registers on mount.
{
  unregisterModel(WS)
  assert.equal(flashAgentTab(WS, 'a-1'), false, 'no live model: latches instead of flashing')
  const model = freshModel()
  registerModel(WS, model)
  consumePendingAgentFlash(WS)
  const className = allTabs(model).find((tab) => tab.config?.agentId === 'a-1')?.className ?? ''
  assert.equal(className, 'agent-tab-spawn-flash', 'pending flash applied on mount')
  // The latch is one-shot: a second mount must not re-flash.
  unregisterModel(WS)
  const remount = freshModel()
  registerModel(WS, remount)
  consumePendingAgentFlash(WS)
  assert.equal(
    allTabs(remount).find((tab) => tab.config?.agentId === 'a-1')?.className ?? '',
    '',
    'latch is drained after first consume',
  )
  unregisterModel(WS)
}

// --- focusedAgentTabInLayout ------------------------------------------------
// The Skills pane asks "which agent am I describing?" of the persisted layout,
// because that JSON is rewritten on every layout mutation and the live Model has
// no listener API.
{
  const tab = (agentId: string, sessionId?: string) => ({
    type: 'tab',
    component: 'agent',
    name: agentId,
    config: sessionId ? { agentId, sessionId } : { agentId },
  })

  const twoTabsets: IJsonModel = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', selected: 0, children: [tab('a-left')] },
        { type: 'tabset', active: true, selected: 1, children: [tab('a-1'), tab('a-2', 's-2')] },
      ],
    },
  }
  assert.deepEqual(
    focusedAgentTabInLayout(twoTabsets),
    { agentId: 'a-2', sessionId: 's-2' },
    'the active tabset’s selected tab wins',
  )

  const asideActive: IJsonModel = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', selected: 0, children: [tab('a-left')] },
        { type: 'tabset', selected: 0, children: [tab('a-right', 's-right')] },
        {
          type: 'tabset',
          active: true,
          selected: 0,
          children: [{ type: 'tab', component: 'skills', name: 'Skills and MCPs' }],
        },
      ],
    },
  }
  assert.deepEqual(
    focusedAgentTabInLayout(asideActive, { agentId: 'a-right', sessionId: 's-right' }),
    { agentId: 'a-right', sessionId: 's-right' },
    'clicking the aside keeps the last focused agent instead of falling back to the first one',
  )

  const noActive: IJsonModel = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [{ type: 'tabset', selected: 0, children: [tab('a-only')] }],
    },
  }
  assert.deepEqual(
    focusedAgentTabInLayout(noActive),
    { agentId: 'a-only', sessionId: null },
    'with no active tabset the first agent tab stands in; an unlaunched agent has no session',
  )

  const paneOnly: IJsonModel = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', selected: 0, children: [{ type: 'tab', component: 'skills', name: 'Skills and MCPs' }] },
      ],
    },
  }
  assert.equal(focusedAgentTabInLayout(paneOnly), null, 'a pane-only workspace focuses no agent')

  const selectedIsNotAnAgent: IJsonModel = {
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          active: true,
          selected: 1,
          children: [tab('a-1'), { type: 'tab', component: 'file-editor', name: 'index.ts' }],
        },
      ],
    },
  }
  assert.equal(
    focusedAgentTabInLayout(selectedIsNotAnAgent),
    null,
    'an editor on top of an agent tab means no agent is on screen',
  )

  assert.equal(focusedAgentTabInLayout(undefined), null)
}

console.log('modelRegistry.test.ts: ok')
