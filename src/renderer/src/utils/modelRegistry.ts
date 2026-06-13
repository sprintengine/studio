import { Actions, DockLocation, Model, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { basename, pathSeparatorFor } from './paths'

const AGENT_TAB_SPAWN_FLASH_CLASS = 'agent-tab-spawn-flash'

export type AgentTerminalRevealPolicy = 'background' | 'focus-if-open' | 'reveal'

// Ephemeral registry of live flexlayout Model instances, keyed by workspace id.
// Lets components outside of WorkspaceLayout (e.g. the workspace action bar)
// dispatch actions to the active workspace's layout without prop-drilling.
const models = new Map<string, Model>()

export function registerModel(workspaceId: string, model: Model): void {
  models.set(workspaceId, model)
}

export function unregisterModel(workspaceId: string): void {
  models.delete(workspaceId)
}

export function getModel(workspaceId: string): Model | undefined {
  return models.get(workspaceId)
}

export function focusAgentTab(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) {
      targetTabId = node.getId()
    }
  })

  if (!targetTabId) return false
  model.doAction(Actions.selectTab(targetTabId))
  return true
}

function updateAgentTabConfig(
  model: Model,
  agentId: string,
  config: Record<string, unknown> | undefined,
): void {
  if (!config) return

  let targetTabId: string | null = null
  let nextConfig: Record<string, unknown> | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const existingConfig = (node.getConfig() as Record<string, unknown> | undefined) ?? {}
    if (existingConfig.agentId !== agentId) return

    targetTabId = node.getId()
    nextConfig = { ...existingConfig, ...config, agentId }
  })

  if (targetTabId && nextConfig) {
    model.doAction(Actions.updateNodeAttributes(targetTabId, { config: nextConfig }))
  }
}

/** Whether the agent's tab is the one currently shown in its tabset. */
export function isAgentTabVisible(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let visible = false
  model.visitNodes((node) => {
    if (visible || !(node instanceof TabNode) || node.getComponent() !== 'agent') return
    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId !== agentId) return
    const parent = node.getParent()
    if (parent instanceof TabSetNode) {
      visible = parent.getSelectedNode()?.getId() === node.getId()
    }
  })
  return visible
}

export function hasAgentTab(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let found = false
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) found = true
  })
  return found
}

function renameAgentTab(model: Model, agentId: string, name: string): void {
  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId && node.getName() !== name) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) model.doAction(Actions.renameTab(targetTabId, name))
}

function firstTabset(model: Model): TabSetNode | null {
  let targetTabset: TabSetNode | null = null
  model.visitNodes((node) => {
    if (!targetTabset && node instanceof TabSetNode) targetTabset = node
  })
  return targetTabset
}

function agentTileLocation(targetTabset: TabSetNode): DockLocation {
  const rect = targetTabset.getRect()
  if (rect.width > 0 && rect.height > 0 && rect.height > rect.width) {
    return DockLocation.BOTTOM
  }
  return DockLocation.RIGHT
}

function agentTabNode(
  agentId: string,
  name: string,
  config?: Record<string, unknown>,
  options?: { flash?: boolean }
) {
  const flash = options?.flash ?? true
  return {
    type: 'tab',
    name,
    component: 'agent',
    ...(flash
      ? {
          className: AGENT_TAB_SPAWN_FLASH_CLASS,
          contentClassName: 'agent-tab-spawn-flash-panel',
        }
      : {}),
    config: { agentId, ...(config ?? {}) },
  }
}

function clearAgentSpawnFlash(model: Model, agentId: string): void {
  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) targetTabId = node.getId()
  })

  if (!targetTabId) return
  const node = model.getNodeById(targetTabId)
  if (!(node instanceof TabNode)) return

  const nextClassName = (node.getClassName() ?? '')
    .split(/\s+/u)
    .filter((className) => className && className !== AGENT_TAB_SPAWN_FLASH_CLASS)
    .join(' ')
  const nextContentClassName = (node.getContentClassName() ?? '')
    .split(/\s+/u)
    .filter((className) => className && className !== 'agent-tab-spawn-flash-panel')
    .join(' ')

  model.doAction(
    Actions.updateNodeAttributes(targetTabId, {
      className: nextClassName || undefined,
      contentClassName: nextContentClassName || undefined,
    })
  )
}

