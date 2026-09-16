import type { IJsonModel } from 'flexlayout-react'
import {
  SPRINT_ENGINE_WORKSPACE_TYPE_ID,
  sprintEngineTabsLayoutModel,
} from '../../../shared/sprintengine/workspace-record'
import type { Workspace } from '../types/workspace'
import { legacySprintEngineRunState } from '../store/slices/workspaceModuleState'
import { isSprintEngineWorkspace } from '../utils/sprintEngineWorkspace'

// Sprint board layout helpers (MC-2577). The canonical layout is a single
// board tab whose component id is the registered workspace type id; Inbox /
// Roster / Tasks are internal chrome inside the board. These used to live in
// the core layout slice so persist migrations could rewrite older layouts;
// they belong with the type that owns that tab.

export function isLegacySprintEngineLayout(model: IJsonModel): boolean {
  const serialized = JSON.stringify(model)
  const hasLegacyViewTabs =
    serialized.includes(`"component":"${SPRINT_ENGINE_WORKSPACE_TYPE_ID}-inbox"`)
    || serialized.includes(`"component":"${SPRINT_ENGINE_WORKSPACE_TYPE_ID}-roster"`)
    || serialized.includes(`"component":"${SPRINT_ENGINE_WORKSPACE_TYPE_ID}-tasks"`)
  if (hasLegacyViewTabs) return true
  return !serialized.includes(`"component":"${SPRINT_ENGINE_WORKSPACE_TYPE_ID}"`)
}

export function migrateSprintEngineLayout(ws: Workspace): Workspace {
  const run = legacySprintEngineRunState(ws)
  if (!isSprintEngineWorkspace(ws) && !run) return ws

  if (!isLegacySprintEngineLayout(ws.layoutModel)) return ws

  return {
    ...ws,
    layoutModel: sprintEngineTabsLayoutModel(run, ws.agents),
  }
}

function tabsetContainsSprintEngineBoard(record: Record<string, unknown>): boolean {
  const children = Array.isArray(record.children) ? record.children : []
  return children.some((child) => {
    if (!child || typeof child !== 'object') return false
    const childRecord = child as Record<string, unknown>
    return childRecord.type === 'tab' && childRecord.component === SPRINT_ENGINE_WORKSPACE_TYPE_ID
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

export function hideSprintEngineBoardTabStrip(
  layoutModel: IJsonModel | null | undefined
): IJsonModel | null | undefined {
  if (!layoutModel || typeof layoutModel !== 'object') return layoutModel
  const layout = layoutModel.layout
  if (!layout) return layoutModel
  const nextLayout = hideSprintEngineBoardTabStripInNode(layout)
  return { ...layoutModel, layout: nextLayout as IJsonModel['layout'] }
}
