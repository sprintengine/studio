import {
  backlogRootPath,
  nextArchiveRelativePath,
  normalizeRelativePath,
  type BacklogCriticality,
  type BacklogDifficulty,
  type BacklogHighlight,
  type BacklogHighlightColor,
  type BacklogItem,
  type BacklogItemLink,
  type BacklogItemStatus,
  type BacklogRisk,
} from '../../../../utils/backlog'
import { childrenOfEpic, epicSlug, planEpicArchive } from '../../../../utils/backlogEpics'
import { nextBacklogItemStatusFromLinks } from '../../../../utils/backlogLinks'
import { BACKLOG_STATUS_LABEL } from '../../../backlog/BacklogRow'
import type { BacklogActions } from '../../../backlog/BacklogItemContextMenu'
import type { BacklogProjectRef } from '../../../../hooks/useAllProjectsBacklog'

// The Backlog door's BacklogActions, routed PER ITEM to that item's OWN project
// root (T9). The per-project panel closes every mutation over a single
// `folderPath`; the door instead resolves each action's target project from the
// item it is handed, so a status change on an `MA-…` row writes into multiuath's
// backlog/ and a star on an `MC-…` row writes into multicode's sidecar — the
// same validated backlog IPC the panel uses, never a generic renderer file write.
//
// The mutation bodies mirror BacklogPanel's exactly (same IPC calls, same
// link-sever confirm, same epic-archive rollup) so the door and the panel cannot
// drift; only the `workspaceRoot` argument differs (it is the item's project, not
// the panel's). Kept as an injectable factory so the routing is unit-testable
// without a DOM: the acceptance "mutations hit the correct project's files" is a
// plain assertion on which root each stubbed IPC call received.

type MutationResult = { ok: boolean; message?: string }

// The window.api subset the door mutations touch, injectable for tests. Names and
// shapes match the electron-api the panel calls; only the methods used here are
// declared so a fake needs to stub no more than the door exercises.
export type BacklogDoorMutationApi = {
  updateBacklogStatus(input: { workspaceRoot: string; relativePath: string; status: BacklogItemStatus }): Promise<MutationResult>
  updateBacklogTriage(input: {
    workspaceRoot: string
    relativePath: string
    difficulty?: BacklogDifficulty | null
    criticality?: BacklogCriticality | null
    risk?: BacklogRisk | null
  }): Promise<MutationResult>
  updateBacklogEpic(input: { workspaceRoot: string; relativePath: string; epic: string | null }): Promise<MutationResult>
  updateBacklogEpicColor(input: { workspaceRoot: string; relativePath: string; color: BacklogHighlightColor | null }): Promise<MutationResult>
  updateBacklogDependencies(input: { workspaceRoot: string; relativePath: string; dependsOn: string[] | null }): Promise<MutationResult>
  updateBacklogMockups(input: { workspaceRoot: string; relativePath: string; mockups: string[] | null }): Promise<MutationResult>
  updateBacklogHighlight(input: { workspaceRoot: string; relativePath: string; starred: boolean; color: BacklogHighlightColor | null }): Promise<MutationResult>
  removeBacklogLink(input: { workspaceRoot: string; relativePath: string; linkId: string }): Promise<MutationResult>
  createBacklogEpic(input: { workspaceRoot: string; title: string }): Promise<MutationResult & { slug: string }>
  moveBacklogObjectSource(input: { workspaceRoot: string; relativePath: string; nextRelativePath: string }): Promise<MutationResult>
  removeBacklogObjectRecord(input: { workspaceRoot: string; relativePath: string }): Promise<MutationResult>
  readfile(path: string): Promise<string>
  writefile(path: string, content: string): Promise<void>
  createFile(dir: string, name: string): Promise<string>
  ensureDir(root: string, relative: string): Promise<string>
  deletePath(path: string): Promise<void>
  renamePath(path: string, nextName: string): Promise<string>
  showItemInFolder(path: string): Promise<void>
}

type ConfirmDialog = (opts: {
  title: string
  body?: string
  confirmLabel?: string
  tone?: 'danger' | 'default'
}) => Promise<boolean>

type PromptDialog = (opts: {
  title: string
  // Required by the shared prompt dialog: an input without a label is not an
  // accessible control, so every caller names its field.
  inputLabel: string
  initialValue?: string
  confirmLabel?: string
  required?: boolean
}) => Promise<string | null | undefined>