export function addAgentTabTiled(
  workspaceId: string,
  agentId: string,
  name: string,
  config?: Record<string, unknown>
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  // Sprint Engine layouts: agent terminals share a right-hand "terminals"
  // tabset with plain terminals so the SE board keeps its real estate. Stack
  // into an existing terminal-like tabset when one exists; otherwise dock a
  // fresh tabset on the right edge of the root.
  if (modelHasSprintEngineBoard(model)) {
    const terminalHost = firstTerminalLikeTabset(model)
    if (terminalHost) {
      model.doAction(
        Actions.addNode(
          agentTabNode(agentId, name, config),
          terminalHost.getId(),
          DockLocation.CENTER,
          -1,
          true
        )
      )
      window.setTimeout(() => clearAgentSpawnFlash(model, agentId), 13200)
      return true
    }
    model.doAction(
      Actions.addNode(
        agentTabNode(agentId, name, config),
        model.getRoot().getId(),
        DockLocation.RIGHT,
        -1,
        true
      )
    )
    window.setTimeout(() => clearAgentSpawnFlash(model, agentId), 13200)
    return true
  }

  const targetTabset = model.getActiveTabset() ?? firstTabset(model)
  if (!targetTabset) return false

  model.doAction(
    Actions.addNode(
      agentTabNode(agentId, name, config),
      targetTabset.getId(),
      agentTileLocation(targetTabset),
      -1,
      true
    )
  )
  window.setTimeout(() => clearAgentSpawnFlash(model, agentId), 13200)
  return true
}

export function focusOrAddAgentTab(
  workspaceId: string,
  agentId: string,
  name: string,
  config?: Record<string, unknown>,
): boolean {
  return applyAgentTerminalRevealPolicy(workspaceId, agentId, name, 'reveal', config)
}

export function applyAgentTerminalRevealPolicy(
  workspaceId: string,
  agentId: string,
  name: string,
  revealPolicy: AgentTerminalRevealPolicy,
  config?: Record<string, unknown>,
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  if (revealPolicy === 'reveal' && focusAgentTab(workspaceId, agentId)) {
    renameAgentTab(model, agentId, name)
    updateAgentTabConfig(model, agentId, config)
    return true
  }

  let existingTabId: string | null = null
  model.visitNodes((node) => {
    if (existingTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const existingConfig = (node.getConfig() as Record<string, unknown> | undefined) ?? {}
    if (existingConfig.agentId === agentId) existingTabId = node.getId()
  })

  if (existingTabId) {
    if (revealPolicy === 'focus-if-open') model.doAction(Actions.selectTab(existingTabId))
    renameAgentTab(model, agentId, name)
    updateAgentTabConfig(model, agentId, config)
    return true
  }

  if (revealPolicy !== 'reveal') return false

  return addAgentTabTiled(workspaceId, agentId, name, config)
}

export async function focusOrAddAgentSessionTab(
  workspaceId: string,
  args: { executionId: string; fallbackName: string },
): Promise<boolean> {
  const sessions = await window.api.terminalList().catch(() => [])
  const session = sessions.find((candidate) =>
    candidate.kind === 'agent'
    && candidate.workspaceId === workspaceId
    && candidate.agentSession?.executionId === args.executionId
  )
  if (!session) return false

  const agentId = session.agentId ?? session.agentSession?.executionId ?? args.executionId
  const name = session.agentSession?.displayName ?? args.fallbackName
  return focusOrAddAgentTab(workspaceId, agentId, name, { sessionId: session.sessionId })
}

function collectAgentTabIds(model: Model, agentId: string): string[] {
  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) tabIds.push(node.getId())
  })
  return tabIds
}

export function removeAgentTab(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const tabIds = collectAgentTabIds(model, agentId)
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return tabIds.length > 0
}

