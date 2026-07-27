// The cross-project feed a horizon is planned against (MC-1924), lifted out of
// RoadmapPlannerView so the plan column and the detail pane's backlog mode read
// ONE library rather than each assembling their own.
//
// A horizon spans projects: the home project's refs are unqualified, every other
// project's carry an `alias:` prefix recorded in the file's `projects:` map.
// Aliases are seeded from the horizon's OWN map so an already-aliased project
// keeps its key (its existing refs stay resolvable); a project contributing for
// the first time mints a stable one. Scans ride the shared subscription, so a
// project with an open Backlog panel is not scanned twice.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { parseRoadmap } from '../../../../../shared/backlog/roadmap'
import { subscribeBacklogScan } from '../../../hooks/useSharedBacklogScan'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { normalizeProjectRootKey } from '../../../utils/projectKnowledge'
import { basename, samePath } from '../../../utils/paths'
import type { BacklogItem } from '../../../utils/backlog'
import { roadmapProjectAlias, type RoadmapProjectItems } from '../../backlog/roadmapAuthoring'

// The normalized project-root key backlog scans are shared under (mirrors
// roadmapBoardData.rootKey), so a workspace root and a horizon alias path compare
// on the same footing.
function rootKey(path: string): string {
  return normalizeProjectRootKey(path)?.toLowerCase() ?? path
}

// Subscribe to the shared backlog scan for every project root, aggregating each
// root's items by its normalized key.
export function useAllProjectScans(roots: ReadonlyArray<string>): Map<string, BacklogItem[]> {
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

export type HorizonLibrary = {
  /** Every project the horizon can draw work from, home first. */
  projects: RoadmapProjectItems[]
  /** The home project's scanned items (the horizon file itself lives here). */
  homeItems: BacklogItem[]
  /** The home scan has reported at least once — how "still loading" is told from
   *  "the horizon file is gone". */
  homeScanLoaded: boolean
}

export function useHorizonLibrary(homePath: string | null, roadmapContent: string | null): HorizonLibrary {
  const workspaceRoots = useWorkspaceStore(
    useShallow((s) => s.workspaces.map((w) => w.folderPath).filter((path): path is string => Boolean(path))),
  )
  const roots = useMemo(() => {
    const ordered = homePath ? [homePath, ...workspaceRoots] : [...workspaceRoots]
    return Array.from(new Map(ordered.map((root) => [rootKey(root), root] as const)).values())
  }, [homePath, workspaceRoots])

  const itemsByKey = useAllProjectScans(roots)
  const homeItems = useMemo(
    () => (homePath ? (itemsByKey.get(rootKey(homePath)) ?? []) : []),
    [homePath, itemsByKey],
  )
  const homeScanLoaded = homePath !== null && itemsByKey.has(rootKey(homePath))

  const projects = useMemo<RoadmapProjectItems[]>(() => {
    if (!homePath) return []
    const parsed = parseRoadmap(roadmapContent ?? '')
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
  }, [homePath, roadmapContent, roots, itemsByKey])

  return { projects, homeItems, homeScanLoaded }
}
