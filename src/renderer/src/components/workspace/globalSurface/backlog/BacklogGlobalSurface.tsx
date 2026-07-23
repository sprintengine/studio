import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  ContextMenu,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  MenuItem,
  PrimaryButton,
  Tooltip,
  useConfirmDialog,
  type SelectItem,
} from '../../../ui'
import { GlobalSurfaceShell, type GlobalSurfaceBar } from '../GlobalSurfaceShell'
import { SurfaceCanvasState } from '../surfaceSubstrate'
import { useSurfaceBackNav } from '../surfaceBackNav'
import {
  useAllProjectsBacklog,
  type BacklogProjectFeed,
  type BacklogProjectRef,
} from '../../../../hooks/useAllProjectsBacklog'
import { refreshSharedBacklogScan } from '../../../../hooks/useSharedBacklogScan'
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
import { deriveBacklogDependencies } from '../../../../utils/backlogDependencies'
import {
  matchWorkspaceForBacklogRunLink,
  sprintEngineRunLinkForItem,
} from '../../../../utils/sprintengineBacklogLinks'
import { deriveSprintEngineRunGlyph } from '../../../../utils/sprintengine'
import { getHighlightSwatch } from '../../../../utils/highlight'
import { resolveFirstMockupCandidate } from '../../../../utils/backlogMockups'
import { FilePreviewPane } from '../../../ui/FilePreviewPane'
import { HtmlArtifactFrame } from '../../guidedBrief/MockupPreviewPane'
import { basename, joinFilePath, parentPath } from '../../../../utils/paths'
import { focusOrAddFileTab } from '../../../../utils/modelRegistry'
import { getRendererHost, selectModuleEnabled } from '../../../../modules'
import type { BacklogLinkProvider } from '../../../../modules/renderer-host'
import { BacklogFilterMenu } from '../../../backlog/BacklogFilterMenu'
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
import { BacklogDetail } from '../../../panels/BacklogPanel'
import { ALL_PROJECTS, buildBacklogDoorList } from './backlogSurfaceModel'
import { createBacklogDoorActions, type BacklogDoorMutationApi } from './backlogDoorActions'

// The Backlog door (T9, mockup §4) — one full page listing the backlog of EVERY
// open project, with project filter chips that narrow it. Selecting a single
// project is exactly today's per-project panel (same visible set, same order —
// proved by the golden test on `backlogSurfaceModel`); "All projects" is the
// merged cross-project list where every row carries its project tag.
//
// Storage does not move: items stay as markdown in each project's own backlog/
// folder. This is read-time aggregation over the SAME shared scan a panel uses
// (a project with an open panel is not scanned twice), and every mutation routes
// back to the row's OWN project through the validated backlog IPC — see
// `backlogDoorActions`. The per-project BacklogPanel is untouched.