export function removeAgentTabFromLayoutModel(
  layoutModel: IJsonModel,
  agentId: string
): { layoutModel: IJsonModel; removed: boolean } {
  const model = Model.fromJson(layoutModel)
  const tabIds = collectAgentTabIds(model, agentId)
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return { layoutModel: model.toJson(), removed: tabIds.length > 0 }
}

export function ensureAgentTabInLayoutModel(
  layoutModel: IJsonModel,
  agentId: string,
  name: string
): IJsonModel {
  const model = Model.fromJson(layoutModel)

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) {
    const node = model.getNodeById(targetTabId)
    if (node instanceof TabNode && node.getName() !== name) {
      model.doAction(Actions.renameTab(targetTabId, name))
    }
    model.doAction(Actions.selectTab(targetTabId))
    return model.toJson()
  }

  const targetTabset = model.getActiveTabset() ?? firstTabset(model)
  if (!targetTabset) return model.toJson()

  model.doAction(
    Actions.addNode(
      agentTabNode(agentId, name, undefined, { flash: false }),
      targetTabset.getId(),
      agentTileLocation(targetTabset),
      -1,
      true
    )
  )

  return model.toJson()
}

function firstTerminalTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'terminal') return
    const parent = node.getParent()
    if (parent instanceof TabSetNode) found = parent
  })
  return found
}

// Returns the first tabset hosting an agent or terminal tab that does NOT also
// host the Sprint Engine board. Lets agent terminals and plain terminals share
// a right-hand "terminals" panel in SE layouts without ever stacking into the
// board's tabset.
function firstTerminalLikeTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabNode)) return
    const component = node.getComponent()
    if (component !== 'agent' && component !== 'terminal') return
    const parent = node.getParent()
    if (!(parent instanceof TabSetNode)) return
    const hostsBoard = parent.getChildren().some(
      (child) => child instanceof TabNode && child.getComponent() === 'sprintengine'
    )
    if (hostsBoard) return
    found = parent
  })
  return found
}

function firstEditorSurfaceTabset(model: Model): TabSetNode | null {
  const activeTabset = model.getActiveTabset()
  if (activeTabset) {
    const hasEditorSurface = activeTabset.getChildren().some((child) =>
      child instanceof TabNode
      && (child.getComponent() === 'file-editor' || child.getComponent() === 'editor')
    )
    if (hasEditorSurface) return activeTabset
  }

  let targetTabset: TabSetNode | null = null
  model.visitNodes((node) => {
    if (targetTabset || !(node instanceof TabSetNode)) return
    const hasEditorSurface = node.getChildren().some((child) =>
      child instanceof TabNode
      && (child.getComponent() === 'file-editor' || child.getComponent() === 'editor')
    )
    if (hasEditorSurface) targetTabset = node
  })
  return targetTabset
}

function addEditorSurfaceNode(
  model: Model,
  tabJson: Record<string, unknown>
): boolean {
  const editorTabset = firstEditorSurfaceTabset(model)
  if (editorTabset) {
    model.doAction(Actions.addNode(tabJson, editorTabset.getId(), DockLocation.CENTER, -1, true))
    return true
  }

  const navTabset = findNavRailTabset(model)
  if (navTabset) {
    model.doAction(Actions.addNode(tabJson, navTabset.getId(), DockLocation.RIGHT, -1, true))
    return true
  }

  const terminalHost = firstTerminalLikeTabset(model)
  if (terminalHost) {
    model.doAction(Actions.addNode(tabJson, terminalHost.getId(), DockLocation.LEFT, -1, true))
    return true
  }

  const target = model.getActiveTabset() ?? firstTabset(model)
  if (!target) return false
  model.doAction(Actions.addNode(tabJson, target.getId(), DockLocation.CENTER, -1, true))
  return true
}

function modelHasSprintEngineBoard(model: Model): boolean {
  let found = false
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabNode && node.getComponent() === 'sprintengine') found = true
  })
  return found
}

function terminalTabJson(terminalId: string, name: string) {
  return { type: 'tab', name, component: 'terminal', config: { terminalId } }
}

