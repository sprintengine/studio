import type { IJsonModel } from 'flexlayout-react'
import { buildSprintEngineAgentRosterForState } from '../../utils/sprintengine'
import type {
  SprintEngineState,
  Workspace,
  WorkspaceId,
} from '../../types/workspace'

const sprintEngineAgentTab = (id: string, name: string) => ({
  type: 'tab',
  name,
  component: 'agent',
  config: { agentId: id },
})

// The Sprint Engine board owns Inbox / Roster / Tasks as internal segmented
// chrome (see SprintEngineBoardPanel). It lives as a single non-closeable
// FlexLayout tab so the workspace nav stays stable.
const sprintEngineBoardTab = () => ({
  type: 'tab',
  name: 'Sprint Engine',
  component: 'sprintengine',
  enableClose: false,
})

export const sprintEngineTabsLayoutModel = (
  sprintEngineState: SprintEngineState | null,
  agents: Workspace['agents'] = {},
  options?: { includeAgentTabs?: boolean }
): IJsonModel => ({
  global: { tabSetEnableDrop: true, tabEnableClose: true },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: options?.includeAgentTabs === false ? 100 : 58,
        // The SE board owns its own segmented nav (workspace top bar), so the
        // FlexLayout tab strip on this tabset would just be redundant chrome.
        enableTabStrip: false,
        children: [sprintEngineBoardTab()],
      },
      ...(options?.includeAgentTabs === false
        ? []
        : [{
          type: 'tabset',
          weight: 42,
          children: buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) =>
            sprintEngineAgentTab(agent.id, agents[agent.id]?.name ?? agent.label)
          ),
        }]),
    ],
  },
})

export const multiloopTabsLayoutModel = (): IJsonModel => ({
  global: { tabSetEnableDrop: true, tabEnableClose: true },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: 100,
        children: [
          { type: 'tab', name: 'Multiloop', component: 'multiloop-board' },
        ],
      },
    ],
  },
})

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

export function hasMultiloopBoardLayout(model: IJsonModel | null | undefined): boolean {
  return modelContainsComponent(model, 'multiloop-board')
}

export function ensureMultiloopLayoutModel(model: IJsonModel | null | undefined): IJsonModel {
  return model && hasMultiloopBoardLayout(model) ? model : multiloopTabsLayoutModel()
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

function stripSettingsTabsFromLayoutNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>

  if (record.type === 'tab' && record.component === 'settings') return null

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren
    .map((child) => stripSettingsTabsFromLayoutNode(child))
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

export function stripSettingsTabsFromLayout(layoutModel: unknown): unknown {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const model = layoutModel as Record<string, unknown>
  const layout = model.layout
  if (!layout || typeof layout !== 'object') return layoutModel
  const nextLayout = stripSettingsTabsFromLayoutNode(layout)
  return { ...model, layout: nextLayout ?? layout }
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

  if (record.type === 'tabset' && tabsetContainsGuidedBrief(record)) {
    return { ...record, enableTabStrip: false }
  }

  const rawChildren = record.children
  if (!Array.isArray(rawChildren)) return record

  const nextChildren = rawChildren.map((child) => hideGuidedBriefTabStripInNode(child))
  return { ...record, children: nextChildren }
}

// The guided brief panel owns the visible chrome (step nav, conversation /
// preview / brief panes), so the FlexLayout tab strip on the tabset that
// hosts it is redundant. Stamp enableTabStrip: false onto whichever tabset
// wraps the 'guided-brief' tab without touching other tabsets.
export function hideGuidedBriefTabStrip(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  const nextLayout = hideGuidedBriefTabStripInNode(layout)
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
    updateLayout: (id, model) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.layoutModel = model
      }),
  }
}
