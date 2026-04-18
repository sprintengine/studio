import type { IJsonModel } from 'flexlayout-react'

type LayoutNode = {
  type?: string
  component?: string
  id?: string
  config?: { agentId?: string }
  children?: LayoutNode[]
}

// Walks a flexlayout IJsonModel and returns the agentId of every 'agent' tab.
export function extractAgentIds(model: IJsonModel): string[] {
  const ids: string[] = []
  const seen = new Set<string>()

  function walk(node: LayoutNode | undefined): void {
    if (!node) return
    if (node.component === 'agent') {
      const id = node.config?.agentId ?? node.id ?? `agent-${ids.length + 1}`
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    node.children?.forEach(walk)
  }

  walk(model.layout as LayoutNode | undefined)
  return ids
}