// Places a new terminal tab in the layout. Stacks into an existing terminal
// tabset when one exists so multiple terminals share a tab strip. In Sprint
// Engine layouts the right-hand "terminals" tabset is shared with agent
// terminals — plain terminals stack into it (or dock a fresh tabset on the
// right edge of the root) so the board stays visible; outside SE mode the
// active tabset is used.
export function addTerminalTab(
  workspaceId: string,
  terminalId: string,
  name = 'Terminal'
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const tabJson = terminalTabJson(terminalId, name)

  if (modelHasSprintEngineBoard(model)) {
    const terminalHost = firstTerminalLikeTabset(model)
    if (terminalHost) {
      model.doAction(
        Actions.addNode(tabJson, terminalHost.getId(), DockLocation.CENTER, -1, true)
      )
      return true
    }
    model.doAction(
      Actions.addNode(tabJson, model.getRoot().getId(), DockLocation.RIGHT, -1, true)
    )
    return true
  }

  const existingTerminalTabset = firstTerminalTabset(model)
  if (existingTerminalTabset) {
    model.doAction(
      Actions.addNode(tabJson, existingTerminalTabset.getId(), DockLocation.CENTER, -1, true)
    )
    return true
  }

  const targetTabset = model.getActiveTabset() ?? firstTabset(model)
  if (!targetTabset) return false

  model.doAction(
    Actions.addNode(tabJson, targetTabset.getId(), DockLocation.CENTER, -1, true)
  )
  return true
}

export function focusOrAddTerminalTab(
  workspaceId: string,
  terminalId: string,
  name = 'Terminal'
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'terminal') return

    const config = node.getConfig() as { terminalId?: string } | undefined
    if ((config?.terminalId ?? node.getId()) === terminalId) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) {
    model.doAction(Actions.selectTab(targetTabId))
    return true
  }

  return addTerminalTab(workspaceId, terminalId, name)
}

function fileTabId(filePath: string): string {
  return `file-editor:${encodeURIComponent(filePath)}`
}

function getFileTabPath(node: TabNode): string | null {
  if (node.getComponent() !== 'file-editor') return null
  const config = node.getConfig() as { filePath?: string } | undefined
  return typeof config?.filePath === 'string' ? config.filePath : null
}

function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = pathSeparatorFor(parentPath)
  return path.startsWith(`${parentPath}${separator}`)
}

function remapPath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  const separator = pathSeparatorFor(fromPath)
  const prefix = `${fromPath}${separator}`
  return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : path
}

export function focusFileTab(workspaceId: string, filePath: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode)) return
    if (getFileTabPath(node) === filePath) targetTabId = node.getId()
  })

  if (!targetTabId) return false
  model.doAction(Actions.selectTab(targetTabId))
  return true
}

export function remapFileTabsForPath(workspaceId: string, fromPath: string, toPath: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const updates: Array<{ tabId: string; name: string; config: Record<string, unknown> }> = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return
    const filePath = getFileTabPath(node)
    if (!filePath || !isPathOrChild(filePath, fromPath)) return

    const nextPath = remapPath(filePath, fromPath, toPath)
    updates.push({
      tabId: node.getId(),
      name: basename(nextPath),
      config: {
        ...((node.getConfig() as Record<string, unknown> | undefined) ?? {}),
        filePath: nextPath,
      },
    })
  })

  updates.forEach((update) => {
    model.doAction(Actions.updateNodeAttributes(update.tabId, { config: update.config }))
    model.doAction(Actions.renameTab(update.tabId, update.name))
  })

  return updates.length > 0
}

export function removeFileTabsForPath(workspaceId: string, path: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return
    const filePath = getFileTabPath(node)
    if (filePath && isPathOrChild(filePath, path)) tabIds.push(node.getId())
  })

  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return tabIds.length > 0
}

