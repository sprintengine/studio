import type { IJsonModel } from 'flexlayout-react'
import { railSideOfComponents } from '../../utils/modelRegistry'
import { adoptLegacyBacklogTab, paneStateFromLegacyLayout } from './workspacePaneSlice'
import { workspaceSyncClient } from '../workspaceSyncClient'
import type {
  Workspace,
  WorkspaceId,
} from '../../types/workspace'

export function modelContainsComponent(value: unknown, component: string): boolean {
  if (!value) return false
  if (Array.isArray(value)) {
    return value.some((entry) => modelContainsComponent(entry, component))
  }
  if (typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  if (record.component === component) return true

  return Object.values(record).some((entry) => modelContainsComponent(entry, component))
}

function stripComponentTabsFromLayoutNode(node: unknown, component: string): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (record.type === 'tab' && record.component === component) return null

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren
    .map((child) => stripComponentTabsFromLayoutNode(child, component))
    .filter((child) => child !== null && child !== undefined)

  // A node emptied BY the strip collapses; one that was empty to begin with
  // (FlexLayout persists an empty root tabset after the last tab closes) is
  // untouched content and keeps its identity below.
  if ((record.type === 'tabset' || record.type === 'row') && nextChildren.length === 0 && rawChildren.length > 0) {
    return null
  }

  // Nothing under this node was stripped: hand the same node back, so a heal
  // that runs on every hydration is a no-op by reference when there is nothing
  // to do (the store's merge() and the registry snapshot rely on that).
  if (
    nextChildren.length === rawChildren.length
    && nextChildren.every((child, index) => child === rawChildren[index])
  ) {
    return record
  }

  const next: Record<string, unknown> = { ...record, children: nextChildren }
  if (record.type === 'tabset' && typeof record.selected === 'number') {
    next.selected = nextChildren.length === 0
      ? 0
      : Math.max(0, Math.min(record.selected, nextChildren.length - 1))
  }
  return next
}

function stripComponentTabsFromLayout(layoutModel: unknown, component: string): unknown {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const model = layoutModel as Record<string, unknown>
  const layout = model.layout
  if (!layout || typeof layout !== 'object') return layoutModel
  const nextLayout = stripComponentTabsFromLayoutNode(layout, component)
  if (nextLayout === layout) return layoutModel
  // A layout whose every tab was stripped collapses to null; fall back to an
  // empty root row (WorkspaceLayout's zero-tab empty state) rather than
  // restoring the original layout with the retired tab still in it.
  return { ...model, layout: nextLayout ?? { type: 'row', children: [] } }
}

export function stripSettingsTabsFromLayout(layoutModel: unknown): unknown {
  return stripComponentTabsFromLayout(layoutModel, 'settings')
}

// Files and Git moved from the left rail into the workspace pane, and the
// Skills aside was deleted (browser-pane epic, store v73); the workspace
// Backlog followed them (store v74). A persisted layout still carrying their
// tabs would render the unavailable surface; drop them.
// `paneStateFromLegacyLayout` / `adoptLegacyBacklogTab` read the same layout
// first so the person's open panels come back as pane tabs.
export function stripRetiredRailTabsFromLayout(layoutModel: unknown): unknown {
  return ['explorer', 'git', 'skills', 'backlog'].reduce(
    (model, component) => stripComponentTabsFromLayout(model, component),
    layoutModel,
  )
}

// Components whose modules were retired. A profile written by an older build
// still names them in its persisted layout, and the model registry no longer
// resolves them, so a surviving tab would render an empty surface — drop them
// on hydration the same way the rail-to-pane move drops its tabs.
export const RETIRED_MODULE_TAB_COMPONENTS: readonly string[] = [
  'switchboard-workspace',
  'switchboard-board',
  // The Design Wizard (`design-wizard` module) was deleted 2026-09-08. Its
  // workspace layout was a single sticky 'guided-brief' tab, so the row itself
  // is dropped by dropRetiredModeWorkspaces; this covers a profile where the
  // tab was dragged into some other workspace's layout.
  'guided-brief',
  // The in-tree sprint engine was deleted 2026-09-16. Its workspace rows are
  // dropped by dropRetiredModeWorkspaces; these cover a board or one of its
  // pre-v48 segment tabs dragged into some other workspace's layout, plus the
  // survey tab that used to sit on the per-workspace nav rail, and the
  // Architect Plan reader the board opened beside itself.
  'sprintengine',
  'sprintengine-plan-reader',
  'sprintengine-inbox',
  'sprintengine-roster',
  'sprintengine-tasks',
  'sprint-engines',
]

