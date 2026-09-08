import type { Workspace } from '../../types/workspace'
import { LEARNING_ITEMS } from './items'
import type { LearningCategory, LearningContextRule, LearningItem } from './types'

export type LearningContext = {
  activeWorkspace: Workspace | null
  hasAnyTerminal: boolean
  hasKnowledgeRoot: boolean
}

export function evaluateContextRule(
  rule: LearningContextRule,
  context: LearningContext
): boolean {
  switch (rule.kind) {
    case 'workspace-mode':
      return context.activeWorkspace?.mode === rule.value
    case 'has-terminal':
      return context.hasAnyTerminal === (rule.value ?? true)
    case 'has-sprintengine-state':
      return Boolean(context.activeWorkspace?.sprintEngineState) === (rule.value ?? true)
    case 'has-knowledge-root':
      return context.hasKnowledgeRoot === (rule.value ?? true)
    default:
      return true
  }
}

export function isLearningItemEligible(item: LearningItem, context: LearningContext): boolean {
  if (!item.showWhen || item.showWhen.length === 0) return true
  return item.showWhen.every((rule) => evaluateContextRule(rule, context))
}

export function filterEligibleLearningItems(
  context: LearningContext,
  items: readonly LearningItem[] = LEARNING_ITEMS
): LearningItem[] {
  return items.filter((item) => isLearningItemEligible(item, context))
}

export type StartupTipSelection = {
  tip: LearningItem
  index: number
  rotation: LearningItem[]
}

export function pickStartupTip(
  context: LearningContext,
  seenTipIds: readonly string[],
  lastShownTipId: string | null,
  items: readonly LearningItem[] = LEARNING_ITEMS
): StartupTipSelection | null {
  const eligible = filterEligibleLearningItems(context, items)
  if (eligible.length === 0) return null

  const seen = new Set(seenTipIds)
  const unseen = eligible.filter((item) => !seen.has(item.id))
  const rotation = unseen.length > 0 ? unseen : eligible

  let index = 0
  if (lastShownTipId) {
    const previousIndex = rotation.findIndex((item) => item.id === lastShownTipId)
    if (previousIndex >= 0) index = (previousIndex + 1) % rotation.length
  }

  return { tip: rotation[index], index, rotation }
}

export type LearningSearchInput = {
  query?: string
  category?: LearningCategory | 'all'
  context: LearningContext
}

export function searchLearningItems(input: LearningSearchInput): LearningItem[] {
  const eligible = filterEligibleLearningItems(input.context)
  const byCategory =
    !input.category || input.category === 'all'
      ? eligible
      : eligible.filter((item) => item.category === input.category)

  const query = input.query?.trim().toLowerCase() ?? ''
  if (!query) return byCategory
  return byCategory.filter((item) =>
    item.title.toLowerCase().includes(query)
    || item.summary.toLowerCase().includes(query)
    || (item.body ? item.body.toLowerCase().includes(query) : false)
  )
}
