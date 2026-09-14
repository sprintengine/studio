// Everything the Epic tab needs from the project's backlog, wired once (item
// 2028). The view below it is presentation only.
//
// Two reuse rules hold this file together:
//   • ONE scan. The children come from `useSharedBacklogScan` on this run's
//     project — the same shared subscription an open Backlog panel or door
//     already uses, so mounting this tab never starts a second scan.
//   • ONE detail implementation. The selected child renders through the shared
//     `BacklogItemDetailPane`, which wants the door's per-project feed shape, so
//     the feed is assembled here from the SAME pure derivations the door and the
//     panel run (`deriveBacklogEpicStatuses` / `deriveBacklogProjectDerived`) —
//     never a second derivation of epic status or blocked state.
//
// Mutations route through `createBacklogDoorActions` for the one project this
// run works in: the detail pane's triage, status, epic, mockups and dependency
// edits write into that project's backlog through the same validated IPC the
// door uses.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useSharedBacklogScan, refreshSharedBacklogScan } from '../../../hooks/useSharedBacklogScan'
import {
  deriveBacklogEpicStatuses,
  deriveBacklogProjectDerived,
  type BacklogProjectFeed,
  type BacklogProjectRef,
} from '../../../hooks/useAllProjectsBacklog'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { workspaceFolderKey } from '../../../store/slices/workspacesSlice'
import {
  backlogConfigRelativePath,
  backlogItemSlugFromPath,
  resolveBacklogDisplayKey,
  type BacklogItem,
} from '../../../utils/backlog'
import { groupItemsByEpic } from '../../../utils/backlogEpics'
import { basename, joinFilePath } from '../../../utils/paths'
import { focusOrAddFileTab } from '../../../utils/modelRegistry'
import { getRendererHost, selectModuleEnabled } from '../../../modules'
import { useConfirmDialog } from '../../ui/ConfirmDialog'
import {
  createBacklogDoorActions,
  type BacklogDoorMutationApi,
} from '../../workspace/globalSurface/backlog/backlogDoorActions'
import {
  buildSprintEngineEpicModel,
  type SprintEngineEpicModel,
  type SprintEngineEpicSeed,
} from './sprintEngineEpicModel'
import type { BacklogLinkProvider } from '../../../modules/renderer-host'
import type {
  BacklogActions,
  BacklogDependencyChoice,
  BacklogEpicChoice,
} from '../../backlog/BacklogItemContextMenu'
import type { SprintEngineTask } from '../../../types/workspace'

export type SprintEngineEpicBacklog = {
  /** Null until the project's scan reports, so the view can say "loading"
   *  rather than claiming an epic's children are missing. */
  model: SprintEngineEpicModel | null
  loading: boolean
  /** The scan failed outright for this project. */
  error: string | null
  /** The last mutation error, for the detail pane's edits. Cleared by the next
   *  mutation, which is the only thing that can resolve it. */
  actionError: string | null
  project: BacklogProjectRef
  feed: BacklogProjectFeed
  actions: BacklogActions
  linkProviders: ReadonlyArray<BacklogLinkProvider>
  epicChoices: BacklogEpicChoice[]
  dependencyChoices: BacklogDependencyChoice[]
}

