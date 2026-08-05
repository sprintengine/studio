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

// ── the Planning agent row (MC-2129) ────────────────────────────────────────
//
// One row on the team card, whose VALUE is the whole control: "None", or the
// runtime that will plan. Ruled 2026-08-04 after mockup review — no switch, no
// mode names, no sub-copy under the row, no "planner" badge. The explanation
// lives in the label's tooltip and nowhere else.

export const PLANNING_AGENT_ROW_LABEL = 'Planning agent'

export const PLANNING_AGENT_TOOLTIP =
  'Plans the sprint before any work starts: reads the items, orders them, and creates the tasks. '
  + 'With None, your epic is the plan — one task per open item, in the order the epic already says.'

export const PLANNING_AGENT_NONE_LABEL = 'None'

export const PLANNING_AGENT_NONE_DESCRIPTION = 'Your epic is the plan'

// ── the "Runs in" row (MC-2123) ─────────────────────────────────────────────
//
// Worktree mode was reachable from the deleted wizard and from nowhere at all
// after it (the dialog was born with `useWorktrees: false` hardcoded). Ruled
// 2026-08-05 (owner): isolation is a VISIBLE choice, not invisible plumbing,
// and a sprint runs in ONE worktree per sprint by default.
//
// The ladder is none / per-sprint / per-task. This row carries the first two
// rungs; MC-2136 adds "A worktree per task" as a third item of the same list,
// which is why the value vocabulary is its ("One worktree"), and why the label
// is the sentence opener rather than the noun — every rung completes it.

export type SprintIsolation = 'none' | 'sprint'

export const DEFAULT_SPRINT_ISOLATION: SprintIsolation = 'sprint'

export const SPRINT_ISOLATION_ROW_LABEL = 'Runs in'

export const SPRINT_ISOLATION_TOOLTIP =
  'Where this sprint works. A worktree is a second checkout of the project on its own branch, so the '
  + 'run can be inspected, abandoned, or run alongside your own edits without touching them. In the '
  + 'project folder, the agents edit the files you have open.'

export const SPRINT_ISOLATION_ITEMS: ReadonlyArray<{ value: SprintIsolation; label: string }> = [
  { value: 'sprint', label: 'One worktree' },
  { value: 'none', label: 'The project folder' },
]

/** The engine's run-level flag: every rung but `none` needs run worktrees. */
export function sprintIsolationUsesWorktrees(isolation: SprintIsolation): boolean {
  return isolation !== 'none'
}

/**
 * The epic source row's import arithmetic. With no plan gate there is no later
 * stop where a miscount would surface, so this row is where the import is
 * verified — it states both halves, including the items that stay out.
 */
export function epicSourceTail(counts: { open: number; closed: number }): string {
  const open = `${counts.open} open item${counts.open === 1 ? '' : 's'} in`
  return counts.closed === 0 ? open : `${open}, ${counts.closed} stay out`
}

/**
 * The footer, which stays terse and states the consequence rather than the mode:
 * what you are about to get, in plain words.
 */
export function directSprintFootSummary(taskCount: number): string {
  return `${taskCount} task${taskCount === 1 ? '' : 's'} from your epic`
}

export function plannedSprintFootSummary(itemCount: number): string {
  return `${itemCount} item${itemCount === 1 ? '' : 's'} · planned first`
}

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