export function focusOrAddFileTab(
  workspaceId: string,
  filePath: string,
  name: string
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode)) return
    if (getFileTabPath(node) === filePath) targetTabId = node.getId()
  })

  if (targetTabId) {
    const node = model.getNodeById(targetTabId)
    if (node instanceof TabNode && node.getName() !== name) {
      model.doAction(Actions.renameTab(targetTabId, name))
    }
    model.doAction(Actions.selectTab(targetTabId))
    return true
  }

  return addEditorSurfaceNode(model, {
    type: 'tab',
    id: fileTabId(filePath),
    name,
    component: 'file-editor',
    enableClose: true,
    config: { filePath },
  })
}

function gitConflictTabId(repoRoot: string, filePath: string): string {
  return `git-conflict:${encodeURIComponent(repoRoot)}:${encodeURIComponent(filePath)}`
}

export function focusOrAddGitConflictTab(
  workspaceId: string,
  repoRoot: string,
  filePath: string,
  name: string
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'git-conflict') return

    const config = node.getConfig() as { repoRoot?: string; filePath?: string } | undefined
    if (config?.repoRoot === repoRoot && config.filePath === filePath) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) {
    model.doAction(Actions.selectTab(targetTabId))
    return true
  }

  let targetTabset: TabSetNode | null = model.getActiveTabset() ?? null
  if (!targetTabset) {
    model.visitNodes((node) => {
      if (!targetTabset && node instanceof TabSetNode) targetTabset = node
    })
  }
  if (!targetTabset) return false

  model.doAction(
    Actions.addNode(
      {
        type: 'tab',
        id: gitConflictTabId(repoRoot, filePath),
        name,
        component: 'git-conflict',
        config: { repoRoot, filePath },
      },
      targetTabset.getId(),
      DockLocation.CENTER,
      -1,
      true
    )
  )
  return true
}

export function focusComponentTab(workspaceId: string, component: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId) return
    if (node instanceof TabNode && node.getComponent() === component) {
      targetTabId = node.getId()
    }
  })

  if (!targetTabId) return false
  model.doAction(Actions.selectTab(targetTabId))
  return true
}

export function hasComponentTab(workspaceId: string, component: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  let found = false
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabNode && node.getComponent() === component) {
      found = true
    }
  })
  return found
}

type JsonLayoutNode = {
  type?: string
  component?: string
  children?: JsonLayoutNode[]
}

// Walks a serialized IJsonModel and reports whether a tab with `component` is
// present. Used by chrome that needs to derive panel-presence reactively from
// the persisted workspace.layoutModel — the live Model has no listener API.
export function jsonModelHasComponent(model: IJsonModel | undefined | null, component: string): boolean {
  if (!model) return false
  const visit = (node: JsonLayoutNode | undefined): boolean => {
    if (!node) return false
    if (node.type === 'tab' && node.component === component) return true
    const children = node.children
    if (!children) return false
    for (const child of children) {
      if (visit(child)) return true
    }
    return false
  }
  const layout = (model as unknown as { layout?: JsonLayoutNode }).layout
  return visit(layout)
}

export function removeComponentTab(workspaceId: string, component: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (node instanceof TabNode && node.getComponent() === component) {
      tabIds.push(node.getId())
    }
  })
  if (tabIds.length === 0) return false
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return true
}

export function toggleComponentTab(
  workspaceId: string,
  component: string,
  name: string
): boolean {
  if (hasComponentTab(workspaceId, component)) {
    return removeComponentTab(workspaceId, component)
  }
  return focusOrAddComponentTab(workspaceId, component, name)
}

// Strip-less navigational rail components. Files / Git / Backlog are
// single-instance navigational surfaces, so they share ONE left-docked pane
// whose FlexLayout tab strip is hidden and the PanelRail buttons act as
// exclusive switches into it — exactly one shows at a time. Knowledge Graph
// keeps the same nav-pane semantics but is reached through the command
// palette / View menu rather than a rail glyph. Sprint Engines is NOT here:
// it surveys every workspace, so it lives in the app-level right aside
// (SprintEnginesAside), outside any per-workspace layout model. The Editor is
// deliberately excluded: it owns a document tab strip so multiple open files
// stay switchable (see toggleEditorRailComponent).
export const NAV_RAIL_COMPONENTS = new Set<string>([
  'explorer',
  'git',
  'backlog',
  'memory-graph',
])

