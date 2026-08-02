// Build the plan source a multi-selected backlog launch seeds creation with
// (MC-2060). One selection — plain items, epics, a mix — becomes ONE
// FuturePlanWorkspaceSource handed to the existing startSourcePlan →
// requestNewSprint seam; there is no new creation mechanism.
//
// The bundle is built exactly as the wizard's own backlog picker builds one
// epic's today (applyPlanSource / handleSelectBacklogItem): each selected epic
// contributes itself (an `epic`-kind entry — a membership scope the engine
// derives slugs from, never a work entry) plus its non-archived children marked
// `epicChild`; each plain item contributes itself marked `selectedItem`. The
// engine re-settles the markers from each file's own `epic:` frontmatter at
// init (`normalize_selection_bundle`), so they only need to be honest.
//
// Plan kinds follow the T3 engine contract: a selection of exactly one epic
// stays `epic` (the single-epic branch is fixture-pinned byte-identical); any
// larger or mixed selection is `selection`. A selection of exactly one plain
// item returns null — the caller keeps today's single-item flow, byte-identical.

import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { basename } from '../../utils/paths'
import { childrenOfEpic, epicSlug } from '../../utils/backlogEpics'
import { inferSourcePlanKind, markdownTitle } from '../workspace/newWorkspace/helpers'
import type { BacklogItem } from '../../utils/backlog'
import type {
  FuturePlanWorkspaceSource,
  SprintEngineSourceBundleItem,
} from '../../types/workspace'

export type BacklogSelectionSourcePlanInput = {
  /** The row's own project root — every selected item lives under it. */
  workspaceRoot: string
  /** The selected items in list order. The first entry is the anchor row. */
  items: ReadonlyArray<BacklogItem>
  /** The project's full scanned item set, for epic-membership expansion. */
  projectItems: ReadonlyArray<BacklogItem>
}

// The same leaf-kind mapping applyPlanSource gives an epic's children: a
// mockup file is a mockup, a recognizable plan is that plan, everything else
// is reading context (the work-ness rides the marker, not the kind).
function workEntryKind(item: BacklogItem): SprintEngineSourceBundleItem['kind'] {
  if (/\.html?$/i.test(item.relativePath)) return 'html_mockup'
  const inferred = inferSourcePlanKind(item.relativePath, item.sourceContent)
  return inferred === 'product_plan' || inferred === 'architect_plan' ? inferred : 'generic_context'
}

function teamNameFor(item: BacklogItem): string {
  return slugifySprintEngineName(basename(item.relativePath).replace(/\.(md|html?)$/i, ''))
}

function openChildrenOf(epic: BacklogItem, projectItems: ReadonlyArray<BacklogItem>): BacklogItem[] {
  return childrenOfEpic([...projectItems], epicSlug(epic)).filter(
    (child) => child.status !== 'archived',
  )
}

export function buildBacklogSelectionSourcePlan(
  input: BacklogSelectionSourcePlanInput,
): FuturePlanWorkspaceSource | null {
  // Dedupe by relative path: a row cannot be selected twice, but callers may
  // hand the anchor in addition to the set.
  const selected: BacklogItem[] = []
  const selectedPaths = new Set<string>()
  for (const item of input.items) {
    if (selectedPaths.has(item.relativePath)) continue
    selectedPaths.add(item.relativePath)
    selected.push(item)
  }
  if (selected.length === 0) return null

  // Exactly one epic → the single-epic launch, byte-for-byte the wizard shape.
  if (selected.length === 1) {
    const only = selected[0]
    if (!only.isEpic) return null
    const bundle = openChildrenOf(only, input.projectItems).map((child) => ({
      kind: workEntryKind(child),
      sourcePath: child.path,
      sourceRelativePath: child.relativePath,
      sourceContent: child.sourceContent,
      epicChild: true as const,
    }))
    return {
      folderPath: input.workspaceRoot,
      sourcePath: only.path,
      sourceRelativePath: only.relativePath,
      sourceContent: only.sourceContent,
      sourcePlanKind: 'epic',
      sourceBundle: bundle,
      teamName: teamNameFor(only),
      goal: markdownTitle(only.sourceContent) ?? only.title,
    }
  }

  // The mixed/multi selection. The anchor (first selected row) is the root
  // source — the run needs one primary document, and the row the user acted
  // from is the honest choice — and every selected work item rides the bundle,
  // anchor included, so the engine's enumerable work list IS the selection.
  const anchor = selected[0]
  const bundle: SprintEngineSourceBundleItem[] = []
  const workPaths = new Set<string>()
  for (const item of selected) {
    if (item.isEpic) {
      bundle.push({
        kind: 'epic',
        sourcePath: item.path,
        sourceRelativePath: item.relativePath,
        sourceContent: item.sourceContent,
      })
      for (const child of openChildrenOf(item, input.projectItems)) {
        if (workPaths.has(child.relativePath)) continue
        workPaths.add(child.relativePath)
        bundle.push({
          kind: workEntryKind(child),
          sourcePath: child.path,
          sourceRelativePath: child.relativePath,
          sourceContent: child.sourceContent,
          epicChild: true,
        })
      }
    } else {
      if (workPaths.has(item.relativePath)) continue
      workPaths.add(item.relativePath)
      bundle.push({
        kind: workEntryKind(item),
        sourcePath: item.path,
        sourceRelativePath: item.relativePath,
        sourceContent: item.sourceContent,
        selectedItem: true,
      })
    }
  }

  return {
    folderPath: input.workspaceRoot,
    sourcePath: anchor.path,
    sourceRelativePath: anchor.relativePath,
    sourceContent: anchor.sourceContent,
    sourcePlanKind: 'selection',
    sourceBundle: bundle,
    teamName: teamNameFor(anchor),
    goal: `Deliver ${selected.length} selected backlog items`,
  }
}
