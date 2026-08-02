// Pure selection/source model for the New sprint dialog (MC-2062). The dialog
// keys its picks the way the prototype does — `epic:<slug>` for an epic header,
// the item's relativePath for a leaf — and everything that turns picks into a
// launchable FuturePlanWorkspaceSource lives here so the component stays paint.
//
// One creation seam, no new mechanism: a multi/mixed pick routes through
// buildBacklogSelectionSourcePlan (MC-2060), a single-epic pick through the same
// builder's byte-identical epic branch, and a single plain item mirrors the
// backlog row's own "Run a Sprint" source shape (sprint-engine-module.ts).

import { basename } from '../../../utils/paths'
import { epicSlug } from '../../../utils/backlogEpics'
import { markdownTitle } from '../newWorkspace/helpers'
import { slugifySprintEngineName } from '../../../utils/sprintengineStateFile'
import { buildBacklogSelectionSourcePlan } from '../../backlog/backlogSelectionSourcePlan'
import type { BacklogItem } from '../../../utils/backlog'
import type { FuturePlanWorkspaceSource } from '../../../types/workspace'

export const EPIC_KEY_PREFIX = 'epic:'

export function epicPickKey(slug: string): string {
  return `${EPIC_KEY_PREFIX}${slug}`
}

export function isEpicPickKey(key: string): boolean {
  return key.startsWith(EPIC_KEY_PREFIX)
}

export function pickKeyForItem(item: BacklogItem): string {
  return item.isEpic ? epicPickKey(epicSlug(item)) : item.relativePath
}

/** The picked items in launch order: epics lead (the bigger noun names the
 *  run), each cohort in pick order. Keys with no scanned item are dropped. */
export function orderedPickedItems(
  pickedKeys: ReadonlyArray<string>,
  items: ReadonlyArray<BacklogItem>,
): BacklogItem[] {
  const bySlug = new Map<string, BacklogItem>()
  const byPath = new Map<string, BacklogItem>()
  for (const item of items) {
    if (item.isEpic) bySlug.set(epicSlug(item), item)
    else byPath.set(item.relativePath, item)
  }
  const epics: BacklogItem[] = []
  const leaves: BacklogItem[] = []
  for (const key of pickedKeys) {
    if (isEpicPickKey(key)) {
      const epic = bySlug.get(key.slice(EPIC_KEY_PREFIX.length))
      if (epic) epics.push(epic)
    } else {
      const leaf = byPath.get(key)
      if (leaf) leaves.push(leaf)
    }
  }
  return [...epics, ...leaves]
}

function sourcePlanKindForBacklogItem(kind: string): 'product_plan' | 'architect_plan' | 'unknown' {
  return kind === 'product_plan' || kind === 'architect_plan' ? kind : 'unknown'
}

/** One selection — plain items, epics, a mix — becomes ONE source. A single
 *  plain item keeps the backlog row's own single-item shape (the builder
 *  deliberately returns null for it); anything else rides the MC-2060 builder. */
export function buildNewSprintSource(input: {
  workspaceRoot: string
  pickedKeys: ReadonlyArray<string>
  items: ReadonlyArray<BacklogItem>
}): FuturePlanWorkspaceSource | null {
  const selected = orderedPickedItems(input.pickedKeys, input.items)
  if (selected.length === 0) return null
  const plan = buildBacklogSelectionSourcePlan({
    workspaceRoot: input.workspaceRoot,
    items: selected,
    projectItems: input.items,
  })
  if (plan) return plan
  const only = selected[0]
  return {
    folderPath: input.workspaceRoot,
    sourcePath: only.path,
    sourceRelativePath: only.relativePath,
    sourceContent: only.sourceContent,
    sourcePlanKind: sourcePlanKindForBacklogItem(only.kind),
    teamName: slugifySprintEngineName(
      basename(only.relativePath).replace(/\.(md|html?)$/i, ''),
    ),
    goal: markdownTitle(only.sourceContent) ?? only.title,
  }
}

/** Reconstruct the pick set a preloaded source represents (the backlog context
 *  action and every other `initialFuturePlan` producer arrive with the
 *  selection already made). Keys are path-derived, so they resolve before the
 *  dialog's own scan lands. A file/plan source that is not a backlog selection
 *  yields no picks — it rides as the dialog's file source instead. */
export function seedPickedKeysFromSource(
  source: FuturePlanWorkspaceSource,
): string[] {
  const slugOf = (relativePath: string): string =>
    basename(relativePath).replace(/\.(md|html?)$/i, '')
  if (source.sourcePlanKind === 'epic') {
    return [epicPickKey(slugOf(source.sourceRelativePath))]
  }
  if (source.sourcePlanKind === 'selection') {
    const keys: string[] = []
    for (const entry of source.sourceBundle ?? []) {
      if (entry.kind === 'epic') keys.push(epicPickKey(slugOf(entry.sourceRelativePath)))
      else if (entry.selectedItem) keys.push(entry.sourceRelativePath)
    }
    return keys
  }
  return []
}

/** True when the preloaded source is a hand-picked file rather than a backlog
 *  selection — it cannot be represented as picks, so it stays a source chip. */
export function isFileSource(source: FuturePlanWorkspaceSource): boolean {
  return seedPickedKeysFromSource(source).length === 0
}

/** The derived run name IS the right pane's heading; the pencil rename is the
 *  rare override. */
export function deriveRunName(
  source: FuturePlanWorkspaceSource | null,
  override: string | null,
): string | null {
  const trimmed = override?.trim()
  if (trimmed) return slugifySprintEngineName(trimmed)
  return source?.teamName ?? null
}