export type BacklogDoorActionDeps = {
  api: BacklogDoorMutationApi
  // The project a bare BacklogItem belongs to. Null when its project has left the
  // aggregate (a race with a closing workspace) — the action then no-ops rather
  // than guessing a root.
  resolveProject: (item: BacklogItem) => BacklogProjectRef | null
  // Every scanned item of a project (by feed rootKey), for the epic-archive
  // rollup and epic-colour read that need the sibling set.
  itemsForProject: (rootKey: string) => ReadonlyArray<BacklogItem>
  // Re-scan a project after a mutation. items.json-only writes (star, triage,
  // highlight) never trip the backlog/ fs watcher, so an explicit refresh is
  // required for the door to reflect them — exactly why the panel calls runScan.
  refreshProject: (root: string) => void
  // Run a mutation with the door's error surface (clears, then catches).
  runAction: (fn: () => Promise<void>) => Promise<void>
  confirmDialog: ConfirmDialog
  promptDialog: PromptDialog
  // Workspace-scoped affordances the door resolves to the item's project.
  openInEditor: (item: BacklogItem, project: BacklogProjectRef) => void
  revealInFiles: (item: BacklogItem) => void
  // Open the door's project-scoped "New item" capture flow.
  openCreate: () => void
}

function assertMutation(result: MutationResult): void {
  if (!result.ok) throw new Error(result.message || 'Unable to update Backlog metadata.')
}