export function useSprintEngineEpicBacklog(input: {
  seed: SprintEngineEpicSeed
  tasks: ReadonlyArray<SprintEngineTask>
  /** Project root. Null while the run's folder is unresolved — no scan runs. */
  folderPath: string | null
}): SprintEngineEpicBacklog {
  const { seed, tasks, folderPath } = input
  const { scan, loading } = useSharedBacklogScan(folderPath)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const dialog = useConfirmDialog()
  const [actionError, setActionError] = useState<string | null>(null)

  const projectName = folderPath ? basename(folderPath) : ''
  // The project's Backlog display key, read from its own config exactly as the
  // cross-project aggregate reads it (a missing/unreadable config falls back to
  // the same derived default the allocator would mint).
  const [displayKey, setDisplayKey] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!folderPath) {
      setDisplayKey('')
      return undefined
    }
    void (async () => {
      let raw: string | null = null
      try {
        raw = await window.api.readfile(joinFilePath(folderPath, backlogConfigRelativePath(folderPath)))
      } catch {
        raw = null
      }
      if (!cancelled) setDisplayKey(resolveBacklogDisplayKey(raw, projectName))
    })()
    return () => {
      cancelled = true
    }
  }, [folderPath, projectName])

  const project = useMemo<BacklogProjectRef>(
    () => ({
      key: displayKey,
      name: projectName,
      root: folderPath ?? '',
      rootKey: workspaceFolderKey(folderPath) ?? '',
    }),
    [displayKey, projectName, folderPath],
  )

  // Epic status derivation first (an epic reflects its children, never its own
  // stale frontmatter), then the project-local rollups — the same order, and the
  // same helpers, the Backlog panel and door run.
  const derivedItems = useMemo(() => deriveBacklogEpicStatuses(scan?.items ?? []), [scan])
  const feed = useMemo<BacklogProjectFeed>(() => {
    const error = scan?.state === 'error' ? (scan.errors[0]?.message ?? 'Backlog scan failed.') : undefined
    return {
      projectKey: project.key,
      projectName: project.name,
      root: project.root,
      rootKey: project.rootKey,
      items: derivedItems.map((item) => ({ project, item })),
      derived: deriveBacklogProjectDerived(derivedItems),
      loading,
      ...(error ? { error } : {}),
    }
  }, [derivedItems, project, scan, loading])

  const model = useMemo(
    () =>
      scan
        ? buildSprintEngineEpicModel({
            seed,
            items: derivedItems,
            scanErrors: scan.errors,
            tasks,
          })
        : null,
    [scan, derivedItems, seed, tasks],
  )

  const runAction = useCallback(async (fn: () => Promise<void>) => {
    setActionError(null)
    try {
      await fn()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const actions = useMemo(
    () =>
      createBacklogDoorActions({
        api: window.api as unknown as BacklogDoorMutationApi,
        // One project: every item on this surface belongs to the run's own.
        resolveProject: () => (project.root ? project : null),
        itemsForProject: () => derivedItems,
        refreshProject: (root) => void refreshSharedBacklogScan(root),
        runAction,
        confirmDialog: dialog.confirm,
        promptDialog: dialog.prompt,
        openInEditor: (item, target) =>
          void runAction(async () => {
            const workspace = useWorkspaceStore
              .getState()
              .workspaces.find((candidate) => candidate.folderPath === target.root)
            if (!workspace) {
              await window.api.showItemInFolder(item.path)
              return
            }
            const name = basename(item.relativePath)
            openFile(workspace.id, item.path, name, item.sourceContent)
            focusOrAddFileTab(workspace.id, item.path, name)
          }),
        revealInFiles: (item) =>
          void runAction(async () => {
            await window.api.showItemInFolder(item.path)
          }),
        // `createFolder` / `createPlan` are the Backlog list's own empty-state
        // affordances; this surface mounts only the detail pane (an item is
        // always selected), so no path here can reach them. Capture belongs to
        // the Backlog door, which owns the project picker they need.
        openCreate: () => {
          setActionError('New backlog items are captured in the Backlog surface, not inside a sprint.')
        },
      }),
    [project, derivedItems, runAction, dialog, openFile],
  )

  const linkProviders = useMemo<BacklogLinkProvider[]>(
    () => getRendererHost().getBacklogLinkProviders((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )

  // An epic and a prerequisite never cross a project, so both choice sets come
  // from this project's own items — derived the same way both doors derive them.
  const epicChoices = useMemo<BacklogEpicChoice[]>(
    () =>
      groupItemsByEpic([...derivedItems])
        .filter((group) => group.kind === 'epic' && group.slug != null)
        .map((group) => ({
          slug: group.slug as string,
          title: group.title,
          displayId: group.epic?.displayId,
        })),
    [derivedItems],
  )
  const dependencyChoices = useMemo<BacklogDependencyChoice[]>(
    () =>
      derivedItems
        .filter((item: BacklogItem) => !item.isEpic)
        .map((item: BacklogItem) => ({
          id: item.id,
          slug: backlogItemSlugFromPath(item.relativePath),
          title: item.title,
          displayId: item.displayId,
        })),
    [derivedItems],
  )

  return {
    model,
    loading,
    error: feed.error ?? null,
    actionError,
    project,
    feed,
    actions,
    linkProviders,
    epicChoices,
    dependencyChoices,
  }
}
