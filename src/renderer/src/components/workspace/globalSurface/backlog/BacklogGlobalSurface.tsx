import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  ContextMenu,
  GhostButton,
  InlineNotice,
  MenuItem,
  Tooltip,
  useConfirmDialog,
  type SelectItem,
} from '../../../ui'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { SurfaceCanvasState, SurfaceRailHeader } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import {
  useAllProjectsBacklog,
  type BacklogProjectFeed,
  type BacklogProjectRef,
} from '../../../../hooks/useAllProjectsBacklog'
import { refreshSharedBacklogScan } from '../../../../hooks/useSharedBacklogScan'
import { workspaceFolderKey } from '../../../../store/slices/workspacesSlice'
import { requestNewSprint } from '../sprints/sprintDoorRequests'
import { useRelativeNow } from '../../../../hooks/useRelativeNow'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { useBacklogDoorViewStore } from '../../../../store/backlogViewStore'
import {
  backlogItemSlugFromPath,
  normalizeRelativePath,
  type BacklogItem,
} from '../../../../utils/backlog'
import {
  resolveBacklogRowColor,
  type BacklogGroup,
  type BacklogSort,
  type BacklogView,
} from '../../../../utils/backlogTriage'
import {
  epicGroupKey,
  epicSlug,
  groupItemsByEpic,
  groupedBacklogRows,
  type BacklogEpicGroup,
} from '../../../../utils/backlogEpics'
import {
  matchWorkspaceForBacklogRunLink,
  sprintEngineRunLinkForItem,
} from '../../../../utils/sprintengineBacklogLinks'
import { deriveSprintEngineRunGlyph } from '../../../../utils/sprintengine'
import { basename } from '../../../../utils/paths'
import { focusOrAddFileTab } from '../../../../utils/modelRegistry'
import { getRendererHost, selectModuleEnabled } from '../../../../modules'
import type { BacklogItemActionContext, BacklogLinkProvider } from '../../../../modules/renderer-host'
import { BacklogFilterMenu } from '../../../backlog/BacklogFilterMenu'
import { backlogRowPaintClass } from '../../../backlog/backlogRowPaint'
import {
  BacklogEpicHeaderContent,
  BacklogRowContent,
  BacklogRowHoverCard,
  type BacklogRunGlyph,
} from '../../../backlog/BacklogRow'
import {
  BacklogItemContextMenu,
  CRITICALITY_EDIT_ITEMS,
  DIFFICULTY_EDIT_ITEMS,
  type BacklogDependencyChoice,
  type BacklogEpicChoice,
} from '../../../backlog/BacklogItemContextMenu'
import { BacklogCreateDialog, type BacklogDraft } from '../../../panels/BacklogCreateDialog'
import { ALL_PROJECTS, buildBacklogDoorList } from './backlogSurfaceModel'
import { createBacklogDoorActions, type BacklogDoorMutationApi } from './backlogDoorActions'
import { BacklogItemDetailPane } from '../../../backlog/BacklogItemDetailPane'

// The Backlog door (T9, mockup §4) — one full page listing the backlog of EVERY
// open project, with a toolbar-leading project filter that narrows it. Selecting
// a single project is exactly today's per-project panel (same visible set, same
// order — proved by the golden test on `backlogSurfaceModel`); "All projects" is the
// merged cross-project list where every row carries its project tag.
//
// Storage does not move: items stay as markdown in each project's own backlog/
// folder. This is read-time aggregation over the SAME shared scan a panel uses
// (a project with an open panel is not scanned twice), and every mutation routes
// back to the row's OWN project through the validated backlog IPC — see
// `backlogDoorActions`. The per-project BacklogPanel is untouched.
//
// The work list is this door's RAIL (item 1993 / T19). It used to be a column
// inside the canvas, which made Backlog the last door on the substrate to paint
// its own list of things to choose beside the projects rail — two selectable
// navigation columns before the preview, the exact shape
// `design-system/patterns/context-rail` exists to forbid. The list now renders in
// the app sidebar's own column and the item's detail takes the whole canvas, so
// the door has one rail and one content pane like every other.

