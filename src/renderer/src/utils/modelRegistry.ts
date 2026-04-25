import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'

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

export function focusOrAddAgentTab(
  workspaceId: string,
  agentId: string,
  name: string
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  if (focusAgentTab(workspaceId, agentId)) {
    renameAgentTab(model, agentId, name)
    return true
  }

  let targetTabset: TabSetNode | null = null
  model.visitNodes((node) => {
    if (targetTabset || !(node instanceof TabSetNode)) return
    const hasAgentTab = node.getChildren().some((child) =>
      child instanceof TabNode && child.getComponent() === 'agent'
    )
    if (hasAgentTab) targetTabset = node
  })
  const targetId = targetTabset
    ? (targetTabset as TabSetNode).getId()
    : model.getRoot().getId()
  const targetLocation = targetTabset ? DockLocation.CENTER : DockLocation.RIGHT

  model.doAction(
    Actions.addNode(
      { type: 'tab', name, component: 'agent', config: { agentId } },
      targetId,
      targetLocation,
      -1,
      true
    )
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