// PanelRail click handler (also the command-palette/menu toggle route). Nav
// switches route to the exclusive strip-less left pane; the Editor keeps
// standard document-tab semantics so its open files stay switchable.
export function togglePanelRailComponent(
  workspaceId: string,
  component: string,
  name: string
): boolean {
  if (NAV_RAIL_COMPONENTS.has(component)) {
    return toggleNavRailComponent(workspaceId, component, name)
  }
  return toggleEditorRailComponent(workspaceId, component, name)
}

// The single left-docked pane that hosts the nav switches. Matches only a
// tabset whose every tab is a nav component, so a legacy layout that stacked a
// nav tab beside the editor never gets its strip hidden (which would hide the
// editor's file tabs); those legacy tabs are pulled into a clean pane on the
// next toggle instead.
function findNavRailTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found || !(node instanceof TabSetNode)) return
    const tabs = node.getChildren().filter((child): child is TabNode => child instanceof TabNode)
    if (tabs.length === 0) return
    const allNav = tabs.every((tab) => {
      const component = tab.getComponent()
      return Boolean(component && NAV_RAIL_COMPONENTS.has(component))
    })
    if (allNav) found = node
  })
  return found
}

// Drops every nav tab except the one just selected, anywhere in the model, so
// the rail stays single-select even when an older layout left a stray nav tab
// in another tabset.
function removeNavRailTabsExcept(model: Model, keepComponent: string): void {
  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return
    const component = node.getComponent()
    if (component && NAV_RAIL_COMPONENTS.has(component) && component !== keepComponent) {
      tabIds.push(node.getId())
    }
  })
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
}

// Reveals a nav switch in the exclusive strip-less left pane: focuses it when
// it's already open, swaps it in when another switch is showing, or docks a
// fresh LEFT column when none is. The non-toggling entry point shared by the
// command palette and menu reveals.
export function revealNavRailComponent(
  workspaceId: string,
  component: string,
  name: string
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  // Already open — just make sure it's the visible switch.
  if (focusComponentTab(workspaceId, component)) return true

  // Stack into the existing nav pane when one is open, else dock a fresh column
  // on the LEFT of the root so terminals/agents stay on the right.
  const navTabset = findNavRailTabset(model)
  const targetId = navTabset ? navTabset.getId() : model.getRoot().getId()
  const location = navTabset ? DockLocation.CENTER : DockLocation.LEFT
  model.doAction(Actions.addNode({ type: 'tab', name, component }, targetId, location, -1, true))

  // Enforce single-select, then hide the strip on whichever tabset now holds
  // the lone nav switch.
  removeNavRailTabsExcept(model, component)
  const pane = findNavRailTabset(model)
  if (pane) {
    model.doAction(Actions.updateNodeAttributes(pane.getId(), { enableTabStrip: false }))
  }
  return true
}

// Exclusive toggle into the strip-less left nav pane. Clicking the open switch
// closes it (the pane collapses when it empties); clicking another swaps it in.
export function toggleNavRailComponent(
  workspaceId: string,
  component: string,
  name: string
): boolean {
  if (hasComponentTab(workspaceId, component)) {
    return removeComponentTab(workspaceId, component)
  }
  return revealNavRailComponent(workspaceId, component, name)
}

// The Editor keeps its document tab strip. Toggling removes the standalone
// 'editor' welcome tab (open files — the 'file-editor' tabs — are closed from
// their own strip); when no welcome tab is open it reveals the editor surface
// without stacking a second one: it focuses an existing open file, else docks a
// fresh welcome editor center-stage, to the RIGHT of the nav pane.
function toggleEditorRailComponent(
  workspaceId: string,
  component: string,
  name: string
): boolean {
  if (hasComponentTab(workspaceId, component)) {
    return removeComponentTab(workspaceId, component)
  }

  // Files already open — reveal that surface rather than adding a 2nd welcome
  // tab the user would then have to close.
  if (focusComponentTab(workspaceId, 'file-editor')) return true

  const model = models.get(workspaceId)
  if (!model) return false

  // No editor surface at all. Sit the document area between the nav pane (left)
  // and terminals/agents (right) instead of stacking into the currently active
  // terminal tabset.
  return addEditorSurfaceNode(model, { type: 'tab', name, component })
}

