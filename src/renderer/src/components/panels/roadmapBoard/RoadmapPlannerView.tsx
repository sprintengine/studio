// The in-surface cross-project planner (MC-1690 / T3). It hosts the shared roadmap
// editor (RoadmapEditorPanel) on the instance-global Roadmap surface, feeding it the
// backlog of EVERY known project as a drag-in library. Planning the roadmap no longer
// detours to a single project's Backlog panel: the library rail here shows all
// projects together, and dragging an item or an epic in writes project-qualified
// refs (and the `projects:` alias map) straight into the one instance roadmap file.
//
// This is a thin data wrapper. All the authoring — tracks, steps, drag/reorder,
// epic snapshot/drift, policy, save — is the reused editor; all the transforms are
// the pure engine in roadmapAuthoring.ts. This file only assembles the cross-project
// item feed and resolves the home roadmap file into the editor's inputs.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { parseRoadmap } from '../../../../../shared/backlog/roadmap'
import { subscribeBacklogScan } from '../../../hooks/useSharedBacklogScan'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { normalizeProjectRootKey } from '../../../utils/projectKnowledge'
import { basename, samePath } from '../../../utils/paths'
import { normalizeRelativePath, type BacklogItem } from '../../../utils/backlog'
import { GhostButton } from '../../ui'
import { RoadmapEditorPanel } from '../../backlog/RoadmapEditorPanel'
import { roadmapProjectAlias, splitAuthoredRef, type RoadmapProjectItems } from '../../backlog/roadmapAuthoring'

// The normalized project-root key backlog scans are shared under (mirrors
// roadmapBoardData.rootKey), so a workspace root and a roadmap alias path compare
// on the same footing.
function rootKey(path: string): string {
  return normalizeProjectRootKey(path)?.toLowerCase() ?? path
}

// Subscribe to the shared backlog scan for every project root, aggregating each
// root's items by its normalized key. Reuses the shared subscription, so a project
// with an open BacklogPanel or the steering board is not scanned twice.
function useAllProjectScans(roots: ReadonlyArray<string>): Map<string, BacklogItem[]> {
  const [itemsByKey, setItemsByKey] = useState<Map<string, BacklogItem[]>>(new Map())
  const depKey = useMemo(() => Array.from(new Set(roots.map(rootKey))).sort().join('|'), [roots])
  const rootsRef = useRef<ReadonlyArray<string>>(roots)
  rootsRef.current = roots

  useEffect(() => {
    const unique = Array.from(new Map(rootsRef.current.map((root) => [rootKey(root), root] as const)).values())
    if (unique.length === 0) {
      setItemsByKey(new Map())
      return
    }
    const aggregate = new Map<string, BacklogItem[]>()
    const unsubscribes = unique.map((root) =>
      subscribeBacklogScan(root, ({ scan }) => {
        aggregate.set(rootKey(root), scan?.items ?? [])
        setItemsByKey(new Map(aggregate))
      }),
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [depKey])

  return itemsByKey
}

export function RoadmapPlannerView({
  homePath,
  roadmapRef,
  onBack,
  onSaved,
  onRevealItem,
}: {
  homePath: string
  // The instance roadmap file (project-relative to the home project).
  roadmapRef: string
  onBack: () => void
  onSaved: () => void
  // Open a backlog file in its project's Backlog panel (the "open the file" and
  // per-step "go to item" affordances). Given the project ROOT + the relative path.
  onRevealItem: (projectRoot: string, relativePath: string) => void
}): JSX.Element {
  // Every project the instance knows, home first, de-duplicated by root — the
  // library spans all of them so any project's work can be dragged in.
  const workspaceRoots = useWorkspaceStore(
    useShallow((s) => s.workspaces.map((w) => w.folderPath).filter((path): path is string => Boolean(path))),
  )
  const roots = useMemo(() => {
    const ordered = [homePath, ...workspaceRoots]
    return Array.from(new Map(ordered.map((root) => [rootKey(root), root] as const)).values())
  }, [homePath, workspaceRoots])

  const itemsByKey = useAllProjectScans(roots)
  const homeItems = itemsByKey.get(rootKey(homePath)) ?? []
  // The home scan has reported once the map holds its key (even with an empty
  // list) — this is how we tell "scan still pending" from "the file is gone".
  const homeScanLoaded = itemsByKey.has(rootKey(homePath))
  const normalizedRef = normalizeRelativePath(roadmapRef)
  const roadmapItem = useMemo(
    () => homeItems.find((item) => normalizeRelativePath(item.relativePath) === normalizedRef),
    [homeItems, normalizedRef],
  )

  // The cross-project feed the editor's library + resolution read. Aliases are
  // seeded from the roadmap's own `projects:` map so an already-aliased project
  // keeps its key (its existing refs stay resolvable); new projects mint a stable
  // alias. The home project is unqualified (projectKey null).
  const libraryProjects = useMemo<RoadmapProjectItems[]>(() => {
    if (!roadmapItem) return []
    const parsed = parseRoadmap(roadmapItem.sourceContent)
    const aliasByRootKey = new Map(parsed.projects.map((project) => [rootKey(project.path), project.alias] as const))
    const taken = new Set<string>(parsed.projects.map((project) => project.alias))
    const result: RoadmapProjectItems[] = []
    for (const root of roots) {
      const items = itemsByKey.get(rootKey(root)) ?? []
      if (samePath(root, homePath)) {
        result.push({ projectKey: null, projectName: basename(root), path: root, items })
        continue
      }
      let alias = aliasByRootKey.get(rootKey(root))
      if (!alias) {
        alias = roadmapProjectAlias(basename(root), taken)
        taken.add(alias)
      }
      result.push({ projectKey: alias, projectName: basename(root), path: root, items })
    }
    return result
  }, [roadmapItem, roots, itemsByKey, homePath])

  if (!roadmapItem) {
    // Scan not in yet → genuinely loading. Scan in but the ref is absent → the
    // roadmap file is gone (moved/deleted outside Multicode): a resolvable
    // not-found state with a way back, never "Loading your plan…" forever.
    return (
      <div className="flex h-full min-h-0 flex-col bg-[color:var(--bg-surface)]">
        <PlannerHeader onBack={onBack} />
        {homeScanLoaded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--tone-neutral-soft)] text-[18px] text-[color:var(--text-muted)]">
              ?
            </div>
            <h3 className="text-[14px] font-semibold text-[color:var(--text-strong)]">
              This roadmap file no longer exists
            </h3>
            <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
              It may have been moved or deleted outside Multicode.
            </p>
            <GhostButton className="mt-2" onClick={onBack}>
              Back to the board
            </GhostButton>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[color:var(--text-muted)]">
            Loading your plan…
          </div>
        )}
      </div>
    )
  }

  return (
    <RoadmapEditorPanel
      roadmapItem={roadmapItem}
      items={homeItems}
      libraryProjects={libraryProjects}
      onSaved={onSaved}
      onOpenInEditor={() => onRevealItem(homePath, normalizedRef)}
      onNavigate={(ref) => {
        const { projectKey, relativePath } = splitAuthoredRef(ref)
        const project = libraryProjects.find((candidate) => candidate.projectKey === projectKey)
        if (project) onRevealItem(project.path, relativePath)
      }}
      showBack
      onBack={onBack}
    />
  )
}

// The minimal header shown only while the plan is still loading (the editor supplies
// its own once the roadmap resolves), so the Back affordance is never missing.
function PlannerHeader({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-4 py-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to roadmap"
        className="interactive -ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className="text-[13px] font-semibold text-[color:var(--text-strong)]">Plan roadmap</span>
    </header>
  )
}
