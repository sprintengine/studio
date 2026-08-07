import type { IJsonModel } from 'flexlayout-react'
// The board layout moved to shared with MC-2160 (main composes sprint
// workspaces headlessly and stores the same layout); re-exported so every
// existing renderer import site is unchanged.
import { sprintEngineTabsLayoutModel } from '../../../../shared/sprintengine/workspace-record'

export { sprintEngineTabsLayoutModel }

import { railSideOfComponents } from '../../utils/modelRegistry'
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

export function isLegacySprintEngineLayout(model: IJsonModel): boolean {
  // The canonical Sprint Engine layout is a single `'sprintengine'` board
  // tab; Inbox / Roster / Tasks are now internal chrome inside the board.
  // Anything that includes the retired view-specific tabs (or that has no
  // SE board at all) is treated as legacy and rewritten.
  const serialized = JSON.stringify(model)
  const hasLegacyViewTabs =
    serialized.includes('"component":"sprintengine-inbox"')
    || serialized.includes('"component":"sprintengine-roster"')
    || serialized.includes('"component":"sprintengine-tasks"')
  if (hasLegacyViewTabs) return true
  return !serialized.includes('"component":"sprintengine"')
}

export function migrateSprintEngineLayout(ws: Workspace): Workspace {
  if (ws.mode !== 'sprintengine' && !ws.sprintEngineState) return ws

  if (!isLegacySprintEngineLayout(ws.layoutModel)) return ws

  return {
    ...ws,
    layoutModel: sprintEngineTabsLayoutModel(ws.sprintEngineState, ws.agents),
  }
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

  if ((record.type === 'tabset' || record.type === 'row') && nextChildren.length === 0) {
    return null
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
  // A layout whose every tab was stripped collapses to null; fall back to an
  // empty root row (WorkspaceLayout's zero-tab empty state) rather than
  // restoring the original layout with the retired tab still in it.
  return { ...model, layout: nextLayout ?? { type: 'row', children: [] } }
}

export function stripSettingsTabsFromLayout(layoutModel: unknown): unknown {
  return stripComponentTabsFromLayout(layoutModel, 'settings')
}

// The Sprint Engines survey left the per-workspace nav rail (it is the Sprints
// door surface now); a persisted 'sprint-engines' tab would render an empty
// surface, so drop it from existing layouts.
export function stripSprintEnginesNavFromLayout(layoutModel: unknown): unknown {
  return stripComponentTabsFromLayout(layoutModel, 'sprint-engines')
}

const STICKY_TAB_COMPONENTS = new Set(['watchtower-panel', 'switchboard-board'])

function markStickyTabsInLayoutNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (
    record.type === 'tab'
    && typeof record.component === 'string'
    && STICKY_TAB_COMPONENTS.has(record.component)
  ) {
    return { ...record, enableClose: false, enableDrag: false }
  }

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren.map((child) => markStickyTabsInLayoutNode(child))
  return { ...record, children: nextChildren }
}

// Switchboard workspaces anchor on Watchtower + Switchboard panels. Disable
// close/drag on those specific tabs in existing user layouts so they behave
// like persistent workspace surfaces rather than disposable document tabs.
export function markSwitchboardAnchorTabsSticky(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  const nextLayout = markStickyTabsInLayoutNode(layout)
  return { ...layoutModel, layout: nextLayout as IJsonModel['layout'] }
}

function tabsetContainsSprintEngineBoard(record: Record<string, unknown>): boolean {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => {
    if (!child || typeof child !== 'object') return false
    const childRecord = child as Record<string, unknown>
    return childRecord.type === 'tab' && childRecord.component === 'sprintengine'
  })
}

function hideSprintEngineBoardTabStripInNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (record.type === 'tabset' && tabsetContainsSprintEngineBoard(record)) {
    return { ...record, enableTabStrip: false }
  }

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren.map((child) => hideSprintEngineBoardTabStripInNode(child))
  return { ...record, children: nextChildren }
}

// The Sprint Engine board has its own icon segmented nav, so the FlexLayout
// tab strip on the tabset that hosts it is redundant. Apply enableTabStrip:
// false to whichever tabset wraps the 'sprintengine' tab without touching
// other tabsets the user may have rearranged.
export function hideSprintEngineBoardTabStrip(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  const nextLayout = hideSprintEngineBoardTabStripInNode(layout)
  return { ...layoutModel, layout: nextLayout as IJsonModel['layout'] }
}

