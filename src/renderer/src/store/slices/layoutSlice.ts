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
        children: [
          { type: 'tab', name: 'Inbox', component: 'sprintengine-inbox' },
          { type: 'tab', name: 'Roster', component: 'sprintengine-roster' },
          { type: 'tab', name: 'Tasks', component: 'sprintengine-tasks' },
        ],
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
  // Anything that doesn't already contain the new three-tab shape is
  // treated as legacy and rewritten to Inbox / Roster / Tasks. Covers the
  // single-panel `'sprintengine'` shape, the retired `-project`/`-task-graph`
  // /`-kanban`/`-map`/`-terminals` flex tabs, and any partial layout.
  const serialized = JSON.stringify(model)
  const hasNewShape =
    serialized.includes('"component":"sprintengine-inbox"')
    || serialized.includes('"component":"sprintengine-roster"')
    || serialized.includes('"component":"sprintengine-tasks"')
  if (hasNewShape) return false
  return (
    serialized.includes('"component":"sprintengine')
    // Catches all sprintengine-prefixed legacy components.
  )
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