export function focusOrAddComponentTab(
  workspaceId: string,
  component: string,
  name: string
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  if (focusComponentTab(workspaceId, component)) return true

  let targetTabset: TabSetNode | null = model.getActiveTabset() ?? null
  if (!targetTabset) {
    model.visitNodes((node) => {
      if (!targetTabset && node instanceof TabSetNode) {
        targetTabset = node
      }
    })
  }
  if (!targetTabset) return false

  model.doAction(
    Actions.addNode(
      { type: 'tab', name, component },
      targetTabset.getId(),
      DockLocation.CENTER,
      -1,
      true
    )
  )
  return true
}

export type CrossWorkspaceTabSpec = {
  component: string
  name: string
  config: Record<string, unknown> | null
  className: string | null
}

export function extractTabSpec(
  workspaceId: string,
  tabId: string
): CrossWorkspaceTabSpec | null {
  const model = models.get(workspaceId)
  if (!model) return null
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode)) return null

  const rawConfig = node.getConfig()
  return {
    component: node.getComponent() ?? '',
    name: node.getName(),
    config:
      rawConfig && typeof rawConfig === 'object'
        ? (rawConfig as Record<string, unknown>)
        : null,
    className: node.getClassName() ?? null,
  }
}

export function removeTab(
  workspaceId: string,
  tabId: string,
  options?: { preserveRuntime?: boolean }
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode)) return false
  const action = Actions.deleteTab(tabId)
  if (options?.preserveRuntime) {
    const actionData = action.data as Record<string, unknown>
    actionData.__multicodePreserveRuntime = true
  }
  model.doAction(action)
  return true
}

function buildTabJson(spec: CrossWorkspaceTabSpec): Record<string, unknown> {
  const tabJson: Record<string, unknown> = {
    type: 'tab',
    name: spec.name,
    component: spec.component,
  }
  if (spec.config) tabJson.config = spec.config
  if (spec.className) tabJson.className = spec.className
  return tabJson
}

// Adds a tab as a new tabset docked on the right edge of the workspace's root,
// producing a side-by-side tile. Used for cross-workspace tab moves where the
// caller has chosen "tile, don't stack" semantics.
export function addTabAsNewColumn(
  workspaceId: string,
  spec: CrossWorkspaceTabSpec
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  model.doAction(
    Actions.addNode(
      buildTabJson(spec) as Parameters<typeof Actions.addNode>[0],
      model.getRoot().getId(),
      DockLocation.RIGHT,
      -1,
      true
    )
  )
  return true
}

// Mutates a persisted IJsonModel to append a new tabset (containing the given
// tab) as a sibling of the existing root layout, producing a side-by-side
// tile. Used when the destination workspace's live flexlayout Model is not
// mounted (so we cannot dispatch addNode); the next mount will pick up the
// new tab from this JSON.
export function appendTabAsNewColumnInJson(
  layoutModel: IJsonModel,
  spec: CrossWorkspaceTabSpec
): IJsonModel {
  const tabJson = buildTabJson(spec)
  const root = layoutModel.layout
  const newTabset = { type: 'tabset', weight: 50, children: [tabJson] }

  if (root && root.type === 'row') {
    const existingChildren = Array.isArray(root.children) ? root.children : []
    return {
      ...layoutModel,
      layout: {
        ...root,
        children: [...existingChildren, newTabset],
      } as IJsonModel['layout'],
    }
  }

  return {
    ...layoutModel,
    layout: {
      type: 'row',
      children: [root, newTabset],
    } as IJsonModel['layout'],
  }
}

export function buildSingleTabLayoutModel(spec: CrossWorkspaceTabSpec): IJsonModel {
  return {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [buildTabJson(spec)],
        },
      ],
    } as IJsonModel['layout'],
  }
}