export function stripRetiredModuleTabsFromLayout(layoutModel: unknown): unknown {
  return RETIRED_MODULE_TAB_COMPONENTS.reduce(
    (model, component) => stripComponentTabsFromLayout(model, component),
    layoutModel,
  )
}

/**
 * The whole rail-to-pane move for one workspace record: seed the pane from a
 * layout that still docks Files/Git/Backlog (only when the record carries no
 * pane yet), adopt a still-docked Backlog into a record that already has a
 * pane (v74 — after v73 every record has one), then strip the retired tabs.
 * Reference-preserving when there is nothing to do, so it is safe on every
 * hydration — which is where it has to run: main owns the registry (MC-2158)
 * and hands the renderer records that never pass the persist ladder, so the
 * versioned rungs alone would miss them.
 */
export function healRetiredRailLayout(ws: Workspace): Workspace {
  const paneState = ws.paneState
    ? adoptLegacyBacklogTab(ws.layoutModel, ws.paneState)
    : paneStateFromLegacyLayout(ws.layoutModel)
  const layoutModel = stripRetiredModuleTabsFromLayout(stripRetiredRailTabsFromLayout(ws.layoutModel))
  if (paneState === ws.paneState && layoutModel === ws.layoutModel) return ws
  return {
    ...ws,
    layoutModel: layoutModel as Workspace['layoutModel'],
    ...(paneState ? { paneState } : {}),
  }
}

// Files / Git / Knowledge Graph are exclusive strip-less switches sharing the
// left pane, Skills is the same idiom on the right; the membership answer is
// owned by modelRegistry so the migration and the runtime toggle never drift.
// A tabset qualifies only when every tab belongs to the SAME rail — a mixed
// tabset keeps its strip and self-heals on the next toggle.
function tabsetIsOneRail(record: Record<string, unknown>): boolean {
  const children = Array.isArray(record.children) ? record.children : []
  if (children.length === 0) return false
  const components: string[] = []
  for (const child of children) {
    if (!child || typeof child !== 'object') return false
    const childRecord = child as Record<string, unknown>
    if (childRecord.type !== 'tab' || typeof childRecord.component !== 'string') return false
    components.push(childRecord.component)
  }
  return railSideOfComponents(components) !== null
}

function hideNavRailTabStripInNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (record.type === 'tabset' && tabsetIsOneRail(record)) {
    return { ...record, enableTabStrip: false }
  }

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren.map((child) => hideNavRailTabStripInNode(child))
  return { ...record, children: nextChildren }
}

// The rail switches (Knowledge Graph today; Files / Git / Backlog before they
// moved into the workspace pane) carry their own selection chrome, so the
// FlexLayout tab strip on a tabset that holds only one rail's switches is
// redundant. Stamp enableTabStrip: false onto those tabsets without touching
// mixed tabsets (e.g. a nav tab parked beside the editor) — those keep their
// strip and self-heal on the next toggle. Kept under its original name: four
// store modules import it.
export function hideNavRailTabStrip(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  const nextLayout = hideNavRailTabStripInNode(layout)
  return { ...layoutModel, layout: nextLayout as IJsonModel['layout'] }
}

// Layout state lives per-workspace in workspace.layoutModel; the layout slice
// owns the layout-mutation action (updateLayout) and exports the layout-model
// helpers used by addWorkspace, importWorkspace, and persisted-state migrations.
interface LayoutSliceState {}

interface LayoutSliceActions {
  updateLayout: (id: WorkspaceId, model: IJsonModel) => void
}

export type LayoutSlice = LayoutSliceState & LayoutSliceActions

type LayoutSliceCarrier = { workspaces: Workspace[] }
type LayoutSliceSet = (mutator: (state: LayoutSliceCarrier) => void) => void

export function createLayoutSlice(set: LayoutSliceSet): LayoutSlice {
  return {
    // `layoutModel` is renderer-AUTHORED and main-PERSISTED (MC-2158). Only a
    // window can compute a layout change — FlexLayout lives here — so the model
    // is applied locally and then sent as a command; main stores it. Main needs
    // the field at all because a workspace it mints headlessly must be fully
    // formed, and a workspace with no layout is not.
    updateLayout: (id, model) => {
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.layoutModel = model
      })
      void workspaceSyncClient.dispatchUpdateWorkspaceLayout(id, model)
    },
  }
}
