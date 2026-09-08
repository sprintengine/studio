

import {
  type BacklogItem,
  type BacklogItemStatus,
} from '../utils/backlog'
import {
  backlogDependencyState,
  deriveBacklogDependencies,
  epicBlockedRollupBySlug,
  type BacklogDependencyState,
  type BacklogEpicBlockedRollup,
} from '../utils/backlogDependencies'
import {
  epicMetaBySlug,
  epicProgressBySlug,
  epicSlug,
  type BacklogEpicMeta,
  type BacklogEpicProgress,
} from '../utils/backlogEpics'
import { nextBacklogItemStatusFromLinks } from '../utils/backlogLinks'
import { isAutomationsHostWorkspace } from '../utils/workspaceVisibility'
import { workspaceFolderKey } from '../store/slices/workspacesSlice'
import { type BacklogScanSnapshot } from './useSharedBacklogScan'
import type { Workspace } from '../types/workspace'

// Cross-project Backlog read model (T8): read-time aggregation of every open
// project's backlog into one list where each item knows its project — the
// substrate the Backlog door surface (T9) renders. Storage does NOT move: this
// wraps the SAME per-project shared scan (useSharedBacklogScan) that a single
// BacklogPanel uses, so a project with an open panel is scanned once, not twice
// (shared-scan dedupe), and no new poller is introduced. A distinct project
// root subscribes exactly one scan.
//
// Wrap, never widen (plan D6): each item stays the EXISTING BacklogItem; its
// project is carried in a sibling `{ project, item }` wrapper, so every
// single-project consumer of BacklogItem stays byte-identical. Epic rollup and
// dependency blocking are PROJECT-LOCAL — a slug never crosses projects — and are
// derived per feed with the same pure helpers the panel uses, so the aggregate
// matches the single-project panel exactly.

// The project a wrapped item belongs to. `key` is the Backlog display key
// (`MC`, `MA`, …) resolved from the project's own config, so aggregated rows read
// `MA-112` beside `MC-1758` without collision. `rootKey` is the normalized scan
// key the project's shared subscription is grouped under.
export type BacklogProjectRef = {
  key: string
  name: string
  root: string
  rootKey: string
}

// One backlog item tagged with its project. The item is untouched (the epic
// status derivation below still produces a new object for epics, exactly as the
// single-project panel does — that is read-time status derivation, not a widening
// of the type).
export type BacklogProjectItem = {
  project: BacklogProjectRef
  item: BacklogItem
}

// The project-local derivations the panel renders from, computed with the shared
// pure helpers so a feed's rollups and blocked/waiting state match the
// single-project panel byte-for-byte. Keyed exactly as the panel keys them:
// dependency marker by item id, blocked set by relativePath, epic maps by slug.
export type BacklogProjectDerived = {
  dependencyStateById: Map<string, BacklogDependencyState>
  blockedPaths: Set<string>
  epicProgressBySlug: Map<string, BacklogEpicProgress>
  epicMetaBySlug: Map<string, BacklogEpicMeta>
  epicBlockedBySlug: Map<string, BacklogEpicBlockedRollup>
}

// One project's aggregated backlog. A failed/slow scan degrades to `error` on
// this feed alone (the others still render) — no all-or-nothing.
export type BacklogProjectFeed = {
  projectKey: string
  projectName: string
  root: string
  rootKey: string
  items: BacklogProjectItem[]
  derived: BacklogProjectDerived
  // A scan is in flight for this project (initial load or refresh).
  loading: boolean
  // The scan failed with no items to show; the message is the first scan error.
  error?: string
}

// ---------------------------------------------------------------------------
// Pure derivations (shared with the single-project panel via the same helpers)
// ---------------------------------------------------------------------------

// Read-time epic status derivation: an epic reflects the highest-precedence
// status among its children, never its own stale frontmatter `status:` (MC-1617).
// This is the exact transform BacklogPanel's `items` memo runs, factored pure so
// the aggregate feed and the panel derive identical statuses. Leaf items pass
// through untouched; when there are no epics at all the input array is returned
// as-is (no allocation), matching the panel.
export function deriveBacklogEpicStatuses(items: ReadonlyArray<BacklogItem>): BacklogItem[] {
  if (!items.some((item) => item.isEpic)) return items as BacklogItem[]
  const childStatusesBySlug = new Map<string, BacklogItemStatus[]>()
  for (const item of items) {
    if (item.isEpic || !item.epic) continue
    const bucket = childStatusesBySlug.get(item.epic)
    if (bucket) bucket.push(item.status)
    else childStatusesBySlug.set(item.epic, [item.status])
  }
  return items.map((item) => {
    if (!item.isEpic) return item
    const derived = nextBacklogItemStatusFromLinks(
      item.status,
      item.links,
      childStatusesBySlug.get(epicSlug(item)) ?? [],
    )
    return derived === item.status ? item : { ...item, status: derived }
  })
}