// The lens / sort / grouping option lists. The *behaviour* of every lens and
// sort is the shared pure logic in `backlogTriage` (matchesBacklogView /
// compareBacklogItems), which the door composes rather than forks; only these
// human labels are restated here so the per-project panel file stays untouched
// (its zero-diff is an acceptance gate for this task).
const VIEW_ITEMS: SelectItem<BacklogView>[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All items' },
  { value: 'epics', label: 'Epics' },
  { value: 'quick_wins', label: 'Quick wins' },
  { value: 'strategic_bets', label: 'Strategic bets' },
  { value: 'defer', label: 'Defer candidates' },
  { value: 'unestimated', label: 'Unestimated' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

const SORT_ITEMS: SelectItem<BacklogSort>[] = [
  { value: 'best', label: 'Best' },
  { value: 'recent', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'dependency', label: 'Dependency order' },
]

const GROUP_ITEMS: SelectItem<BacklogGroup>[] = [
  { value: 'none', label: 'None' },
  { value: 'by_epic', label: 'By epic' },
]

// A row's cross-project identity. `BacklogItem.id` is the PROJECT-RELATIVE path,
// so two projects holding `backlog/2026-07-22-thing.md` carry the same id —
// selection, the row menu, and the run-glyph map must therefore key on the
// project too, or a click would land on the wrong project's item.
function rowKeyOf(rootKey: string, itemId: string): string {
  return `${rootKey}::${itemId}`
}

// One rendered list entry. A `project` divider appears only when several
// projects' grouped blocks are stacked, so grouped epics never read as one
// cross-project list (an epic slug never crosses projects).
type DoorRenderRow =
  | { kind: 'project'; key: string; project: BacklogProjectRef; count: number }
  | { kind: 'header'; key: string; feed: BacklogProjectFeed; group: BacklogEpicGroup; collapsed: boolean }
  | {
      kind: 'item'
      key: string
      feed: BacklogProjectFeed
      project: BacklogProjectRef
      item: BacklogItem
      indented: boolean
    }

export default function BacklogGlobalSurface(): JSX.Element {
  const { projects, loading } = useAllProjectsBacklog()
  const back = useSurfaceBackNav()
  const now = useRelativeNow()
  const dialog = useConfirmDialog()

  const door = useBacklogDoorViewStore(useShallow((state) => state.door))
  const setDoorView = useBacklogDoorViewStore((state) => state.setDoorView)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  // Every project feed comes from an open workspace; the row's action context
  // needs that workspace's id, so the rows resolve it by folder key.
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const openFile = useWorkspaceStore((state) => state.openFile)
  // Only the Sprint Engine workspaces, narrowed + shallow-compared, so an
  // unrelated workspace change never re-renders the whole list (the panel's
  // render-fan-out rule).
  const sprintEngineWorkspaces = useWorkspaceStore(
    useShallow((state) =>
      state.workspaces.filter(
        (workspace) => workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext),
      ),
    ),
  )

  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [rowMenu, setRowMenu] = useState<{ rowKey: string; x: number; y: number } | null>(null)
  // The create flow: `null` closed, a project ref once a target project is
  // chosen (immediately when one project is in view, else via the picker).
  const [createTarget, setCreateTarget] = useState<BacklogProjectRef | null>(null)
  const [createPicker, setCreatePicker] = useState<{ x: number; y: number } | null>(null)

  // A filter naming a project that has since closed falls back to All rather
  // than showing an empty list with no way to tell why.
  const filter = useMemo(() => {
    if (door.projectFilter === ALL_PROJECTS) return ALL_PROJECTS
    return projects.some((feed) => feed.rootKey === door.projectFilter) ? door.projectFilter : ALL_PROJECTS
  }, [door.projectFilter, projects])

  const list = useMemo(
    () => buildBacklogDoorList(projects, filter, door.view, door.sort, search),
    [projects, filter, door.view, door.sort, search],
  )

  const feedByRootKey = useMemo(() => new Map(projects.map((feed) => [feed.rootKey, feed])), [projects])
  // item -> project / feed, by OBJECT IDENTITY: two projects can hold the same
  // relativePath (and therefore the same item id), so identity — never the path
  // — is what routes a mutation to the right backlog.
  const { projectByItem, feedByItem } = useMemo(() => {
    const byProject = new Map<BacklogItem, BacklogProjectRef>()
    const byFeed = new Map<BacklogItem, BacklogProjectFeed>()
    for (const feed of projects) {
      for (const entry of feed.items) {
        byProject.set(entry.item, entry.project)
        byFeed.set(entry.item, feed)
      }
    }
    return { projectByItem: byProject, feedByItem: byFeed }
  }, [projects])

  const visibleFeeds = useMemo(
    () => (filter === ALL_PROJECTS ? projects : projects.filter((feed) => feed.rootKey === filter)),
    [projects, filter],
  )
  // The project tag is redundant when one project is filtered — that view IS
  // that project — so it is earned only by the cross-project list.
  const showProjectTag = filter === ALL_PROJECTS && projects.length > 1

  // Live Sprint Engine run state per row, resolved against the run's OWN project
  // root, so a door row reflects the runner exactly as that project's panel does.
  const runGlyphByRowKey = useMemo(() => {
    const map = new Map<string, BacklogRunGlyph>()
    for (const feed of projects) {
      for (const { item } of feed.items) {
        const link = sprintEngineRunLinkForItem(item)
        if (!link) continue
        const workspace = matchWorkspaceForBacklogRunLink(sprintEngineWorkspaces, feed.root, link)
        if (!workspace) continue
        const glyph = deriveSprintEngineRunGlyph({
          sprintEngineState: workspace.sprintEngineState,
          autoState: workspace.sprintEngineAutoState,
        })
        if (glyph) map.set(rowKeyOf(feed.rootKey, item.id), glyph)
      }
    }
    return map
  }, [projects, sprintEngineWorkspaces])

  // ── the rendered row list (flat, or epic groups within each project) ───────
  const isGroupCollapsed = useCallback(
    (rootKey: string, group: BacklogEpicGroup) => {
      // Terminal lenses default a finished epic to collapsed (one rolled-up
      // unit); an explicit toggle flips that default. Keys are project-scoped so
      // the same epic slug in two projects collapses independently.
      const defaultCollapsed = (door.view === 'archived' || door.view === 'completed') && group.kind === 'epic'
      const flipped = collapsedGroups.has(`${rootKey}::${epicGroupKey(group)}`)
      return flipped ? !defaultCollapsed : defaultCollapsed
    },
    [collapsedGroups, door.view],
  )

  const renderRows = useMemo<DoorRenderRow[]>(() => {
    // The Epics lens filters to the containers themselves, so grouping would
    // render every epic as a childless header — keep it flat (the panel's rule).
    const grouped = door.group === 'by_epic' && door.view !== 'epics'
    if (!grouped) {
      return list.rows.map((row) => ({
        kind: 'item' as const,
        key: rowKeyOf(row.project.rootKey, row.item.id),
        feed: feedByItem.get(row.item) as BacklogProjectFeed,
        project: row.project,
        item: row.item,
        indented: false,
      }))
    }
    const out: DoorRenderRow[] = []
    const multiProject = visibleFeeds.length > 1
    for (const feed of visibleFeeds) {
      const rowsForFeed = list.rows.filter((row) => row.project.rootKey === feed.rootKey)
      if (rowsForFeed.length === 0) continue
      const project = rowsForFeed[0].project
      if (multiProject) {
        out.push({ kind: 'project', key: `project::${feed.rootKey}`, project, count: rowsForFeed.length })
      }
      const groups = groupItemsByEpic(rowsForFeed.map((row) => row.item))
      for (const row of groupedBacklogRows(groups, (group) => isGroupCollapsed(feed.rootKey, group))) {
        if (row.kind === 'header') {
          out.push({
            kind: 'header',
            key: `${feed.rootKey}::${row.navId}`,
            feed,
            group: row.group,
            collapsed: row.collapsed,
          })
        } else {
          out.push({
            kind: 'item',
            key: rowKeyOf(feed.rootKey, row.item.id),
            feed,
            project,
            item: row.item,
            indented: true,
          })
        }
      }
    }
    return out
  }, [door.group, door.view, list.rows, visibleFeeds, feedByItem, isGroupCollapsed])

  const itemRows = useMemo(
    () => renderRows.filter((row): row is Extract<DoorRenderRow, { kind: 'item' }> => row.kind === 'item'),
    [renderRows],
  )

  // Keep the cursor valid across re-scans, lens changes, and filter changes. The
  // cursor may sit on a group header (headers are navigable options), so it is
  // validated against every nav row — not just the item rows — or collapsing a
  // group would drop the keyboard cursor on the header the user just landed on.
  useEffect(() => {
    if (!selectedKey) return
    const stillPresent = renderRows.some((row) => row.kind !== 'project' && row.key === selectedKey)
    if (!stillPresent) setSelectedKey(null)
  }, [renderRows, selectedKey])

  const selectedRow = useMemo(
    () => itemRows.find((row) => row.key === selectedKey) ?? null,
    [itemRows, selectedKey],
  )

  // ── mutations, each routed to the row's own project ───────────────────────
  const runAction = useCallback(async (fn: () => Promise<void>) => {
    setActionError(null)
    try {
      await fn()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const projectOfFeed = useCallback(
    (feed: BacklogProjectFeed): BacklogProjectRef =>
      feed.items[0]?.project ?? {
        key: feed.projectKey,
        name: feed.projectName,
        root: feed.root,
        rootKey: feed.rootKey,
      },
    [],
  )

  // `anchor` is where the picker opens — the rail's "New item" row supplies its
  // own bottom-left. A caller with no anchor (the row menu, the detail pane)
  // falls back to the rail's top-left corner, which is where that row is.
  const openCreateFlow = useCallback(
    (anchor?: { x: number; y: number }) => {
      setActionError(null)
      const single =
        filter !== ALL_PROJECTS ? feedByRootKey.get(filter) : projects.length === 1 ? projects[0] : null
      if (single) {
        setCreateTarget(projectOfFeed(single))
        return
      }
      // Several projects in view: ask which one the item belongs to rather than
      // silently choosing — a new item in the wrong project is invisible work.
      setCreatePicker({ x: anchor?.x ?? 24, y: anchor?.y ?? 64 })
    },
    [filter, feedByRootKey, projects, projectOfFeed],
  )

  const actions = useMemo(
    () =>
      createBacklogDoorActions({
        api: window.api as unknown as BacklogDoorMutationApi,
        resolveProject: (item) => projectByItem.get(item) ?? null,
        itemsForProject: (rootKey) => feedByRootKey.get(rootKey)?.items.map((entry) => entry.item) ?? [],
        refreshProject: (root) => void refreshSharedBacklogScan(root),
        runAction,
        confirmDialog: dialog.confirm,
        promptDialog: dialog.prompt,
        openInEditor: (item, project) =>
          void runAction(async () => {
            // Open the file in a workspace already on that project; with none
            // open there is no editor to route to, so reveal it instead of
            // silently doing nothing.
            const workspace = useWorkspaceStore
              .getState()
              .workspaces.find((candidate) => candidate.folderPath === project.root)
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
        openCreate: openCreateFlow,
      }),
    [projectByItem, feedByRootKey, runAction, dialog, openCreateFlow, openFile],
  )

  const submitCreate = useCallback(
    async (draft: BacklogDraft) => {
      const project = createTarget
      const title = draft.title.trim()
      if (!project || !title) return
      const feed = feedByRootKey.get(project.rootKey)
      const existing = new Set((feed?.items ?? []).map((entry) => entry.item.relativePath.toLowerCase()))
      const fileName = uniqueItemFileName(`${todayPrefix()}-${slugify(title)}`, existing)
      const backlogDir = await window.api.ensureDir(project.root, 'backlog')
      const newPath = await window.api.createFile(backlogDir, fileName)
      const description = draft.description.trim()
      await window.api.writefile(newPath, description ? `# ${title}\n\n${description}\n` : `# ${title}\n`)
      const relativePath = normalizeRelativePath(`backlog/${fileName}`)
      // Triage rides the item's frontmatter through the validated IPC, into the
      // project the user chose — never a "current" project.
      const triage = await window.api.updateBacklogTriage({
        workspaceRoot: project.root,
        relativePath,
        difficulty: draft.difficulty === 'unset' ? null : draft.difficulty,
        criticality: draft.criticality === 'unset' ? null : draft.criticality,
      })
      if (!triage.ok) throw new Error(triage.message || 'Unable to update Backlog metadata.')
      await refreshSharedBacklogScan(project.root)
      setCreateTarget(null)
      setSelectedKey(rowKeyOf(project.rootKey, relativePath))
    },
    [createTarget, feedByRootKey],
  )

  // ── project-local choice sets (an epic or a prerequisite never crosses a
  //    project, so both are drawn from the row's OWN feed) ───────────────────
  const menuRow = useMemo(
    () => (rowMenu ? itemRows.find((row) => row.key === rowMenu.rowKey) ?? null : null),
    [rowMenu, itemRows],
  )

  const epicChoicesFor = useCallback(
    (feed: BacklogProjectFeed | null): BacklogEpicChoice[] =>
      feed
        ? groupItemsByEpic(feed.items.map((entry) => entry.item))
            .filter((group) => group.kind === 'epic' && group.slug != null)
            .map((group) => ({ slug: group.slug as string, title: group.title, displayId: group.epic?.displayId }))
        : [],
    [],
  )

  const dependencyChoicesFor = useCallback(
    (feed: BacklogProjectFeed | null): BacklogDependencyChoice[] =>
      feed
        ? feed.items
            .map((entry) => entry.item)
            .filter((item) => !item.isEpic)
            .map((item) => ({
              id: item.id,
              slug: backlogItemSlugFromPath(item.relativePath),
              title: item.title,
              displayId: item.displayId,
            }))
        : [],
    [],
  )

  // Module-contributed item actions — "Run a Sprint" above all, which is why
  // this exists: the door listed every project's work and then offered no way to
  // act on it, because it handed the row menu an empty action list. The context
  // is built per ROW, against that row's own project (its root, and the open
  // workspace sitting on that root), so a sprint started from an `MA-…` row is
  // seeded from multiauth's file and not from whichever project was last active.
  const backlogActionContext = useCallback(
    (item: BacklogItem, project: BacklogProjectRef): BacklogItemActionContext | null => {
      // Every feed comes FROM an open workspace, so this resolves in practice;
      // returning null rather than inventing an id keeps a a stale row from
      // launching against a workspace that is no longer there.
      const workspace = workspaces.find(
        (candidate) => candidate.folderPath && workspaceFolderKey(candidate.folderPath) === project.rootKey,
      )
      if (!workspace) return null
      const refresh = async (): Promise<void> => {
        await refreshSharedBacklogScan(project.root)
      }
      const assertOk = (result: { ok: boolean; message?: string }): void => {
        if (!result.ok) throw new Error(result.message || 'That change could not be saved.')
      }
      return {
        workspaceId: workspace.id,
        workspaceRoot: project.root,
        item,
        readSource: () => window.api.readfile(item.path),
        updateStatus: async (status) => {
          assertOk(await window.api.updateBacklogStatus({
            workspaceRoot: project.root,
            relativePath: item.relativePath,
            status,
          }))
          await refresh()
        },
        addLink: async (link) => {
          assertOk(await window.api.addOrUpdateBacklogLink({
            workspaceRoot: project.root,
            relativePath: item.relativePath,
            link,
          }))
          await refresh()
        },
        updateModuleMetadata: async (moduleId, value) => {
          assertOk(await window.api.updateBacklogModuleMetadata({
            workspaceRoot: project.root,
            relativePath: item.relativePath,
            moduleId,
            value,
          }))
          await refresh()
        },
        // The wizard is shell chrome, so the door asks for it through the same
        // seam the rail's "New sprint" uses — now carrying the plan to seed from.
        startSourcePlan: (source) => requestNewSprint(source),
      }
    },
    [workspaces],
  )

  const menuItemActions = useMemo(() => {
    if (!menuRow) return []
    const context = backlogActionContext(menuRow.item, menuRow.project)
    if (!context) return []
    return getRendererHost()
      .getBacklogItemActions()
      .filter((action) => selectModuleEnabled(moduleOverrides, action.moduleId))
      .filter((action) => (action.isVisible ? action.isVisible(context) : true))
      .map((action) => ({
        id: action.id,
        label: action.label,
        disabled: action.getState?.(context) === 'disabled',
        run: () => {
          void Promise.resolve(action.run(context)).catch((error: unknown) => {
            setActionError(error instanceof Error ? error.message : String(error))
          })
        },
      }))
  }, [backlogActionContext, menuRow, moduleOverrides])

  const linkProviders = useMemo<BacklogLinkProvider[]>(
    () => getRendererHost().getBacklogLinkProviders((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )

  // Cross-navigation from the detail pane (a prerequisite, or an item this one
  // blocks). The target may sit outside the active lens or search — a resolved
  // prerequisite under Active, an archived target, anything the query excludes —
  // so selecting blindly would dead-click. Mirror the panel: when the target is
  // not already listed, widen to a lens that contains it and clear the search, so
  // the row and its detail actually come into view.
  const navigateWithinProject = useCallback(
    (feed: BacklogProjectFeed, itemId: string) => {
      const target = feed.items.find((entry) => entry.item.id === itemId)?.item
      if (!target) return
      const key = rowKeyOf(feed.rootKey, itemId)
      if (!itemRows.some((row) => row.key === key)) {
        setSearch('')
        setDoorView({
          view: target.status === 'archived' ? 'archived' : target.status === 'completed' ? 'completed' : 'active',
          // A target in another project is only reachable once its project is in
          // view; dependencies never cross projects, so All always contains it.
          ...(filter !== ALL_PROJECTS && filter !== feed.rootKey ? { projectFilter: ALL_PROJECTS } : {}),
        })
      }
      setSelectedKey(key)
    },
    [itemRows, filter, setDoorView],
  )

  const toggleGroup = useCallback((rootKey: string, group: BacklogEpicGroup) => {
    setCollapsedGroups((prev) => {
      const key = `${rootKey}::${epicGroupKey(group)}`
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // No "New item" in the bar: creating is the rail's New-at-top row, the same
  // affordance in the same place as on every other door. Two of them on one
  // screen would be two answers to one question.
  // The name alone: the rail below counts what is listed, and the project lens
  // that the scope line described is a control in the rail's filter menu.
  const bar: GlobalSurfaceBar = { title: 'Backlog' }

  // The rail: New at top, then search beside the one narrowing glyph (the shared
  // SurfaceRailHeader), then the work list. The list stays this door's own
  // listbox rather than becoming SurfaceRailRows — its rows carry epic identity
  // paint, collapsible epic headers with a progress roll-up, and a project tag
  // that a title + state line cannot hold.
  //
  // Neither the list nor this wrapper scrolls: the host column is the scrollport
  // (the shell's inline aside, or the context-rail column), which is what lets
  // the head above stay stuck to its top.
  const rail = (
    <div className="flex min-w-0 flex-col">
      <SurfaceRailHeader
        newAffordance={{
          label: 'New item',
          onActivate: (anchor) => openCreateFlow(anchor),
          // An item belongs to a project's backlog/ folder. With no project open
          // there is nowhere to put one, and the picker would open empty.
          disabled: projects.length === 0,
        }}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search every project…',
          ariaLabel: 'Search every project’s backlog',
        }}
        filterControl={
          <BacklogFilterMenu
            view={door.view}
            sort={door.sort}
            group={door.group}
            viewItems={VIEW_ITEMS}
            sortItems={SORT_ITEMS}
            groupItems={GROUP_ITEMS}
            onViewChange={(view) => setDoorView({ view })}
            onSortChange={(sort) => setDoorView({ sort })}
            onGroupChange={(group) => setDoorView({ group })}
            project={{
              items: projectFilterItems(projects, list.countsByProject, filter),
              value: filter,
              defaultValue: ALL_PROJECTS,
              onChange: (next) => setDoorView({ projectFilter: next }),
            }}
            className="shrink-0"
          />
        }
      />
      <BacklogDoorList
        rows={renderRows}
        now={now}
        selectedKey={selectedKey}
        showProjectTag={showProjectTag}
        runGlyphByRowKey={runGlyphByRowKey}
        onSelect={setSelectedKey}
        onToggleGroup={toggleGroup}
        onContextMenu={(event, key) => {
          event.preventDefault()
          setRowMenu({ rowKey: key, x: event.clientX, y: event.clientY })
        }}
      />
    </div>
  )

  const detailPane = selectedRow ? (
    <BacklogItemDetailPane
      item={selectedRow.item}
      project={selectedRow.project}
      feed={selectedRow.feed}
      runGlyph={runGlyphByRowKey.get(selectedRow.key)}
      resolveRunGlyph={(item) => runGlyphByRowKey.get(rowKeyOf(selectedRow.feed.rootKey, item.id))}
      now={now}
      actions={actions}
      linkProviders={linkProviders}
      epicChoices={epicChoicesFor(selectedRow.feed)}
      dependencyChoices={dependencyChoicesFor(selectedRow.feed)}
      // The canvas carries no back affordance: the rail's pinned Back row (and
      // Escape) is the one way out of the door, and the rail is always beside
      // this pane rather than replaced by it.
      showBack={false}
      onBack={() => undefined}
      onNavigate={(itemId) => navigateWithinProject(selectedRow.feed, itemId)}
    />
  ) : (
    <div className="flex h-full items-center justify-center px-6 text-meta text-[color:var(--text-muted)]">
      Select an item to preview.
    </div>
  )

  return (
    // The rail is DECLARED, not derived from what the door happens to hold: it is
    // passed in every state, so the projects rail steps aside the moment the door
    // opens rather than once there is something in it. "No projects open",
    // loading, and "nothing matches" are the canvas's to say — with the rail's
    // New row and lens still reachable beside them.
    <GlobalSurfaceShell
      ariaLabel="Backlog"
      bar={bar}
      rail={rail}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        {actionError ? (
          <div className="shrink-0 px-4 pb-2 pt-2">
            <InlineNotice
              tone="error"
              title="That change didn’t go through."
              detail={actionError}
              action={<GhostButton onClick={() => setActionError(null)}>Dismiss</GhostButton>}
            />
          </div>
        ) : null}
        {/* One strip per project whose scan failed: that project is named, and
            every other project's rows stay fully interactive — never an
            all-or-nothing blank page because one folder is unreadable. */}
        {projects
          .filter((feed) => feed.error)
          .map((feed) => (
            <div key={feed.rootKey} className="shrink-0 px-4 pb-2">
              <InlineNotice
                tone="warn"
                title={`Couldn’t read ${feed.projectName}’s backlog.`}
                detail={feed.error}
                action={
                  <GhostButton onClick={() => void refreshSharedBacklogScan(feed.root)}>Try again</GhostButton>
                }
              />
            </div>
          ))}
        {/* min-w-0: the root above is overflow-hidden, so a pane that keeps its
            min-content width does not scroll, it silently loses its right edge. */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {renderCanvas({
            projectCount: projects.length,
            loading,
            total: list.total,
            // True when nothing is listed BECAUSE every project in view failed to
            // scan — a failed dependency must never read as "you have no work".
            allVisibleFailed: visibleFeeds.length > 0 && visibleFeeds.every((feed) => Boolean(feed.error)),
            detailPane,
          })}
        </div>
      </div>
      {createTarget ? (
        <BacklogCreateDialog
          difficultyItems={DIFFICULTY_EDIT_ITEMS}
          criticalityItems={CRITICALITY_EDIT_ITEMS}
          onClose={() => setCreateTarget(null)}
          onCreate={submitCreate}
        />
      ) : null}
      {createPicker ? (
        <ContextMenu
          x={createPicker.x}
          y={createPicker.y}
          ariaLabel="Choose a project for the new item"
          onClose={() => setCreatePicker(null)}
          surfaceClassName="min-w-[220px]"
        >
          {projects.map((feed) => (
            <MenuItem
              key={feed.rootKey}
              onClick={() => {
                setCreatePicker(null)
                setCreateTarget(projectOfFeed(feed))
              }}
            >
              {feed.projectName}
            </MenuItem>
          ))}
        </ContextMenu>
      ) : null}
      {rowMenu && menuRow ? (
        <BacklogItemContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          item={menuRow.item}
          actions={actions}
          epicChoices={epicChoicesFor(menuRow.feed)}
          dependencyChoices={dependencyChoicesFor(menuRow.feed)}
          itemActions={menuItemActions}
          agentTargets={[]}
          agentSessions={null}
          onFlyoutOpen={() => {}}
          onSendToAgent={() => {}}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </GlobalSurfaceShell>
  )
}

// The canvas: the shared door states for the pristine/empty cases, else the
// selected item's detail. A refresh never re-enters loading. Every one of these
// states renders INSIDE the door, beside the door's own rail — a door that fell
// back to the projects sidebar until it had content is the gap T19 closed.
function renderCanvas({
  projectCount,
  loading,
  total,
  allVisibleFailed,
  detailPane,
}: {
  projectCount: number
  loading: boolean
  total: number
  allVisibleFailed: boolean
  detailPane: React.ReactNode
}): JSX.Element {
  if (projectCount === 0) {
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph="≡"
        title="No projects open"
        body="The Backlog collects work from every project you have open. Open a project and its items appear here."
      />
    )
  }
  if (loading) return <SurfaceCanvasState kind="loading" label="Reading your backlogs…" />
  if (total === 0 && allVisibleFailed) {
    // The list is empty because the scan failed, not because there is no work.
    // The per-project strips above name which project and offer Try again, so
    // this states the cause instead of inviting a misread "New item".
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph="≡"
        title="This backlog couldn’t be read"
        body="Nothing can be listed until the folder above is readable again. Your items are untouched."
      />
    )
  }
  if (total === 0) {
    // No CTA here: the rail beside this state already carries "New item" at its
    // top, and the lens that narrowed the list to nothing right under it.
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph="≡"
        title="Nothing matches this view"
        body="No items in the selected projects match the current lens and search."
      />
    )
  }
  return <div className="min-h-0 min-w-0 flex-1">{detailPane}</div>
}

// ── the project lens ────────────────────────────────────────────────────────
// One compact axis instead of a chip per project (MC-1837): the wall of chips
// wrapped to two lines and listed zero-count projects as noise. Counts ride the
// options so switching projects is an informed choice, not a guess. A healthy
// project with nothing in the current lens is omitted (selecting it could only
// show an empty list) — unless it IS the current filter, so the trigger never
// shows an unknown value. A failed project stays listed with the warn tone:
// unreadable must remain reachable, never invisible.
//
// It rides inside the rail's filter glyph, which is where the Sprints door puts
// the same control under the same name (MC-1816), so a person moving between the
// two doors never hunts for it.
function projectFilterItems(
  projects: ReadonlyArray<BacklogProjectFeed>,
  counts: ReadonlyMap<string, number>,
  filter: string,
): SelectItem<string>[] {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  return [
    { value: ALL_PROJECTS, label: `All projects · ${total}` },
    ...projects
      .filter(
        (feed) =>
          Boolean(feed.error) || (counts.get(feed.rootKey) ?? 0) > 0 || filter === feed.rootKey,
      )
      .map((feed) => ({
        value: feed.rootKey,
        label: feed.error
          ? `${feed.projectName} · unavailable`
          : `${feed.projectName} · ${counts.get(feed.rootKey) ?? 0}`,
        tone: feed.error ? ('warn' as const) : undefined,
      })),
  ]
}

// ── list ────────────────────────────────────────────────────────────────────
function BacklogDoorList({
  rows,
  now,
  selectedKey,
  showProjectTag,
  runGlyphByRowKey,
  onSelect,
  onToggleGroup,
  onContextMenu,
}: {
  rows: ReadonlyArray<DoorRenderRow>
  now: number
  selectedKey: string | null
  showProjectTag: boolean
  runGlyphByRowKey: ReadonlyMap<string, BacklogRunGlyph>
  onSelect: (key: string) => void
  onToggleGroup: (rootKey: string, group: BacklogEpicGroup) => void
  onContextMenu: (event: React.MouseEvent, rowKey: string) => void
}): JSX.Element {
  // Both epic headers and item rows are navigable options: the group-header
  // chevron is deliberately out of the tab order (the listbox owns roving focus
  // via aria-activedescendant), so Enter/← /→ on the cursor is the ONLY keyboard
  // path to collapse a group — exactly how the per-project panel behaves.
  const navRows = rows.filter(
    (row): row is Exclude<DoorRenderRow, { kind: 'project' }> => row.kind !== 'project',
  )
  const activeIndex = selectedKey ? navRows.findIndex((row) => row.key === selectedKey) : -1

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (navRows.length === 0) return
    const cursor = activeIndex >= 0 ? navRows[activeIndex] : undefined
    if (event.key === 'ArrowDown' || event.key === 'j' || event.key === 'ArrowUp' || event.key === 'k') {
      const next = event.key === 'ArrowDown' || event.key === 'j'
      event.preventDefault()
      const index =
        activeIndex < 0 ? 0 : next ? Math.min(activeIndex + 1, navRows.length - 1) : Math.max(activeIndex - 1, 0)
      onSelect(navRows[index].key)
      return
    }
    if (!cursor || cursor.kind !== 'header') return
    // On a group header the primary action is collapse/expand.
    if (event.key === 'Enter' || (event.key === 'ArrowRight' && cursor.collapsed) || (event.key === 'ArrowLeft' && !cursor.collapsed)) {
      event.preventDefault()
      onToggleGroup(cursor.feed.rootKey, cursor.group)
    }
  }

  return (
    <ul
      role="listbox"
      aria-label="Backlog items across projects"
      // This door's leading list, so it takes the selection tier the same way
      // every other door rail does (surfaceSubstrate; "Selection tiers" in
      // assets/index.css). `primary`, so the row holds its full-strength
      // selection while focus sits in the toolbar or the detail pane and rests
      // only once another pane takes it. The attribute belongs on the element
      // holding the `li` that carries aria-selected — the tokens rebind there.
      data-selection-pane="primary"
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={activeIndex >= 0 ? `backlog-door-opt-${activeIndex}` : undefined}
      // No scrollport of its own: the column hosting the rail is the scrollport,
      // which is what keeps the rail's head stuck to its top. Full-bleed
      // (`-mx-2.5` cancels that column's padding) because a Backlog row's 3px
      // identity bar is an edge gutter — it reads as one only against the edge,
      // and it is the same paint the per-project panel draws.
      className="-mx-2.5 min-w-0 outline-none focus-visible:focus-ring-inset"
    >
      {rows.map((row) => {
        if (row.kind === 'project') {
          return (
            <li
              key={row.key}
              role="presentation"
              className="px-3 pb-1 pt-2.5 text-micro font-semibold text-[color:var(--text-subtle)]"
            >
              {row.project.name}
              <span className="pl-1.5 font-normal tabular-nums text-[color:var(--text-disabled)]">{row.count}</span>
            </li>
          )
        }
        if (row.kind === 'header') {
          const headerIndex = navRows.findIndex((candidate) => candidate.key === row.key)
          return (
            <li
              key={row.key}
              id={`backlog-door-opt-${headerIndex}`}
              role="option"
              aria-selected={row.key === selectedKey}
              // A group header is a Backlog row like any other: selection is the
              // neutral fill, and the epic's hue stays in the bar. It used to
              // paint --accent-primary-soft, which spent the brand accent on
              // being chosen — the violation T4 removed everywhere else.
              className={`cursor-pointer border-l-[3px] px-3 py-1.5 transition-colors ${backlogRowPaintClass({
                color: row.group.color,
                litFill: false,
                selected: row.key === selectedKey,
              })}`}
              onClick={() => {
                onSelect(row.key)
                onToggleGroup(row.feed.rootKey, row.group)
              }}
            >
              <BacklogEpicHeaderContent
                group={row.group}
                collapsed={row.collapsed}
                selected={row.key === selectedKey}
                onToggleCollapse={() => onToggleGroup(row.feed.rootKey, row.group)}
                progress={row.group.slug ? row.feed.derived.epicProgressBySlug.get(row.group.slug) : undefined}
                dependencyState={
                  row.group.epic ? row.feed.derived.dependencyStateById.get(row.group.epic.id) ?? null : null
                }
                blockedRollup={row.group.slug ? row.feed.derived.epicBlockedBySlug.get(row.group.slug) : undefined}
              />
            </li>
          )
        }
        const { item, feed, project, indented } = row
        const index = navRows.findIndex((candidate) => candidate.key === row.key)
        const selected = row.key === selectedKey
        const epicMeta = item.isEpic
          ? feed.derived.epicMetaBySlug.get(epicSlug(item))
          : item.epic
            ? feed.derived.epicMetaBySlug.get(item.epic)
            : undefined
        const dependencyState = feed.derived.dependencyStateById.get(item.id) ?? null
        const epicProgress = item.isEpic ? feed.derived.epicProgressBySlug.get(epicSlug(item)) : undefined
        const runGlyph = runGlyphByRowKey.get(row.key)
        const { color, litFill } = resolveBacklogRowColor(item, epicMeta?.color ?? null)
        return (
          <li
            key={row.key}
            id={`backlog-door-opt-${index}`}
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(row.key)}
            onContextMenu={(event) => onContextMenu(event, row.key)}
            className={`cursor-pointer border-l-[3px] ${indented ? 'pl-6 pr-3' : 'px-3'} py-1.5 transition-colors ${
              backlogRowPaintClass({ color, litFill, selected })
            } ${item.status === 'archived' ? 'opacity-70' : ''}`}
          >
            <Tooltip
              content={
                <BacklogRowHoverCard
                  item={item}
                  runGlyph={runGlyph}
                  epicProgress={epicProgress}
                  dependencyState={dependencyState}
                  // Which backlog this row lives in. It rides the hover card
                  // rather than the row: on an all-projects list the name
                  // repeats down every row, and a column of the same word
                  // crowds the title without telling anyone anything.
                  projectName={showProjectTag ? project.name : undefined}
                />
              }
              placement="top"
              openDelayMs={600}
              wrapperClassName="block"
              wrapperRole="presentation"
            >
              <BacklogRowContent
                item={item}
                now={now}
                runGlyph={runGlyph}
                dependencyState={dependencyState}
                epicBlocked={item.isEpic ? feed.derived.epicBlockedBySlug.get(epicSlug(item)) : undefined}
                epicMeta={indented ? undefined : epicMeta}
                epicProgress={epicProgress}
                plainTitle
                selected={selected}
              />
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

// ── local helpers ───────────────────────────────────────────────────────────

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}

function todayPrefix(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Collision-safe new-item filename within the target project's backlog/.
function uniqueItemFileName(baseName: string, existingRelativeLower: ReadonlySet<string>): string {
  let candidate = `${baseName}.md`
  let index = 2
  while (existingRelativeLower.has(`backlog/${candidate}`.toLowerCase())) {
    candidate = `${baseName}-${index}.md`
    index += 1
  }
  return candidate
}