export function createBacklogDoorActions(deps: BacklogDoorActionDeps): BacklogActions {
  const { api, resolveProject, itemsForProject, refreshProject, runAction, confirmDialog, promptDialog } = deps

  // Move one item into `backlog/archived/<name>` in its own project: copy the
  // live file, trash the source, then re-point the sidecar record. Mirrors the
  // panel's moveItemToArchive (minus editor-tab remap, which the door does not
  // own); cleans up the archived copy on a partial write so archive never leaves
  // a duplicate. Shared by single-item Archive and the epic rollup.
  async function moveItemToArchive(root: string, item: BacklogItem, archivedRel: string): Promise<void> {
    const archivedName = archivedRel.slice(archivedRel.lastIndexOf('/') + 1)
    const content = await api.readfile(item.path)
    const archivedDir = await api.ensureDir(backlogRootPath(root), 'archived')
    const newPath = await api.createFile(archivedDir, archivedName)
    try {
      await api.writefile(newPath, content)
      await api.deletePath(item.path)
    } catch (error) {
      await api.deletePath(newPath).catch(() => {})
      throw error
    }
    const moved = await api.moveBacklogObjectSource({
      workspaceRoot: root,
      relativePath: item.relativePath,
      nextRelativePath: archivedRel,
    })
    assertMutation(moved)
  }

  return {
    createFolder: () => deps.openCreate(),
    createPlan: () => deps.openCreate(),
    openInEditor: (item) => {
      const project = resolveProject(item)
      if (project) deps.openInEditor(item, project)
    },
    revealInFiles: (item) => deps.revealInFiles(item),

    setStatus: (item, status) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project || item.status === status) return
        const executionLinks = item.links.filter((link) => link.type === 'execution')
        const epicChildStatuses = item.isEpic
          ? childrenOfEpic([...itemsForProject(project.rootKey)], epicSlug(item)).map((child) => child.status)
          : undefined
        const childDriven = (epicChildStatuses?.length ?? 0) > 0
        const derivedStatus = nextBacklogItemStatusFromLinks(item.status, item.links, epicChildStatuses)
        // Only a genuinely contradictory manual set on a link-driven leaf severs
        // the link; setting the status the derivation already yields keeps it.
        const needsUnlink = executionLinks.length > 0 && !childDriven && status !== derivedStatus
        if (needsUnlink) {
          const confirmed = await confirmDialog({
            title: 'Override linked status?',
            body: `Setting “${BACKLOG_STATUS_LABEL[status]}” will unlink ${executionLinks.length === 1 ? 'the linked sprint' : `${executionLinks.length} linked executions`}. The run itself will not be deleted.`,
            confirmLabel: `Unlink and set ${BACKLOG_STATUS_LABEL[status]}`,
          })
          if (!confirmed) return
          for (const link of executionLinks) {
            assertMutation(
              await api.removeBacklogLink({ workspaceRoot: project.root, relativePath: item.relativePath, linkId: link.id }),
            )
          }
        }
        assertMutation(await api.updateBacklogStatus({ workspaceRoot: project.root, relativePath: item.relativePath, status }))
        refreshProject(project.root)
      }),

    setDifficulty: (item, value) => void setTriage(item, { difficulty: value === 'unset' ? null : value }),
    setCriticality: (item, value) => void setTriage(item, { criticality: value === 'unset' ? null : value }),
    setRisk: (item, value) => void setTriage(item, { risk: value === 'unset' ? null : value }),

    setEpic: (item, slug) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project || item.epic === (slug ?? undefined)) return
        assertMutation(await api.updateBacklogEpic({ workspaceRoot: project.root, relativePath: item.relativePath, epic: slug }))
        refreshProject(project.root)
      }),

    setEpicColor: (item, color) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        assertMutation(await api.updateBacklogEpicColor({ workspaceRoot: project.root, relativePath: item.relativePath, color }))
        refreshProject(project.root)
      }),

    setDependencies: (item, slugs) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        assertMutation(await api.updateBacklogDependencies({ workspaceRoot: project.root, relativePath: item.relativePath, dependsOn: slugs }))
        refreshProject(project.root)
      }),

    setMockups: (item, mockups) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        assertMutation(await api.updateBacklogMockups({ workspaceRoot: project.root, relativePath: item.relativePath, mockups }))
        refreshProject(project.root)
      }),

    setHighlight: (item, highlight: BacklogHighlight) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        assertMutation(
          await api.updateBacklogHighlight({
            workspaceRoot: project.root,
            relativePath: item.relativePath,
            starred: highlight.starred,
            color: highlight.color,
          }),
        )
        refreshProject(project.root)
      }),

    removeLink: (item, link: BacklogItemLink) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        const confirmed = await confirmDialog({
          title: `Unlink ${link.label}?`,
          body: 'This removes only the Backlog association. The linked sprint, agent, or external target will not be deleted.',
          confirmLabel: 'Unlink',
        })
        if (!confirmed) return
        assertMutation(await api.removeBacklogLink({ workspaceRoot: project.root, relativePath: item.relativePath, linkId: link.id }))
        refreshProject(project.root)
      }),

    createEpic: (item) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        const title = (await promptDialog({ title: 'New epic', inputLabel: 'Epic title', confirmLabel: 'Create', required: true }))?.trim()
        if (!title) return
        const created = await api.createBacklogEpic({ workspaceRoot: project.root, title })
        if (!created.ok) throw new Error(created.message)
        assertMutation(await api.updateBacklogEpic({ workspaceRoot: project.root, relativePath: item.relativePath, epic: created.slug }))
        refreshProject(project.root)
      }),

    rename: (item) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        const current = item.relativePath.slice(item.relativePath.lastIndexOf('/') + 1)
        const next = (await promptDialog({ title: 'Rename item', inputLabel: 'File name', initialValue: current, confirmLabel: 'Rename', required: true }))?.trim()
        if (!next || next === current) return
        await api.renamePath(item.path, next)
        const dir = item.relativePath.slice(0, item.relativePath.lastIndexOf('/') + 1)
        const nextRelativePath = normalizeRelativePath(`${dir}${next}`)
        assertMutation(await api.moveBacklogObjectSource({ workspaceRoot: project.root, relativePath: item.relativePath, nextRelativePath }))
        refreshProject(project.root)
      }),

    archive: (item) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project || item.status === 'archived') return
        const archivedPaths = itemsForProject(project.rootKey).filter((i) => i.status === 'archived').map((i) => i.relativePath)
        const archivedRel = nextArchiveRelativePath(item.relativePath, archivedPaths)
        await moveItemToArchive(project.root, item, archivedRel)
        refreshProject(project.root)
      }),

    archiveEpic: (item) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project || item.status === 'archived' || !item.isEpic) return
        const projectItems = itemsForProject(project.rootKey)
        const archivedPaths = projectItems.filter((i) => i.status === 'archived').map((i) => i.relativePath)
        const children = childrenOfEpic([...projectItems], epicSlug(item)).filter((child) => child.status !== 'archived')
        const plan = planEpicArchive(item, children, archivedPaths)
        try {
          for (const move of plan.children) {
            if (move.repointEpic !== null) {
              assertMutation(await api.updateBacklogEpic({ workspaceRoot: project.root, relativePath: move.item.relativePath, epic: move.repointEpic }))
            }
            await moveItemToArchive(project.root, move.item, move.archivedRel)
          }
          await moveItemToArchive(project.root, item, plan.epicArchivedRel)
        } catch (error) {
          refreshProject(project.root)
          throw error
        }
        refreshProject(project.root)
      }),

    remove: (item) =>
      void runAction(async () => {
        const project = resolveProject(item)
        if (!project) return
        const confirmed = await confirmDialog({
          title: 'Delete item?',
          body: `“${item.title}” will be moved to the trash. This affects the file only — no sprint state changes.`,
          confirmLabel: 'Delete',
          tone: 'danger',
        })
        if (!confirmed) return
        await api.deletePath(item.path)
        assertMutation(await api.removeBacklogObjectRecord({ workspaceRoot: project.root, relativePath: item.relativePath }))
        refreshProject(project.root)
      }),
  }

  function setTriage(
    item: BacklogItem,
    triage: { difficulty?: BacklogDifficulty | null; criticality?: BacklogCriticality | null; risk?: BacklogRisk | null },
  ): Promise<void> {
    return runAction(async () => {
      const project = resolveProject(item)
      if (!project) return
      assertMutation(await api.updateBacklogTriage({ workspaceRoot: project.root, relativePath: item.relativePath, ...triage }))
      refreshProject(project.root)
    })
  }
}