function tabsetContainsGuidedBrief(record: Record<string, unknown>): boolean {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => {
    if (!child || typeof child !== 'object') return false
    const childRecord = child as Record<string, unknown>
    return childRecord.type === 'tab' && childRecord.component === 'guided-brief'
  })
}

function hideGuidedBriefTabStripInNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (record.type === 'tab' && record.component === 'guided-brief') {
    return { ...record, enableClose: false }
  }

  if (record.type === 'tab' && record.component === 'file-editor') {
    return { ...record, enableClose: true }
  }

  if (record.type === 'tabset' && tabsetContainsGuidedBrief(record)) {
    const rawChildren = Array.isArray(record.children) ? record.children : []
    return {
      ...record,
      enableTabStrip: false,
      children: rawChildren.map((child) => hideGuidedBriefTabStripInNode(child)),
    }
  }

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren.map((child) => hideGuidedBriefTabStripInNode(child))
  return { ...record, children: nextChildren }
}

// The guided brief panel owns the visible chrome (step nav, conversation /
// preview / brief panes), so the FlexLayout tab strip on the tabset that
// hosts it is redundant. Also repair older Guided Brief layouts that disabled
// close globally: the root guided-brief tab stays sticky, but document
// file-editor tabs must remain closeable.
export function hideGuidedBriefTabStrip(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  const nextLayout = hideGuidedBriefTabStripInNode(layout)
  return { ...layoutModel, layout: nextLayout as IJsonModel['layout'] }
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

// The rail switches (Files / Git / Backlog / Knowledge Graph on the left, Skills
// on the right) carry their own selection chrome in the workspace header, so the
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

const LEGACY_SWITCHBOARD_COMPONENTS = new Set(['watchtower-panel', 'switchboard-board'])

function consolidateSwitchboardTabsInNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (record.type === 'tabset') {
    const children = Array.isArray(record.children) ? record.children : []
    const newChildren: unknown[] = []
    let wrapperInserted = false
    for (const child of children) {
      const childRec = child && typeof child === 'object' ? (child as Record<string, unknown>) : null
      if (
        childRec?.type === 'tab'
        && typeof childRec.component === 'string'
        && LEGACY_SWITCHBOARD_COMPONENTS.has(childRec.component)
      ) {
        if (!wrapperInserted) {
          newChildren.push({
            type: 'tab',
            name: 'Switchboard',
            component: 'switchboard-workspace',
            enableClose: false,
          })
          wrapperInserted = true
        }
        // Collapse any additional legacy tabs into the single wrapper.
        continue
      }
      newChildren.push(child)
    }
    const next: Record<string, unknown> = { ...record, children: newChildren }
    if (wrapperInserted && newChildren.length === 1) {
      next.enableTabStrip = false
    }
    return next
  }

  if (Array.isArray(record.children)) {
    return { ...record, children: record.children.map(consolidateSwitchboardTabsInNode) }
  }

  return record
}

function layoutContainsLegacySwitchboardTabs(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const record = node as Record<string, unknown>
  if (
    record.type === 'tab'
    && typeof record.component === 'string'
    && LEGACY_SWITCHBOARD_COMPONENTS.has(record.component)
  ) {
    return true
  }
  if (!Array.isArray(record.children)) return false
  return record.children.some(layoutContainsLegacySwitchboardTabs)
}

// Forward layouts that still carry separate 'watchtower-panel' and
// 'switchboard-board' tabs to a single 'switchboard-workspace' wrapper tab
// inside the same tabset. The wrapper's tabset gets enableTabStrip: false
// when it ends up containing only the wrapper, matching the Sprint Engine
// pattern. Non-Switchboard workspaces are untouched.
export function consolidateSwitchboardWorkspaceLayout(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  if (!layoutContainsLegacySwitchboardTabs(layout)) return layoutModel
  const nextLayout = consolidateSwitchboardTabsInNode(layout)
  return { ...layoutModel, layout: nextLayout as IJsonModel['layout'] }
}

// Layout state lives per-workspace in workspace.layoutModel; the layout slice
// owns the layout-mutation action (updateLayout) and exports the layout-model
// helpers used by addWorkspace, importWorkspace, and persisted-state migrations.
export interface LayoutSliceState {}

export interface LayoutSliceActions {
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