// The project-local derivation set the panel renders from — epic rollup,
// blocked/waiting marker, epic meta/progress — over the FULL (epic-status-derived)
// item set, never a filtered view, so prerequisite resolution stays accurate
// regardless of any list lens. Composes the same pure helpers the panel composes
// (deriveBacklogDependencies -> epicBlockedRollupBySlug -> backlogDependencyState),
// so the aggregate output equals the single-project panel's for the same project.
export function deriveBacklogProjectDerived(items: ReadonlyArray<BacklogItem>): BacklogProjectDerived {
  const source = [...items]
  const graph = deriveBacklogDependencies(source)
  const epicBlockedBySlug = epicBlockedRollupBySlug(graph)
  const dependencyStateById = new Map<string, BacklogDependencyState>()
  const blockedPaths = new Set<string>()
  for (const node of graph.nodes) {
    const state = backlogDependencyState(
      node,
      node.item.isEpic ? epicBlockedBySlug.get(node.slug) : undefined,
    )
    if (!state) continue
    dependencyStateById.set(node.item.id, state)
    if (state === 'blocked') blockedPaths.add(node.item.relativePath)
  }
  return {
    dependencyStateById,
    blockedPaths,
    epicProgressBySlug: epicProgressBySlug(source),
    epicMetaBySlug: epicMetaBySlug(source),
    epicBlockedBySlug,
  }
}

// ---------------------------------------------------------------------------
// Project-root selection (hidden/background workspaces excluded, deduped)
// ---------------------------------------------------------------------------

// Field separator for a root descriptor string. NUL never appears in a path or
// key, so `rootKey\0root` round-trips unambiguously. Descriptors are strings so
// the store selector stays shallow-stable (an array of primitives): the hook
// re-subscribes only when the SET of project roots actually changes, not on every
// unrelated workspace churn.
const ROOT_DESCRIPTOR_SEP = '\u0000'

// The distinct project roots the aggregate scans, as sorted `rootKey\0root`
// descriptors. Derived from the workspace list: several workspaces routinely
// share one project folder, so roots are deduped by their normalized folder key
// (the same key the shared scan is grouped under), and a workspace without a
// folder path contributes no root.
//
// The one exclusion is the background Automations host, which stands for no
// project of its own. Deliberately NOT the broader `isHiddenFromRail`: since item
// 1767 that also covers sprint-run workspaces, and a sprint runs IN a project the
// operator works in — dropping its root would make a project's backlog vanish
// from this page whenever its only open workspace happened to be a sprint.
export function collectBacklogProjectRootDescriptors(
  workspaces: ReadonlyArray<Pick<Workspace, 'folderPath' | 'mode'>>,
): string[] {
  const byKey = new Map<string, string>()
  for (const workspace of workspaces) {
    if (!workspace.folderPath) continue
    if (isAutomationsHostWorkspace(workspace)) continue
    const rootKey = workspaceFolderKey(workspace.folderPath)
    if (!rootKey || byKey.has(rootKey)) continue
    byKey.set(rootKey, `${rootKey}${ROOT_DESCRIPTOR_SEP}${workspace.folderPath}`)
  }
  return [...byKey.values()].sort()
}

type BacklogProjectRoot = { root: string; rootKey: string; name: string }

// ---------------------------------------------------------------------------
// Feed assembly (pure — the hook only wires subscriptions + config reads to it)
// ---------------------------------------------------------------------------

// Assemble the per-project feeds from the current scan snapshots + resolved
// display keys. Pure so the wrapper shape, error isolation, and key tagging are
// unit-testable without a DOM. A project with no snapshot yet reads as loading;
// a scan in the `error` state (no items) surfaces its first error on that feed
// alone, leaving every other feed to render.
export function buildBacklogProjectFeeds(
  roots: ReadonlyArray<BacklogProjectRoot>,
  snapshots: ReadonlyMap<string, BacklogScanSnapshot>,
  displayKeys: ReadonlyMap<string, string>,
): BacklogProjectFeed[] {
  return roots.map(({ root, rootKey, name }) => {
    const snapshot = snapshots.get(rootKey)
    const scan = snapshot?.scan ?? null
    const project: BacklogProjectRef = {
      key: displayKeys.get(rootKey) ?? '',
      name,
      root,
      rootKey,
    }
    const derivedItems = deriveBacklogEpicStatuses(scan?.items ?? [])
    const error = scan?.state === 'error' ? (scan.errors[0]?.message ?? 'Backlog scan failed.') : undefined
    return {
      projectKey: project.key,
      projectName: name,
      root,
      rootKey,
      items: derivedItems.map((item) => ({ project, item })),
      derived: deriveBacklogProjectDerived(derivedItems),
      loading: snapshot?.loading ?? true,
      ...(error ? { error } : {}),
    }
  })
}
