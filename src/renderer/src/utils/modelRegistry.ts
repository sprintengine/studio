import { Actions, DockLocation, Model, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { basename, pathSeparatorFor } from './paths'

const AGENT_TAB_SPAWN_FLASH_CLASS = 'agent-tab-spawn-flash'

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
  const model = models.get(workspaceId)
  if (!model) return false
  if (focusAgentTab(workspaceId, agentId)) {
    renameAgentTab(model, agentId, name)
    updateAgentTabConfig(model, agentId, config)
    return true
  }

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

  let targetTabset: TabSetNode | null = model.getActiveTabset() ?? null
  if (!targetTabset) {
    model.visitNodes((node) => {
      if (!targetTabset && node instanceof TabSetNode) targetTabset = node
    })
  }
  if (!targetTabset) return false

  model.doAction(
    Actions.addNode(
      { type: 'tab', name, component: 'terminal', config: { terminalId } },
      targetTabset.getId(),
      DockLocation.CENTER,
      -1,
      true
    )
  )
  return true
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

  let targetTabset: TabSetNode | null = null
  let explorerParent: TabSetNode | null = null
  let firstTabset: TabSetNode | null = null

  const activeTabset = model.getActiveTabset()
  if (activeTabset) {
    const hasEditorSurface = activeTabset.getChildren().some((child) =>
      child instanceof TabNode
      && (child.getComponent() === 'file-editor' || child.getComponent() === 'editor')
    )
    if (hasEditorSurface) targetTabset = activeTabset
  }

  model.visitNodes((node) => {
    if (!firstTabset && node instanceof TabSetNode) firstTabset = node

    if (node instanceof TabNode && node.getComponent() === 'explorer') {
      const parent = node.getParent()
      if (!explorerParent && parent instanceof TabSetNode) explorerParent = parent
    }

    if (targetTabset || !(node instanceof TabSetNode)) return
    const hasEditorSurface = node.getChildren().some((child) =>
      child instanceof TabNode
      && (child.getComponent() === 'file-editor' || child.getComponent() === 'editor')
    )
    if (hasEditorSurface) targetTabset = node
  })

  const finalTarget = targetTabset ?? explorerParent ?? activeTabset ?? firstTabset
  if (!finalTarget) return false

  model.doAction(
    Actions.addNode(
      {
        type: 'tab',
        id: fileTabId(filePath),
        name,
        component: 'file-editor',
        config: { filePath },
      },
      finalTarget.getId(),
      targetTabset ? DockLocation.CENTER : DockLocation.RIGHT,
      -1,
      true
    )
  )
  return true
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

export function focusOrAddEditorBesideExplorer(workspaceId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  if (focusComponentTab(workspaceId, 'editor')) return true

  let explorerParent: TabSetNode | null = null
  model.visitNodes((node) => {
    if (explorerParent) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'explorer') return

    const parent = node.getParent()
    if (parent instanceof TabSetNode) {
      explorerParent = parent
    }
  })

  let targetTabset = explorerParent ?? model.getActiveTabset() ?? null
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
      { type: 'tab', name: 'Editor', component: 'editor' },
      targetTabset.getId(),
      explorerParent ? DockLocation.RIGHT : DockLocation.CENTER,
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

export function removeTab(workspaceId: string, tabId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode)) return false
  model.doAction(Actions.deleteTab(tabId))
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
