import type { OverflowMenuItem } from '../ui'
import type { BacklogItemActionCategory } from '../../modules/renderer-host'

// Module-contributed Backlog actions belong in menus, never as detail-header
// buttons (owner ruling 2026-09-15). `order` then label is the sequence; a
// category is only a group heading when more than one category is present.

export const BACKLOG_ITEM_ACTION_CATEGORY_ORDER: readonly BacklogItemActionCategory[] = [
  'execute',
  'analyze',
  'transform',
  'publish',
  'review',
  'organize',
]

export type BacklogModuleActionEntry = {
  id: string
  label: string
  category: BacklogItemActionCategory
  order?: number
  disabled: boolean
  run: () => void
}

export type BacklogModuleActionMenuGroup = {
  heading: string | null
  actions: BacklogModuleActionEntry[]
}

export function backlogItemActionCategoryLabel(category: BacklogItemActionCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1)
}

function sortByOrderThenLabel(actions: readonly BacklogModuleActionEntry[]): BacklogModuleActionEntry[] {
  return [...actions].sort((a, b) => {
    const order = (a.order ?? 100) - (b.order ?? 100)
    return order === 0 ? a.label.localeCompare(b.label) : order
  })
}

export function groupBacklogModuleActions(
  actions: ReadonlyArray<BacklogModuleActionEntry>,
): BacklogModuleActionMenuGroup[] {
  if (actions.length === 0) return []
  const categories = new Set(actions.map((action) => action.category))
  const sorted = sortByOrderThenLabel(actions)
  if (categories.size <= 1) {
    return [{ heading: null, actions: sorted }]
  }
  return BACKLOG_ITEM_ACTION_CATEGORY_ORDER.flatMap((category) => {
    const members = sorted.filter((action) => action.category === category)
    if (members.length === 0) return []
    return [{ heading: backlogItemActionCategoryLabel(category), actions: members }]
  })
}

export function overflowItemsForBacklogModuleActions(
  actions: ReadonlyArray<BacklogModuleActionEntry>,
): OverflowMenuItem[] {
  const groups = groupBacklogModuleActions(actions)
  const items: OverflowMenuItem[] = []
  for (const group of groups) {
    if (group.heading) {
      items.push({
        kind: 'heading',
        id: `module-group-${group.heading.toLowerCase()}`,
        label: group.heading,
      })
    }
    for (const action of group.actions) {
      items.push({
        id: action.id,
        label: action.label,
        disabled: action.disabled,
        onSelect: action.run,
      })
    }
  }
  if (items.length > 0) {
    items.push({ kind: 'separator', id: 'sep-module-actions' })
  }
  return items
}