// Below this width the list + detail split is cramped, so the page collapses to
// a single column (list, then a full-width detail with Back) — the panel's rule.
const SPLIT_MIN_WIDTH = 720

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
  const [showDetailInSingle, setShowDetailInSingle] = useState(false)
  const newItemRef = useRef<HTMLButtonElement | null>(null)

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
    if (!stillPresent) {
      setSelectedKey(null)
      setShowDetailInSingle(false)
    }
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

  const openCreateFlow = useCallback(() => {
    setActionError(null)
    const single =
      filter !== ALL_PROJECTS ? feedByRootKey.get(filter) : projects.length === 1 ? projects[0] : null
    if (single) {
      setCreateTarget(projectOfFeed(single))
      return
    }
    // Several projects in view: ask which one the item belongs to rather than
    // silently choosing — a new item in the wrong project is invisible work.
    const rect = newItemRef.current?.getBoundingClientRect()
    setCreatePicker({ x: rect?.left ?? 24, y: rect?.bottom ?? 64 })
  }, [filter, feedByRootKey, projects, projectOfFeed])

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

  const linkProviders = useMemo<BacklogLinkProvider[]>(
    () => getRendererHost().getBacklogLinkProviders((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )

  // Responsive split, measured from the page's own width.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [isSplit, setIsSplit] = useState(true)
  useEffect(() => {
    const node = rootRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      setIsSplit((entries[0]?.contentRect.width ?? node.clientWidth) >= SPLIT_MIN_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const selectRow = useCallback((key: string) => {
    setSelectedKey(key)
    setShowDetailInSingle(true)
  }, [])

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
      selectRow(key)
    },
    [itemRows, filter, setDoorView, selectRow],
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

  const bar: GlobalSurfaceBar = {
    title: 'Backlog',
    contextSub: describeScope(projects, filter, list.total, door.view),
    actions: (
      <PrimaryButton ref={newItemRef} onClick={openCreateFlow} disabled={projects.length === 0}>
        New item
      </PrimaryButton>
    ),
  }

  const listPane = (
    <BacklogDoorList
      rows={renderRows}
      now={now}
      selectedKey={selectedKey}
      showProjectTag={showProjectTag}
      runGlyphByRowKey={runGlyphByRowKey}
      onSelect={selectRow}
      onToggleGroup={toggleGroup}
      onContextMenu={(event, key) => {
        event.preventDefault()
        setRowMenu({ rowKey: key, x: event.clientX, y: event.clientY })
      }}
    />
  )

  const detailPane = selectedRow ? (
    <BacklogDoorDetail
      item={selectedRow.item}
      project={selectedRow.project}
      feed={selectedRow.feed}
      runGlyph={runGlyphByRowKey.get(selectedRow.key)}
      runGlyphByRowKey={runGlyphByRowKey}
      now={now}
      actions={actions}
      linkProviders={linkProviders}
      epicChoices={epicChoicesFor(selectedRow.feed)}
      dependencyChoices={dependencyChoicesFor(selectedRow.feed)}
      showBack={!isSplit}
      onBack={() => setShowDetailInSingle(false)}
      onNavigate={(itemId) => navigateWithinProject(selectedRow.feed, itemId)}
    />
  ) : (
    <div className="flex h-full items-center justify-center px-6 text-[12px] text-[color:var(--text-muted)]">
      Select an item to preview.
    </div>
  )

  return (
    <GlobalSurfaceShell ariaLabel="Backlog" bar={bar} onBack={back.onBack} canGoBack={back.canGoBack}>
      <div ref={rootRef} className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <BacklogDoorToolbar
          projects={projects}
          filter={filter}
          counts={list.countsByProject}
          view={door.view}
          sort={door.sort}
          group={door.group}
          search={search}
          onFilter={(next) => setDoorView({ projectFilter: next })}
          onSearch={setSearch}
          onViewChange={(view) => setDoorView({ view })}
          onSortChange={(sort) => setDoorView({ sort })}
          onGroupChange={(group) => setDoorView({ group })}
        />
        {actionError ? (
          <div className="shrink-0 px-4 pb-2">
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
        <div className="flex min-h-0 flex-1">
          {renderBody({
            projectCount: projects.length,
            loading,
            total: list.total,
            // True when nothing is listed BECAUSE every project in view failed to
            // scan — a failed dependency must never read as "you have no work".
            allVisibleFailed: visibleFeeds.length > 0 && visibleFeeds.every((feed) => Boolean(feed.error)),
            isSplit,
            showDetailInSingle,
            hasSelection: Boolean(selectedRow),
            listPane,
            detailPane,
            onNewItem: openCreateFlow,
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
          itemActions={[]}
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

// The canvas body: the shared door states for the pristine/empty cases, else the
// list (+ detail) split. A refresh never re-enters loading.
function renderBody({
  projectCount,
  loading,
  total,
  allVisibleFailed,
  isSplit,
  showDetailInSingle,
  hasSelection,
  listPane,
  detailPane,
  onNewItem,
}: {
  projectCount: number
  loading: boolean
  total: number
  allVisibleFailed: boolean
  isSplit: boolean
  showDetailInSingle: boolean
  hasSelection: boolean
  listPane: React.ReactNode
  detailPane: React.ReactNode
  onNewItem: () => void
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
    return (
      <SurfaceCanvasState
        kind="empty"
        glyph="≡"
        title="Nothing matches this view"
        body="No items in the selected projects match the current lens and search."
        action={<PrimaryButton onClick={onNewItem}>New item</PrimaryButton>}
      />
    )
  }
  if (!isSplit) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {showDetailInSingle && hasSelection ? detailPane : listPane}
      </div>
    )
  }
  return (
    <>
      <div className="flex min-h-0 w-[44%] max-w-[460px] flex-col border-r border-[color:var(--border-subtle)]">
        {listPane}
      </div>
      <div className="min-h-0 flex-1">{detailPane}</div>
    </>
  )
}

// ── toolbar ─────────────────────────────────────────────────────────────────
// Mockup §4: project chips lead (All projects, then one per project), the lens
// controls hold the right. Counts ride the chips so switching projects is an
// informed choice, not a guess.
function BacklogDoorToolbar({
  projects,
  filter,
  counts,
  view,
  sort,
  group,
  search,
  onFilter,
  onSearch,
  onViewChange,
  onSortChange,
  onGroupChange,
}: {
  projects: ReadonlyArray<BacklogProjectFeed>
  filter: string
  counts: ReadonlyMap<string, number>
  view: BacklogView
  sort: BacklogSort
  group: BacklogGroup
  search: string
  onFilter: (next: string) => void
  onSearch: (next: string) => void
  onViewChange: (next: BacklogView) => void
  onSortChange: (next: BacklogSort) => void
  onGroupChange: (next: BacklogGroup) => void
}): JSX.Element {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5">
      <div role="group" aria-label="Filter by project" className="flex flex-wrap items-center gap-1">
        <FilterChip
          label="All projects"
          count={total}
          selected={filter === ALL_PROJECTS}
          onClick={() => onFilter(ALL_PROJECTS)}
        />
        {projects.map((feed) => (
          <FilterChip
            key={feed.rootKey}
            label={feed.projectName}
            count={counts.get(feed.rootKey) ?? 0}
            selected={filter === feed.rootKey}
            failed={Boolean(feed.error)}
            onClick={() => onFilter(feed.rootKey)}
          />
        ))}
      </div>
      <div className="ml-auto flex min-w-[220px] max-w-[380px] flex-1 items-center gap-1.5">
        <InboxSearchInput
          value={search}
          onChange={onSearch}
          ariaLabel="Search every project’s backlog"
          placeholder="Search every project…"
        />
        <BacklogFilterMenu
          view={view}
          sort={sort}
          group={group}
          viewItems={VIEW_ITEMS}
          sortItems={SORT_ITEMS}
          groupItems={GROUP_ITEMS}
          onViewChange={onViewChange}
          onSortChange={onSortChange}
          onGroupChange={onGroupChange}
          className="shrink-0"
        />
      </div>
    </div>
  )
}

function FilterChip({
  label,
  count,
  selected,
  failed,
  onClick,
}: {
  label: string
  count: number
  selected: boolean
  failed?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex max-w-[16ch] items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors ${
        selected
          ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
          : 'border-[color:var(--border-default)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-[color:var(--text-subtle)]">{count}</span>
      {failed ? (
        <Tooltip content="This project’s backlog couldn’t be read." placement="top">
          <span aria-label="Backlog unavailable" className="shrink-0 text-[color:var(--tone-warn)]">
            !
          </span>
        </Tooltip>
      ) : null}
    </button>
  )
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
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-activedescendant={activeIndex >= 0 ? `backlog-door-opt-${activeIndex}` : undefined}
      className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--border-focus)]"
    >
      {rows.map((row) => {
        if (row.kind === 'project') {
          return (
            <li
              key={row.key}
              role="presentation"
              className="px-3 pb-1 pt-2.5 text-[11px] font-semibold text-[color:var(--text-subtle)]"
            >
              {row.project.name}
              <span className="pl-1.5 font-normal tabular-nums text-[color:var(--text-disabled)]">{row.count}</span>
            </li>
          )
        }
        if (row.kind === 'header') {
          const swatch = row.group.color ? getHighlightSwatch(row.group.color) : null
          const headerIndex = navRows.findIndex((candidate) => candidate.key === row.key)
          return (
            <li
              key={row.key}
              id={`backlog-door-opt-${headerIndex}`}
              role="option"
              aria-selected={row.key === selectedKey}
              className={`cursor-pointer border-l-[3px] px-3 py-1.5 transition-colors ${
                row.key === selectedKey ? 'bg-[color:var(--accent-primary-soft)]' : 'hover:bg-[color:var(--bg-hover)]'
              } ${swatch ? swatch.border : 'border-l-transparent'}`}
              onClick={() => {
                onSelect(row.key)
                onToggleGroup(row.feed.rootKey, row.group)
              }}
            >
              <BacklogEpicHeaderContent
                group={row.group}
                collapsed={row.collapsed}
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
        const swatch = color ? getHighlightSwatch(color) : null
        return (
          <li
            key={row.key}
            id={`backlog-door-opt-${index}`}
            role="option"
            aria-selected={selected}
            onClick={() => onSelect(row.key)}
            onContextMenu={(event) => onContextMenu(event, row.key)}
            className={`cursor-pointer border-l-[3px] ${indented ? 'pl-6 pr-3' : 'px-3'} py-1.5 transition-colors ${
              selected
                ? `${swatch ? swatch.border : 'border-l-[color:var(--accent-primary)]'} ${litFill && swatch ? swatch.bg : 'bg-[color:var(--accent-primary-soft)]'} ${indented ? 'pl-[21px]' : 'pl-[9px]'}`
                : `${swatch ? `${swatch.border}${litFill ? ` ${swatch.dimBg}` : ''}` : 'border-l-transparent'} hover:bg-[color:var(--bg-hover)]`
            } ${item.status === 'archived' ? 'opacity-70' : ''}`}
          >
            <Tooltip
              content={
                <BacklogRowHoverCard
                  item={item}
                  runGlyph={runGlyph}
                  epicProgress={epicProgress}
                  dependencyState={dependencyState}
                />
              }
              placement="top"
              openDelayMs={600}
              wrapperClassName="block"
              wrapperRole="presentation"
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <BacklogRowContent
                    item={item}
                    now={now}
                    runGlyph={runGlyph}
                    dependencyState={dependencyState}
                    epicBlocked={item.isEpic ? feed.derived.epicBlockedBySlug.get(epicSlug(item)) : undefined}
                    epicMeta={indented ? undefined : epicMeta}
                    epicProgress={epicProgress}
                    plainTitle
                  />
                </div>
                {/* The project tag: which backlog this row actually lives in.
                    Plain mono text, never a tinted pill — the row already has
                    exactly one status idiom (the lifecycle glyph). */}
                {showProjectTag ? (
                  <span className="max-w-[12ch] shrink-0 truncate pl-1 font-mono text-[10.5px] text-[color:var(--text-subtle)]">
                    {project.name}
                  </span>
                ) : null}
              </div>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

// ── detail ──────────────────────────────────────────────────────────────────
// The door renders the WORKSPACE panel's BacklogDetail (MC-1836) — one detail
// implementation, so an epic's crumb, linked-children roll-up, triage, and body
// can never drift between the aside and the door. This adapter maps the door's
// per-project feed onto the panel's props and degrades the workspace-only
// inputs explicitly:
//   • scan/loading — an item is always selected here, so the panel's pre-scan
//     early returns are unreachable (scan: null, loading: false).
//   • agent send — no per-workspace agent roster at the door; the flyout shows
//     its own "No running agents" state.
//   • external actions — workspace-launch actions stay on the panel for now.
//   • mockup preview — hosted here (the panel lifts it to its parent the same
//     way); pop-out needs a workspace editor tab, so the door's preview keeps
//     its own back/close-only chrome.
function BacklogDoorDetail({
  item,
  project,
  feed,
  runGlyph,
  runGlyphByRowKey,
  now,
  actions,
  linkProviders,
  epicChoices,
  dependencyChoices,
  showBack,
  onBack,
  onNavigate,
}: {
  item: BacklogItem
  project: BacklogProjectRef
  feed: BacklogProjectFeed
  runGlyph?: BacklogRunGlyph
  runGlyphByRowKey: ReadonlyMap<string, BacklogRunGlyph>
  now: number
  actions: ReturnType<typeof createBacklogDoorActions>
  linkProviders: ReadonlyArray<BacklogLinkProvider>
  epicChoices: BacklogEpicChoice[]
  dependencyChoices: BacklogDependencyChoice[]
  showBack: boolean
  onBack: () => void
  onNavigate: (itemId: string) => void
}): JSX.Element {
  // Inline mockup preview: clicking an attached/detected mockup swaps this pane
  // for the rendered file (the panel's behaviour). Resolution re-runs across BOTH
  // tolerated roots from the authored ref, and a missing/unreadable file leaves
  // the preview closed rather than opening an empty frame.
  const [previewedMockup, setPreviewedMockup] = useState<{
    relativePath: string
    absolutePath: string
    content: string
  } | null>(null)
  useEffect(() => setPreviewedMockup(null), [item.id, project.rootKey])

  const openMockup = useCallback(
    (target: { path: string }) => {
      void (async () => {
        const found = await resolveFirstMockupCandidate(target.path, async (relativePath) => {
          const absolutePath = joinFilePath(project.root, relativePath)
          if (!(await window.api.pathExists(absolutePath))) return null
          return { relativePath, absolutePath, content: await window.api.readfile(absolutePath) }
        })
        if (found) setPreviewedMockup(found)
      })()
    },
    [project.root],
  )

  // This project's items and derivations, in the shapes the panel reads. The
  // dependency node comes from the item's OWN project — a prerequisite never
  // crosses a project boundary.
  const projectItems = useMemo(() => feed.items.map((entry) => entry.item), [feed])
  const dependencyNode = useMemo(() => {
    if (item.isEpic) return null
    const graph = deriveBacklogDependencies(projectItems)
    return graph.nodes.find((candidate) => candidate.item.id === item.id) ?? null
  }, [projectItems, item])
  const runGlyphById = useMemo(() => {
    const map = new Map<string, BacklogRunGlyph>()
    for (const entry of feed.items) {
      const glyph = runGlyphByRowKey.get(rowKeyOf(feed.rootKey, entry.item.id))
      if (glyph) map.set(entry.item.id, glyph)
    }
    return map
  }, [feed, runGlyphByRowKey])

  // A workspace already open on this project, for the link providers that
  // resolve a linked run's live state. The empty-string sentinel degrades the
  // workspace-only lookups instead of hiding the whole Links section.
  const workspaceId = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.folderPath === project.root)?.id ?? null,
  )

  // Every hook above runs unconditionally — this early return must stay BELOW
  // them so the preview opening/closing never changes the hook order.
  if (previewedMockup) {
    const isHtml = /\.html?$/i.test(previewedMockup.relativePath)
    return (
      <FilePreviewPane
        title={basename(previewedMockup.relativePath)}
        path={previewedMockup.absolutePath}
        content={previewedMockup.content}
        onBack={() => setPreviewedMockup(null)}
        onClose={() => setPreviewedMockup(null)}
        body={
          isHtml ? (
            <HtmlArtifactFrame
              absolutePath={previewedMockup.absolutePath}
              relativePath={previewedMockup.relativePath}
              watchDirectoryPath={parentPath(previewedMockup.absolutePath)}
              enableSourceView
            />
          ) : undefined
        }
      />
    )
  }

  return (
    <BacklogDetail
      scan={null}
      loading={false}
      folderPath={project.root}
      selected={item}
      selectedRunGlyph={runGlyph}
      runGlyphById={runGlyphById}
      now={now}
      hasItems
      externalActions={[]}
      workspaceId={workspaceId ?? ''}
      linkProviders={linkProviders}
      showBack={showBack}
      onBack={onBack}
      actions={actions}
      epicChoices={epicChoices}
      items={projectItems}
      epicMetaBySlug={feed.derived.epicMetaBySlug}
      dependencyNode={dependencyNode}
      dependencyState={feed.derived.dependencyStateById.get(item.id) ?? null}
      dependencyStateById={feed.derived.dependencyStateById}
      epicBlockedRollup={item.isEpic ? feed.derived.epicBlockedBySlug.get(epicSlug(item)) : undefined}
      dependencyChoices={dependencyChoices}
      onNavigate={onNavigate}
      agentTargets={[]}
      agentSessions={null}
      onAgentFlyoutOpen={() => {}}
      onSendToAgent={() => {}}
      previewedMockup={null}
      onOpenMockup={openMockup}
      onCloseMockupPreview={() => {}}
      onPopOutMockup={() => {}}
    />
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

// "3 projects · 214 active items" (mockup §4 bar sub-line). The scope names what
// is ACTUALLY listed: with one project filtered it names that project, so the bar
// can never claim "3 projects" beside a count that covers only one of them (the
// filter chips show the same number for that project).
function describeScope(
  projects: ReadonlyArray<BacklogProjectFeed>,
  filter: string,
  itemCount: number,
  view: BacklogView,
): string {
  const scope = view === 'active' ? 'active ' : ''
  const items = `${itemCount} ${scope}${itemCount === 1 ? 'item' : 'items'}`
  if (filter !== ALL_PROJECTS) {
    const named = projects.find((feed) => feed.rootKey === filter)
    if (named) return `${named.projectName} · ${items}`
  }
  return `${projects.length} ${projects.length === 1 ? 'project' : 'projects'} · ${items}`
}
