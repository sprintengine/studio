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
