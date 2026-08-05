// The New sprint dialog (MC-2062): starting a sprint is ONE light dialog shaped
// like New chat — project chip in the header, the shared Backlog list on the
// left, what-this-sprint-is on the right, Start bottom-right — with the roster
// editor as a second SCREEN, never a nested modal. Build-to-it mockup:
// prototypes/2026-07-31-new-sprint-dialog.html (it offers no variants; what it
// shows IS the design).
//
// Reused, never rebuilt: PanelHeader + InboxSearchInput + BacklogFilterMenu +
// BacklogRowContent + epic group headers on the left; RosterMenu as the team
// control; PlainAgentsPanel for "No roles"; RosterEditor (MC-2065) behind
// screen 2; the existing sourceBundle seam for seeding and launch. This dialog
// is the app's only aria-modal while it is open — screen 2 swaps the body
// inside it, which is why RosterEditor is mounted bare rather than through
// RosterManagerModal. The one exception is the transient New-item capture
// (BacklogCreateDialog, the same affordance every Backlog surface opens): it
// stacks above the dialog for the moment it exists and takes Escape first.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useBacklogScan } from '../newWorkspace/useBacklogScan'
import { useRosterEditor } from '../newWorkspace/useRosterEditor'
import { selectAgentCliCatalog } from '../newWorkspace/cliRuntimeOptions'
import {
  isNoRolesRosterRef,
  NO_ROLES_ROSTER_ID,
  sprintEngineLaunchRoleCounts,
} from '../newWorkspace/savedRosters'
import {
  buildSprintEngineEffectiveSpawnAtStartRoles,
  runSprintEnginePlanSourcedCreation,
} from '../newWorkspace/controllers/sprintEngineController'
import {
  consumeSprintCreationDoorClaim,
  noteSprintDoorSelection,
} from '../globalSurface/sprints/sprintDoorRequests'
import { inferSourcePlanKind, markdownTitle, workspaceRelativePath } from '../newWorkspace/helpers'
import {
  PlainAgentsPanel,
  PlanningAgentRowView,
  type PlanningAgentRow,
} from '../newWorkspace/PlainAgentsPanel'
import type { SprintEngineCliOption } from '../newWorkspace/SprintEngineRosterTable'
import { RosterEditor } from '../../backlog/RosterEditor'
import { RosterMenu } from '../../backlog/RosterMenu'
import { BacklogFilterMenu } from '../../backlog/BacklogFilterMenu'
import {
  CRITICALITY_EDIT_ITEMS,
  DIFFICULTY_EDIT_ITEMS,
} from '../../backlog/BacklogItemContextMenu'
import { BacklogCreateDialog, type BacklogDraft } from '../../panels/BacklogCreateDialog'
import {
  BacklogEpicHeaderContent,
  BacklogRowContent,
  EpicColorDot,
} from '../../backlog/BacklogRow'
import { backlogRowPaintClass } from '../../backlog/backlogRowPaint'
import { matchesBacklogQuery } from '../globalSurface/backlog/backlogSurfaceModel'
import {
  CloseIconButton,
  GhostButton,
  IconButton,
  InboxSearchInput,
  INLINE_TITLE_EDIT_CLASS,
  InlineNotice,
  OverflowMenu,
  PanelHeader,
  Popover,
  PrimaryButton,
  RefreshIcon,
  RoleAvatar,
  Tooltip,
  type SelectItem,
} from '../../ui'
import { Modal } from '../../ui/Modal'
import { CheckIcon } from '../../AppIcons'
import {
  compareBacklogItems,
  matchesBacklogView,
  resolveBacklogRowColor,
  type BacklogGroup,
  type BacklogSort,
  type BacklogView,
} from '../../../utils/backlogTriage'
import { deriveBacklogDependencies } from '../../../utils/backlogDependencies'
import {
  CLOSED_EPIC_CHILD_STATUSES,
  childrenOfEpic,
  epicImportCounts,
  epicSlug,
  groupItemsByEpic,
  isBacklogEpicPath,
  type BacklogEpicGroup,
} from '../../../utils/backlogEpics'
import { isRoadmapContent } from '../../../../../shared/backlog/roadmap'
import {
  SPRINT_ENGINE_ROLELESS_KEY,
  getSprintEngineRoleLabel,
  sprintEngineCoordinatorSeatForRoleCounts,
} from '../../../utils/sprintengine'
import { listSprintEngineWizardRoles } from '../../../utils/sprintengineRoleOptions'
import {
  mockupSourceDocFromMarkdown,
  resolveSprintEngineMockupBundleItems,
} from '../../../utils/sprintengineMockupSources'
import { buildSprintEngineRunLink } from '../../../utils/sprintengineBacklogLinks'
import { basename } from '../../../utils/paths'
import { slugifySprintEngineName } from '../../../utils/sprintengineStateFile'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../store/slices/settingsSlice'
import { normalizeRelativePath, type BacklogItem } from '../../../utils/backlog'
import type {
  FuturePlanWorkspaceSource,
  SprintEngineRoleId,
  WorkspaceWindowId,
} from '../../../types/workspace'
import {
  buildNewSprintSource,
  deriveRunName,
  directSprintFootSummary,
  epicPickKey,
  epicSourceTail,
  isEpicPickKey,
  isFileSource,
  plannedSprintFootSummary,
  seedPickedKeysFromSource,
} from './newSprintModel'
import type { SprintEngineIntake } from '../../../../../shared/sprintengine/run-types'
import { sourcePlanKindSupportsDirectIntake } from '../../../../../shared/sprintengine/run-types'

const VIEW_ITEMS: SelectItem<BacklogView>[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All items' },
  { value: 'epics', label: 'Epics' },
  { value: 'quick_wins', label: 'Quick wins' },
  { value: 'strategic_bets', label: 'Strategic bets' },
  { value: 'unestimated', label: 'Unestimated' },
]

const SORT_ITEMS: SelectItem<BacklogSort>[] = [
  { value: 'best', label: 'Best' },
  { value: 'recent', label: 'Updated at' },
  { value: 'created', label: 'Created at' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'dependency', label: 'Dependency order' },
  { value: 'no_epic', label: 'No epic first' },
]

const GROUP_ITEMS: SelectItem<BacklogGroup>[] = [
  { value: 'none', label: 'None' },
  { value: 'by_epic', label: 'By epic' },
]

export type NewSprintDialogProject = { path: string; label: string }

// Roadmap objects and mockup attachments are not pickable work — the same
// exclusions both Backlog lists apply before the lens.
function isListableBacklogItem(item: BacklogItem): boolean {
  if (isRoadmapContent(item.relativePath, item.rawType)) return false
  if (item.relativePath.startsWith('backlog/mockups/')) return false
  return true
}

// Human "CLI · model" crumb for a roster line, mirroring the picker chips.
function runtimeLabelFor(
  cli: string | undefined,
  model: string | null | undefined,
  cliOptions: SprintEngineCliOption[],
): string | null {
  if (!cli) return null
  const option = cliOptions.find((candidate) => candidate.value === cli)
  const cliLabel = option?.label ?? cli
  if (!model) return cliLabel
  const modelLabel =
    option?.modelSelection?.options.find((entry) => entry.id === model)?.label ?? model
  return `${cliLabel} · ${modelLabel}`
}

export default function NewSprintDialog({
  initialFolderPath,
  initialSource,
  projectOptions,
  workspaceWindowId,
  onClose,
}: {
  /** Project the dialog opens scoped to; null falls back to the first option. */
  initialFolderPath: string | null
  /** A preloaded source (`initialFuturePlan` seam): the backlog context action
   *  and every other plan-sourced entry arrive with the selection made. */
  initialSource: FuturePlanWorkspaceSource | null
  /** The projects open in Multicode, for the header chip. */
  projectOptions: NewSprintDialogProject[]
  workspaceWindowId: WorkspaceWindowId
  onClose: () => void
}): JSX.Element {
  const [folderPath, setFolderPath] = useState<string | null>(
    initialSource?.folderPath ?? initialFolderPath ?? projectOptions[0]?.path ?? null,
  )
  const scan = useBacklogScan(folderPath)

  const [query, setQuery] = useState('')
  const [view, setView] = useState<BacklogView>('active')
  const [sort, setSort] = useState<BacklogSort>('recent')
  const [group, setGroup] = useState<BacklogGroup>('by_epic')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  // The pick set, in pick order (epic keys `epic:<slug>`, leaf keys the item's
  // relativePath). Seeded from a preloaded backlog source; a hand-picked or
  // non-backlog source rides `fileSource` instead.
  const [pickedKeys, setPickedKeys] = useState<string[]>(() =>
    initialSource ? seedPickedKeysFromSource(initialSource) : [],
  )
  const [fileSource, setFileSource] = useState<FuturePlanWorkspaceSource | null>(() =>
    initialSource && isFileSource(initialSource) ? initialSource : null,
  )
  const pickedSet = useMemo(() => new Set(pickedKeys), [pickedKeys])
  const lastNavKeyRef = useRef<string | null>(null)

  const [nameOverride, setNameOverride] = useState<string | null>(null)
  // The Planning-agent row's value, when the user has moved it (MC-2129).
  // `null` means untouched, so the row shows the source's own default: None for
  // an epic — its children are already an ordered plan — and the run's runtime
  // for anything else, where something must plan because no authored order
  // exists. Storing the OVERRIDE rather than the value is what lets the default
  // follow the picks as they change.
  const [planningNoneOverride, setPlanningNoneOverride] = useState<boolean | null>(null)
  const [renaming, setRenaming] = useState(false)

  const [screen, setScreen] = useState<'sprint' | 'roster'>('sprint')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // The New-item capture modal (the shared BacklogCreateDialog). Mirrored into
  // a ref so the dialog's window-level Escape handler can yield the key to the
  // capture modal while it is open.
  const [creatingItem, setCreatingItem] = useState(false)
  const creatingItemRef = useRef(false)
  useEffect(() => {
    creatingItemRef.current = creatingItem
  }, [creatingItem])

  // --- roster -------------------------------------------------------------
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const appCliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const lastSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  )
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)

  const cliOptions = useMemo(
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, appCliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }, cliModelCatalog),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      appCliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
    ],
  )

  const editor = useRosterEditor({
    cliOptions,
    cliAvailabilityStatus,
    workspaceRoot: folderPath,
  })

  const selectedRoster = useMemo(
    () =>
      editor.selectedRosterId && !isNoRolesRosterRef(editor.selectedRosterId)
        ? editor.rosters.find((entry) => entry.id === editor.selectedRosterId) ?? null
        : null,
    [editor.selectedRosterId, editor.rosters],
  )
  const noRoles = selectedRoster === null
  const staffedRoles = useMemo(
    () =>
      listSprintEngineWizardRoles(editor.registry, editor.disabledRoleIds).filter(
        (role) => (editor.roleCounts[role] ?? 0) > 0,
      ),
    [editor.registry, editor.disabledRoleIds, editor.roleCounts],
  )

  // --- list model ---------------------------------------------------------
  const items = scan.result.items
  const visibleItems = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    const matched = items.filter((item) => {
      if (!isListableBacklogItem(item)) return false
      if (!matchesBacklogView(item, view)) return false
      if (trimmed && !matchesBacklogQuery(item, trimmed)) return false
      return true
    })
    if (sort === 'dependency') {
      const graph = deriveBacklogDependencies([...items])
      const visible = new Set(matched)
      return graph.order.filter((item) => visible.has(item))
    }
    // Like the wizard's source picker before it, this list passes no dependency
    // graph, so no row is demoted as blocked (see the note on BacklogRowContent).
    return [...matched].sort((a, b) => compareBacklogItems(a, b, sort, () => false))
  }, [items, query, view, sort])

  const epicGroups = useMemo(
    () => (group === 'by_epic' ? groupItemsByEpic([...visibleItems]) : null),
    [group, visibleItems],
  )
  const epicColorBySlug = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveBacklogRowColor>['color']>()
    for (const item of items) {
      if (item.isEpic) map.set(epicSlug(item), (item.highlight?.color ?? null))
    }
    return map
  }, [items])

  // Full-scan epic completion, so a lens hiding completed children never zeroes
  // the header fraction (the panel's rule).
  const epicProgressBySlug = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>()
    for (const item of items) {
      if (!item.isEpic) continue
      const slug = epicSlug(item)
      const children = childrenOfEpic([...items], slug)
      map.set(slug, {
        done: children.filter((child) => child.status === 'completed').length,
        total: children.length,
      })
    }
    return map
  }, [items])

  // --- selection ----------------------------------------------------------
  const togglePick = useCallback((key: string) => {
    // "Choose a file instead…" means INSTEAD: a backlog pick replaces a picked
    // file, exactly as picking a file replaces the backlog picks below —
    // otherwise the chips would show a source that does not ride the launch.
    setFileSource(null)
    setPickedKeys((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    )
  }, [])

  // Item-row keys in render order — the shift-range axis (headers excluded).
  const navOrder = useMemo(() => {
    if (!epicGroups) return visibleItems.filter((item) => !item.isEpic).map((i) => i.relativePath)
    const order: string[] = []
    for (const groupEntry of epicGroups) {
      if (groupEntry.slug && collapsed.has(groupEntry.slug)) continue
      for (const child of groupEntry.children) order.push(child.relativePath)
    }
    return order
  }, [epicGroups, visibleItems, collapsed])

  const extendRangeTo = useCallback(
    (key: string): boolean => {
      if (!lastNavKeyRef.current) return false
      const from = navOrder.indexOf(lastNavKeyRef.current)
      const to = navOrder.indexOf(key)
      if (from < 0 || to < 0) return false
      const [start, end] = from <= to ? [from, to] : [to, from]
      const range = navOrder.slice(start, end + 1)
      setPickedKeys((current) => [
        ...current,
        ...range.filter((entry) => !current.includes(entry)),
      ])
      return true
    },
    [navOrder],
  )

  const onLeafClick = useCallback(
    (key: string, event: React.MouseEvent) => {
      if (event.shiftKey && extendRangeTo(key)) return
      lastNavKeyRef.current = key
      togglePick(key)
    },
    [extendRangeTo, togglePick],
  )

  // Keyboard: the listbox is one tab stop; the cursor roves the rendered rows
  // (epic headers included) via aria-activedescendant, Space/Enter toggles the
  // pick, and shift+arrow extends a range across item rows — the same contract
  // the pointer has.
  const [cursorKey, setCursorKey] = useState<string | null>(null)
  const keyboardOrder = useMemo(() => {
    if (!epicGroups) {
      return visibleItems.map((item) =>
        item.isEpic ? epicPickKey(epicSlug(item)) : item.relativePath,
      )
    }
    const order: string[] = []
    for (const groupEntry of epicGroups) {
      if (groupEntry.kind === 'epic' && groupEntry.slug) order.push(epicPickKey(groupEntry.slug))
      if (groupEntry.slug && collapsed.has(groupEntry.slug)) continue
      for (const child of groupEntry.children) order.push(child.relativePath)
    }
    return order
  }, [epicGroups, visibleItems, collapsed])
  const rowDomId = useCallback(
    (key: string) => `new-sprint-row-${keyboardOrder.indexOf(key)}`,
    [keyboardOrder],
  )

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (keyboardOrder.length === 0) return
      const index = cursorKey ? keyboardOrder.indexOf(cursorKey) : -1
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const nextIndex =
          event.key === 'ArrowDown'
            ? Math.min(keyboardOrder.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1)
        const nextKey = keyboardOrder[nextIndex]
        setCursorKey(nextKey)
        if (event.shiftKey && !isEpicPickKey(nextKey)) extendRangeTo(nextKey)
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        setCursorKey(keyboardOrder[event.key === 'Home' ? 0 : keyboardOrder.length - 1])
        return
      }
      if ((event.key === ' ' || event.key === 'Enter') && cursorKey) {
        event.preventDefault()
        if (!isEpicPickKey(cursorKey)) lastNavKeyRef.current = cursorKey
        togglePick(cursorKey)
      }
    },
    [keyboardOrder, cursorKey, extendRangeTo, togglePick],
  )

  // Prune picks that left the project (never the lens — a filtered-out pick
  // stays picked, exactly like the prototype's selection).
  useEffect(() => {
    if (scan.isScanning || scan.result.state === 'missing-folder' || items.length === 0) return
    const valid = new Set(items.map((item) => (item.isEpic ? epicPickKey(epicSlug(item)) : item.relativePath)))
    setPickedKeys((current) => {
      const kept = current.filter((key) => valid.has(key))
      return kept.length === current.length ? current : kept
    })
  }, [scan.isScanning, scan.result.state, items])

  // --- the source + derived name -----------------------------------------
  const selectionSource = useMemo(
    () =>
      folderPath && pickedKeys.length > 0
        ? buildNewSprintSource({ workspaceRoot: folderPath, pickedKeys, items })
        : null,
    [folderPath, pickedKeys, items],
  )
  const source = selectionSource ?? fileSource
  const runName = deriveRunName(source, nameOverride)

  const pickedEpics = useMemo(
    () =>
      pickedKeys
        .filter(isEpicPickKey)
        .map((key) => items.find((item) => item.isEpic && epicPickKey(epicSlug(item)) === key))
        .filter((item): item is BacklogItem => item !== undefined),
    [pickedKeys, items],
  )
  const pickedLeaves = useMemo(
    () =>
      pickedKeys
        .filter((key) => !isEpicPickKey(key))
        .map((key) => items.find((item) => !item.isEpic && item.relativePath === key))
        .filter((item): item is BacklogItem => item !== undefined),
    [pickedKeys, items],
  )
  const sourceCount = pickedEpics.length + pickedLeaves.length + (fileSource ? 1 : 0)

  // ── the Planning agent row (MC-2129) ──────────────────────────────────────
  //
  // None exists only where there is an authored order to fall back on, which is
  // an epic source. Everywhere else the row still appears — never a control that
  // is present in one world and absent in the other — with an agent picked and
  // no way to clear it.
  const epicImport = useMemo(
    () =>
      pickedEpics.reduce(
        (total, epic) => {
          const counts = epicImportCounts([...items], epicSlug(epic))
          return { open: total.open + counts.open, closed: total.closed + counts.closed }
        },
        { open: 0, closed: 0 },
      ),
    [pickedEpics, items],
  )
  const canPlanNone = sourcePlanKindSupportsDirectIntake(source?.sourcePlanKind)
  const planningIsNone = canPlanNone && (planningNoneOverride ?? true)
  const intake: SprintEngineIntake = planningIsNone ? 'direct' : 'planned'
  // What the sprint will actually contain: an epic contributes its open children
  // (one task each), every other pick contributes itself.
  const workItemCount = epicImport.open + pickedLeaves.length + (fileSource ? 1 : 0)
  // The row shows and sets the runtime of the seat that would actually plan: the
  // architect on a staffed roster, the single shared runtime on a roleless run.
  const planningRuntimeKey =
    sprintEngineCoordinatorSeatForRoleCounts(editor.roleCounts).role ?? SPRINT_ENGINE_ROLELESS_KEY
  const planningAgentRow: PlanningAgentRow = {
    cli: editor.roleCliDefaults[planningRuntimeKey] ?? cliOptions[0]?.value ?? 'claude-code',
    effectiveModel: editor.roleModelOverrides[planningRuntimeKey] || undefined,
    effectiveReasoning: editor.roleReasoningOverrides[planningRuntimeKey] || undefined,
    isNone: planningIsNone,
    allowNone: canPlanNone,
    onSelectNone: () => setPlanningNoneOverride(true),
    onSetCli: (cli) => {
      setPlanningNoneOverride(false)
      editor.onSetRoleCli(planningRuntimeKey, cli)
    },
    onSetModel: (model) => {
      setPlanningNoneOverride(false)
      editor.onSetRoleModel(planningRuntimeKey, model)
    },
    onSetReasoning: (reasoning) => editor.onSetRoleReasoning(planningRuntimeKey, reasoning),
  }

  const switchProject = useCallback((path: string) => {
    if (path === folderPath) return
    // A sprint bundle is always from one project: switching drops the picks.
    setFolderPath(path)
    setPickedKeys([])
    setFileSource(null)
    setNameOverride(null)
    setCursorKey(null)
    lastNavKeyRef.current = null
  }, [folderPath])

  const pickSourceFile = useCallback(async () => {
    if (!folderPath) return
    const picked = await window.api.openFile({
      title: 'Choose a source file',
      defaultPath: folderPath,
      filters: [{ name: 'Plans & mockups', extensions: ['md', 'markdown', 'html', 'htm'] }],
    })
    if (!picked) return
    try {
      const content = await window.api.readfile(picked)
      const relativePath = workspaceRelativePath(folderPath, picked) ?? basename(picked)
      // A hand-picked file REPLACES the backlog picks (and vice versa): the
      // launch has one source plan, and the chips must never show more than
      // what actually rides it.
      setPickedKeys([])
      lastNavKeyRef.current = null
      setFileSource({
        folderPath,
        sourcePath: picked,
        sourceRelativePath: relativePath,
        sourceContent: content,
        sourcePlanKind: inferSourcePlanKind(relativePath, content),
        teamName: slugifySprintEngineName(basename(relativePath).replace(/\.(md|html?)$/i, '')),
        goal: markdownTitle(content) ?? basename(relativePath),
      })
      setCreateError(null)
    } catch {
      setCreateError('Could not read the selected file.')
    }
  }, [folderPath])

  // Create the item exactly as the Backlog panel and door do — same file
  // shape, same triage write through the validated IPC — then rescan and pick
  // it, the dialog's analog of both surfaces' select-on-create. Throws on
  // failure so the capture dialog shows the reason and keeps the draft.
  const submitCreateItem = useCallback(
    async (draft: BacklogDraft) => {
      const title = draft.title.trim()
      if (!folderPath || !title) return
      const existing = new Set(items.map((item) => item.relativePath.toLowerCase()))
      const fileName = uniqueItemFileName(`${todayPrefix()}-${slugifyItemTitle(title)}`, existing)
      const backlogDir = await window.api.ensureDir(folderPath, 'backlog')
      const newPath = await window.api.createFile(backlogDir, fileName)
      const description = draft.description.trim()
      await window.api.writefile(
        newPath,
        description ? `# ${title}\n\n${description}\n` : `# ${title}\n`,
      )
      const relativePath = normalizeRelativePath(`backlog/${fileName}`)
      const triage = await window.api.updateBacklogTriage({
        workspaceRoot: folderPath,
        relativePath,
        difficulty: draft.difficulty === 'unset' ? null : draft.difficulty,
        criticality: draft.criticality === 'unset' ? null : draft.criticality,
      })
      if (!triage.ok) throw new Error(triage.message || 'Unable to update Backlog metadata.')
      await scan.rescan()
      setFileSource(null)
      setPickedKeys((current) =>
        current.includes(relativePath) ? current : [...current, relativePath],
      )
      setCreatingItem(false)
    },
    [folderPath, items, scan],
  )

  // --- screens + focus ----------------------------------------------------
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const backButtonRef = useRef<HTMLButtonElement | null>(null)
  const prevScreenRef = useRef<'sprint' | 'roster'>('sprint')

  // Restoring focus to the opener on close is `Modal`'s contract now that the
  // shell IS a Modal (MC-2110). Landing it is still this file's, and has to be:
  // the region below carries `onKeyDown` for Enter-to-start, and a keydown on
  // the shell ABOVE it never reaches a child handler. Focusing the region rather
  // than the shell is also what makes `Modal` skip its own initial focus — it
  // yields to a descendant that already has it. `openerRef` further down is the
  // SCREEN-level opener (screen 2 → back to the roster control); this is where
  // focus lands when that opener has unmounted.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const openRosterScreen = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setScreen('roster')
  }, [])
  const closeRosterScreen = useCallback(() => {
    setScreen('sprint')
  }, [])

  useEffect(() => {
    if (screen === prevScreenRef.current) return
    if (screen === 'roster') {
      backButtonRef.current?.focus()
    } else {
      // The opener may have been a menu row that unmounted with its popover;
      // the dialog itself is the fallback so focus never escapes the modal.
      if (openerRef.current?.isConnected) openerRef.current.focus()
      else dialogRef.current?.focus()
      openerRef.current = null
    }
    prevScreenRef.current = screen
  }, [screen])

  // What Escape means here, handed to the shell's `Modal` rather than fought
  // for with a listener of our own: the shell's runs first either way, being a
  // child effect. Three cases, unchanged from when this dialog owned the key —
  // the New-item capture is the topmost surface while open and closes itself,
  // screen 2 steps back to screen 1, and only then does Escape mean close.
  const handleEscape = useCallback(() => {
    if (creatingItemRef.current) return
    if (prevScreenRef.current === 'roster') setScreen('sprint')
    else onClose()
  }, [onClose])

  // --- start --------------------------------------------------------------
  const canStart = Boolean(source && folderPath && runName && !creating)

  const start = useCallback(async () => {
    if (!source || !folderPath || !runName || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      // Attached/body-referenced mockups ride the launch (MC-1485), resolved
      // once here — the dialog has no live re-selection to race against.
      const baseBundle = source.sourceBundle ?? []
      let bundle = baseBundle
      const markdownDocs = [
        { content: source.sourceContent, relativePath: source.sourceRelativePath },
        ...baseBundle.map((item) => ({ content: item.sourceContent, relativePath: item.sourceRelativePath })),
      ]
        .filter((doc) => Boolean(doc.content) && /\.(md|markdown)$/i.test(doc.relativePath))
        .map((doc) => mockupSourceDocFromMarkdown(doc.content ?? '', doc.relativePath))
      if (markdownDocs.length > 0) {
        try {
          const mockupItems = await resolveSprintEngineMockupBundleItems({
            docs: markdownDocs,
            folderPath,
            readFile: (absolutePath) => window.api.readfile(absolutePath),
            excludeRelativePaths: [
              source.sourceRelativePath,
              ...baseBundle.map((item) => item.sourceRelativePath),
            ],
          })
          if (mockupItems.length > 0) bundle = [...baseBundle, ...mockupItems]
        } catch {
          // Mockups are supporting context — enrichment failure never blocks.
        }
      }

      const epicChildRelativePaths = bundle
        .filter((entry) => entry.epicChild)
        .map((entry) => entry.sourceRelativePath)
      const launchRoleCounts = sprintEngineLaunchRoleCounts(
        editor.selectedRosterId ?? NO_ROLES_ROSTER_ID,
        editor.roleCounts,
      )
      const initialSpawnRoles = (
        Object.entries(
          buildSprintEngineEffectiveSpawnAtStartRoles({
            automationMode: 'run_agents_and_approve_artifacts',
            existingTeam: false,
            visibleRoleCounts: launchRoleCounts,
          }),
        ) as Array<[SprintEngineRoleId, boolean | undefined]>
      )
        .filter(([, spawn]) => spawn)
        .map(([role]) => role)

      const created = await runSprintEnginePlanSourcedCreation(
        {
          folderPath,
          teamName: runName,
          goal: source.goal,
          sourcePlanPath: source.sourcePath,
          sourcePlanRelativePath: source.sourceRelativePath,
          sourcePlanContent: source.sourceContent,
          sourcePlanKind: source.sourcePlanKind,
          sourceBundle: bundle.length > 0 ? bundle : null,
          visibleRoleCounts: launchRoleCounts,
          maxParallelAgents: editor.poolAgentCount,
          roleCliDefaults: editor.roleCliDefaults,
          roleModelOverrides: editor.roleModelOverrides,
          roleReasoningOverrides: editor.roleReasoningOverrides,
          initialSpawnRoles,
          startRunner: true,
          autoApproveArtifacts: true,
          useWorktrees: false,
          sourceReference: true,
          intake,
          epicChildRelativePaths:
            epicChildRelativePaths.length > 0 ? epicChildRelativePaths : undefined,
          cliPermissionPreset: lastSpawnPermissionPreset,
          workspaceWindowId,
        },
        {
          pathExists: window.api.pathExists,
          initializeSprintEngineState: window.api.initializeSprintEngineState,
          recordBacklogExecutionLink: async ({
            workspaceRoot,
            sourceRelativePath,
            teamSlug,
            statePath,
            childRelativePaths,
          }) => {
            const runRelativePath = workspaceRelativePath(workspaceRoot, statePath) ?? statePath
            const sourceItem = items.find((item) => item.relativePath === sourceRelativePath)
            const result = await window.api.addOrUpdateBacklogLink({
              workspaceRoot,
              relativePath: sourceRelativePath,
              link: buildSprintEngineRunLink({ teamSlug, runRelativePath }),
              // An epic derives its status from its children and never carries
              // one of its own.
              ...(sourceItem?.isEpic || isBacklogEpicPath(sourceRelativePath)
                ? {}
                : { status: 'in_progress' as const }),
            })
            if (!result.ok) throw new Error(result.message)
            for (const childPath of childRelativePaths ?? []) {
              const child = items.find((item) => item.relativePath === childPath)
              const childResult = await window.api.addOrUpdateBacklogLink({
                workspaceRoot,
                relativePath: childPath,
                link: buildSprintEngineRunLink({
                  teamSlug,
                  runRelativePath,
                  status: 'pending',
                  ...(child ? { priorStatus: child.status } : {}),
                }),
              })
              if (!childResult.ok) throw new Error(childResult.message)
            }
          },
        },
      )
      // Read the door's claim before closing — closing releases it. A sprint
      // started at the Sprints door returns there, on the run just created
      // (item 1765); one started anywhere else stays where it was started.
      const cameFromSprintsDoor = consumeSprintCreationDoorClaim()
      onClose()
      if (cameFromSprintsDoor) {
        noteSprintDoorSelection(created.statePath)
        openGlobalSurface('sprints')
      }
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'Could not start the sprint.',
      )
    } finally {
      setCreating(false)
    }
  }, [
    source,
    folderPath,
    runName,
    creating,
    editor.selectedRosterId,
    editor.roleCounts,
    editor.poolAgentCount,
    editor.roleCliDefaults,
    editor.roleModelOverrides,
    editor.roleReasoningOverrides,
    items,
    lastSpawnPermissionPreset,
    workspaceWindowId,
    onClose,
    openGlobalSurface,
  ])

  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || event.defaultPrevented || screen !== 'sprint') return
    const target = event.target as HTMLElement
    if (target.closest('button, [role="menu"], [role="listbox"], [role="option"], textarea')) return
    if (target instanceof HTMLInputElement && renaming) return
    if (canStart) {
      event.preventDefault()
      void start()
    }
  }

  const projectLabel =
    projectOptions.find((option) => option.path === folderPath)?.label
    ?? (folderPath ? basename(folderPath) : 'Choose project')

  // The footer states the consequence of the choice above it, in plain words:
  // what you get, not which mode you are in (MC-2129).
  const footSummary =
    sourceCount === 0
      ? ''
      : planningIsNone
        ? directSprintFootSummary(workItemCount)
        : plannedSprintFootSummary(workItemCount)

  return (
    <>
      {/* The shell is `Modal`, not a copy of it. This dialog used to restate the
          whole thing — the same scrim string, its own Escape and focus effects,
          its own trap, and a `rounded-lg` / `border-default` / 1000px geometry
          that matched no other dialog — and got no click-outside close for the
          trouble. All of that is the primitive's now (MC-2110); what stays here
          is what is actually the New sprint dialog: its two screens, its
          Enter-to-start, and its header. */}
      <Modal
        open
        onClose={onClose}
        onEscape={handleEscape}
        label="New sprint"
        size="workbench"
        layout="panel"
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
          className="flex min-h-0 flex-1 flex-col outline-none"
        >
          {/* The dialog's own identity row, on the shared primitive: it named
              itself and picked its project in a hand-rolled band at
              `px-4 py-2.5` over `--border-subtle`, the same dialect the agent
              composer ran (2112). The project picker is the row's `scope`. */}
          <PanelHeader
            title="New sprint"
            scope={
              <ProjectChip
                label={projectLabel}
                currentPath={folderPath}
                options={projectOptions}
                onSelect={switchProject}
              />
            }
            primaryAction={<CloseIconButton onClick={onClose} aria-label="Close" />}
          />

          {/* Screen 1 stays mounted while screen 2 shows (display swap, exactly
              like the prototype): the picks, scroll position, and the focus
              opener all keep their identity across the round trip. */}
          <div className={screen === 'sprint' ? 'flex min-h-0 flex-1' : 'hidden'}>
              {/* ── LEFT · the shared Backlog list ─────────────────────────── */}
              <div className="flex w-[44%] min-w-[340px] max-w-[440px] shrink-0 flex-col border-r border-[color:var(--border-default)]">
                <PanelHeader
                  title="Backlog"
                  count={visibleItems.length}
                  subtitle={projectLabel}
                  // One control in the primary slot, the rest in the menu —
                  // the same split the Backlog panel this list mirrors makes
                  // (2112). Adding an item is what the left column is for;
                  // rescanning moves into the overflow.
                  primaryAction={
                    <Tooltip content="New item" placement="bottom">
                      <IconButton
                        aria-label="New item"
                        onClick={() => setCreatingItem(true)}
                        disabled={!folderPath}
                      >
                        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </IconButton>
                    </Tooltip>
                  }
                  overflow={
                    <OverflowMenu
                      ariaLabel="Backlog actions"
                      items={[
                        {
                          id: 'rescan-backlog',
                          label: 'Rescan',
                          onSelect: () => void scan.rescan(),
                          disabled: scan.isScanning || !folderPath,
                          icon: <RefreshIcon />,
                        },
                      ]}
                    />
                  }
                  divider={false}
                />
                <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 pb-2">
                  <InboxSearchInput
                    value={query}
                    onChange={setQuery}
                    ariaLabel="Search backlog items"
                    placeholder="Search items…"
                  />
                  <BacklogFilterMenu
                    view={view}
                    sort={sort}
                    group={group}
                    viewItems={VIEW_ITEMS}
                    sortItems={SORT_ITEMS}
                    groupItems={GROUP_ITEMS}
                    onViewChange={setView}
                    onSortChange={setSort}
                    onGroupChange={setGroup}
                    defaultGroup="by_epic"
                    className="shrink-0"
                  />
                </div>
                <p className="shrink-0 px-3 pt-1.5 text-micro text-[color:var(--text-disabled)]">
                  Click to pick · shift for a range · an epic brings its open items
                </p>
                <div
                  role="listbox"
                  aria-multiselectable="true"
                  aria-label="Backlog items"
                  tabIndex={0}
                  onKeyDown={onListKeyDown}
                  aria-activedescendant={cursorKey ? rowDomId(cursorKey) : undefined}
                  className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 pt-1 outline-none focus-visible:focus-ring"
                >
                  {scan.isScanning && items.length === 0 ? (
                    <p className="px-3 py-6 text-center text-meta text-[color:var(--text-subtle)]">
                      Scanning the backlog…
                    </p>
                  ) : visibleItems.length === 0 ? (
                    <p className="px-3 py-6 text-center text-meta text-[color:var(--text-subtle)]">
                      {items.length === 0 ? 'This project has no backlog items.' : 'Nothing matches that.'}
                    </p>
                  ) : epicGroups ? (
                    epicGroups.map((groupEntry) => (
                      <EpicGroupRows
                        key={groupEntry.slug ?? '(none)'}
                        group={groupEntry}
                        collapsed={groupEntry.slug ? collapsed.has(groupEntry.slug) : false}
                        onToggleCollapse={() => {
                          const slug = groupEntry.slug
                          if (!slug) return
                          setCollapsed((current) => {
                            const next = new Set(current)
                            if (next.has(slug)) next.delete(slug)
                            else next.add(slug)
                            return next
                          })
                        }}
                        progress={groupEntry.slug ? epicProgressBySlug.get(groupEntry.slug) : undefined}
                        pickedSet={pickedSet}
                        onTogglePickEpic={() => {
                          if (groupEntry.slug) {
                            setCursorKey(epicPickKey(groupEntry.slug))
                            togglePick(epicPickKey(groupEntry.slug))
                          }
                        }}
                        onLeafClick={(key, event) => {
                          setCursorKey(key)
                          onLeafClick(key, event)
                        }}
                        rowDomId={rowDomId}
                        cursorKey={cursorKey}
                      />
                    ))
                  ) : (
                    visibleItems.map((item) => {
                      const key = item.isEpic ? epicPickKey(epicSlug(item)) : item.relativePath
                      return (
                        <PickRow
                          key={key}
                          domId={rowDomId(key)}
                          cursored={cursorKey === key}
                          item={item}
                          epicColor={item.epic ? epicColorBySlug.get(item.epic) ?? null : null}
                          picked={pickedSet.has(key)}
                          implied={Boolean(
                            item.epic
                            && pickedSet.has(epicPickKey(item.epic))
                            // Exactly the engine's skip rule (MC-2129): a child the
                            // import leaves out must not read as riding along.
                            && !CLOSED_EPIC_CHILD_STATUSES.has(item.status),
                          )}
                          onClick={(event) => {
                            setCursorKey(key)
                            if (item.isEpic) togglePick(key)
                            else onLeafClick(key, event)
                          }}
                        />
                      )
                    })
                  )}
                </div>
              </div>

              {/* ── RIGHT · what this sprint is ────────────────────────────── */}
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
                <div className="flex min-w-0 items-center gap-1.5">
                  {renaming ? (
                    <input
                      autoFocus
                      defaultValue={runName ?? ''}
                      aria-label="Run name"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          setNameOverride(event.currentTarget.value)
                          setRenaming(false)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          setRenaming(false)
                        }
                      }}
                      onBlur={(event) => {
                        setNameOverride(event.currentTarget.value)
                        setRenaming(false)
                      }}
                      // The kit's in-place title edit. This spelled its own box
                      // at Tailwind's default 4px radius, off the 3/5/7/9 ramp,
                      // and drew a resting border where the automation editor's
                      // identical idiom draws none (MC-2114).
                      className={`${INLINE_TITLE_EDIT_CLASS} min-w-0 flex-1 font-mono text-heading font-medium text-[color:var(--text-strong)]`}
                    />
                  ) : runName ? (
                    <>
                      <h2 className="min-w-0 truncate font-mono text-heading font-medium text-[color:var(--text-strong)]">
                        {runName}
                      </h2>
                      <button
                        type="button"
                        aria-label="Rename this run"
                        onClick={() => setRenaming(true)}
                        className="shrink-0 rounded p-0.5 text-[color:var(--text-disabled)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
                      >
                        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                          <path d="M11.2 2.8l2 2L6 12H4v-2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                          <path d="M2.5 14h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".5" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <h2 className="text-heading font-semibold text-[color:var(--text-subtle)]">
                      Nothing picked yet
                    </h2>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  {sourceCount === 0 ? (
                    <p className="text-meta text-[color:var(--text-disabled)]">
                      Pick from the backlog on the left, or choose a file below.
                    </p>
                  ) : (
                    <>
                      {pickedEpics.map((epic) => {
                        const slug = epicSlug(epic)
                        // The import arithmetic, both halves. With no plan gate
                        // there is no later stop where a miscount would surface, so
                        // this row is where the import is verified — and it counts
                        // by the engine's own skip rule, not a near-miss of it.
                        return (
                          <SourceChip
                            key={epicPickKey(slug)}
                            id={epic.displayId}
                            title={epic.title}
                            tail={epicSourceTail(epicImportCounts([...items], slug))}
                            color={epic.highlight?.color ?? null}
                            onRemove={() => togglePick(epicPickKey(slug))}
                          />
                        )
                      })}
                      {pickedLeaves.map((item) => (
                        <SourceChip
                          key={item.relativePath}
                          id={item.displayId}
                          title={item.title}
                          onRemove={() => togglePick(item.relativePath)}
                        />
                      ))}
                      {fileSource ? (
                        <SourceChip
                          title={fileSource.sourceRelativePath}
                          onRemove={() => setFileSource(null)}
                        />
                      ) : null}
                    </>
                  )}
                </div>

                <div className="h-px shrink-0 bg-[color:var(--border-subtle)]" />

                <div className="flex items-center justify-between gap-3">
                  <span className="text-meta text-[color:var(--text-muted)]">Team</span>
                  <RosterMenu
                    rosters={editor.rosters}
                    selectedName={selectedRoster?.name ?? null}
                    onSelect={(name) => {
                      if (!name) {
                        editor.onSelectRoster(NO_ROLES_ROSTER_ID)
                        return
                      }
                      const roster = editor.rosters.find(
                        (entry) => entry.name.trim().toLowerCase() === name.trim().toLowerCase(),
                      )
                      if (roster) editor.onSelectRoster(roster.id)
                    }}
                    onManageRosters={openRosterScreen}
                    ariaLabel="Team for this sprint"
                  />
                </div>

                {noRoles ? (
                  <PlainAgentsPanel
                    agentCount={editor.poolAgentCount}
                    onChangeAgentCount={editor.onChangePoolAgentCount}
                    cli={
                      editor.roleCliDefaults[SPRINT_ENGINE_ROLELESS_KEY]
                      ?? cliOptions[0]?.value
                      ?? 'claude-code'
                    }
                    cliOptions={cliOptions}
                    effectiveModel={editor.roleModelOverrides[SPRINT_ENGINE_ROLELESS_KEY] || undefined}
                    effectiveReasoning={
                      editor.roleReasoningOverrides[SPRINT_ENGINE_ROLELESS_KEY] || undefined
                    }
                    onSetCli={(cli) => editor.onSetRoleCli(SPRINT_ENGINE_ROLELESS_KEY, cli)}
                    onSetModel={(model) => editor.onSetRoleModel(SPRINT_ENGINE_ROLELESS_KEY, model)}
                    onSetReasoning={(reasoning) =>
                      editor.onSetRoleReasoning(SPRINT_ENGINE_ROLELESS_KEY, reasoning)
                    }
                    planningAgent={planningAgentRow}
                  />
                ) : (
                  <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]">
                    <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
                      <span className="flex pl-1" aria-hidden="true">
                        {staffedRoles.map((role) => (
                          <span key={role} className="-ml-1 inline-flex rounded-full ring-2 ring-[color:var(--bg-surface)]">
                            <RoleAvatar role={role} registry={editor.registry} size="xs" ariaLabel="" />
                          </span>
                        ))}
                      </span>
                      <span className="min-w-0 truncate text-meta font-medium text-[color:var(--text-strong)]">
                        {selectedRoster.name}
                      </span>
                      <span className="ml-auto shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
                        {staffedRoles.length} role{staffedRoles.length === 1 ? '' : 's'}
                      </span>
                      <button
                        type="button"
                        onClick={openRosterScreen}
                        className="shrink-0 text-meta text-[color:var(--text-muted)] underline underline-offset-2 transition-colors hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
                      >
                        Configure…
                      </button>
                    </div>
                    <div className="flex flex-col gap-1.5 px-3 py-2">
                      {staffedRoles.length === 0 ? (
                        <span className="text-micro text-[color:var(--text-disabled)]">
                          This roster staffs nothing.
                        </span>
                      ) : (
                        staffedRoles.map((role) => (
                          <span key={role} className="flex items-center gap-2 text-micro">
                            <RoleAvatar role={role} registry={editor.registry} size="xs" ariaLabel="" />
                            <span className="min-w-0 flex-1 truncate text-[color:var(--text-default)]">
                              {getSprintEngineRoleLabel(role, editor.registry)}
                            </span>
                            <span className="shrink-0 font-mono text-[color:var(--text-subtle)]">
                              {runtimeLabelFor(
                                editor.roleCliDefaults[role],
                                editor.roleModelOverrides[role],
                                cliOptions,
                              )}
                            </span>
                          </span>
                        ))
                      )}
                    </div>
                    {/* The same row a roleless team card carries: one control in
                        both worlds, never present here and absent there. */}
                    <PlanningAgentRowView row={planningAgentRow} cliOptions={cliOptions} />
                  </div>
                )}

                {createError ? (
                  <InlineNotice tone="error">{createError}</InlineNotice>
                ) : null}
              </div>
          </div>
          {screen === 'roster' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-3 px-4 pb-2 pt-3">
                <button
                  ref={backButtonRef}
                  type="button"
                  onClick={closeRosterScreen}
                  className="inline-flex items-center gap-1.5 text-meta text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                    <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back to the sprint
                </button>
                <span className="text-heading font-semibold text-[color:var(--text-strong)]">Rosters</span>
              </div>
              <p className="max-w-[64ch] shrink-0 px-4 pb-3 text-meta text-[color:var(--text-muted)]">
                Rosters are shared. Editing one here changes it everywhere it is used — in this
                dialog and in every horizon.
              </p>
              <div className="flex min-h-0 flex-1 border-t border-[color:var(--border-subtle)]">
                <RosterEditor editor={editor} />
              </div>
            </div>
          ) : null}

          <footer className="flex shrink-0 items-center gap-3 border-t border-[color:var(--border-subtle)] px-4 py-3">
            {screen === 'sprint' ? (
              <>
                <button
                  type="button"
                  onClick={() => void pickSourceFile()}
                  className="text-meta text-[color:var(--text-muted)] underline underline-offset-2 transition-colors hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
                >
                  Choose a file instead…
                </button>
                <span className="flex-1" />
                <span className="text-micro text-[color:var(--text-subtle)]">{footSummary}</span>
                <PrimaryButton disabled={!canStart} onClick={() => void start()}>
                  {creating ? 'Starting…' : 'Start sprint'}
                  <kbd className="ml-1.5 rounded bg-black/15 px-1 font-mono text-micro">⏎</kbd>
                </PrimaryButton>
              </>
            ) : (
              <>
                <span className="flex-1" />
                <GhostButton onClick={closeRosterScreen}>Cancel</GhostButton>
                <PrimaryButton onClick={closeRosterScreen}>Use this roster</PrimaryButton>
              </>
            )}
          </footer>
        </div>
      </Modal>
      {/* The shared New-item capture, stacked as a sibling of the dialog — not
          inside it — so its keystrokes never reach the dialog's Enter-to-start
          handler and its own trap keeps its own cycle. */}
      {creatingItem && folderPath ? (
        <BacklogCreateDialog
          difficultyItems={DIFFICULTY_EDIT_ITEMS}
          criticalityItems={CRITICALITY_EDIT_ITEMS}
          onClose={() => setCreatingItem(false)}
          onCreate={submitCreateItem}
        />
      ) : null}
    </>
  )
}

// New-item filename shape, matching the Backlog panel's and door's local
// helpers byte for byte. Three surfaces now carry this copy — lifting it into
// utils/backlog is the right follow-up, deferred here because both siblings'
// files belong to other in-flight tasks.
function slugifyItemTitle(value: string): string {
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

function uniqueItemFileName(baseName: string, existingRelativeLower: ReadonlySet<string>): string {
  let candidate = `${baseName}.md`
  let index = 2
  while (existingRelativeLower.has(`backlog/${candidate}`.toLowerCase())) {
    candidate = `${baseName}-${index}.md`
    index += 1
  }
  return candidate
}

// The header's project scope — the same chip anatomy New chat's composer has,
// minus Browse: the project IS the folder, and a sprint starts in an open one.
function ProjectChip({
  label,
  currentPath,
  options,
  onSelect,
}: {
  label: string
  currentPath: string | null
  options: NewSprintDialogProject[]
  onSelect: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Project for this sprint"
      popupRole="menu"
      placement="bottom-start"
      className="min-w-0"
      surfaceClassName="w-[300px] p-1"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className="inline-flex min-w-0 items-center gap-1.5 rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-default)] focus-visible:focus-ring"
          {...triggerProps}
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
            <path
              d="M2 4.5C2 3.7 2.7 3 3.5 3H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9C2.7 13.5 2 12.8 2 12V4.5z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
          <span className="truncate">{label}</span>
          <span aria-hidden="true" className="shrink-0 text-micro text-[color:var(--text-disabled)]">▾</span>
        </button>
      )}
    >
      {options.map((option) => (
        <button
          key={option.path}
          type="button"
          role="menuitemradio"
          aria-checked={option.path === currentPath}
          onClick={() => {
            onSelect(option.path)
            setOpen(false)
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-meta text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
        >
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.path === currentPath ? <CheckIcon className="icon-xs shrink-0" /> : null}
        </button>
      ))}
    </Popover>
  )
}

function PickMark(): JSX.Element {
  return <CheckIcon className="icon-xs shrink-0 text-[color:var(--accent-primary)]" />
}

// One selectable leaf/epic row — the real BacklogRowContent anatomy inside the
// shared paint seam, plus the dialog's pick mark and the implied-child rule (a
// child riding its epic gets a thin accent rule, never the fill).
function PickRow({
  item,
  epicColor,
  picked,
  implied,
  onClick,
  domId,
  cursored = false,
}: {
  item: BacklogItem
  epicColor: ReturnType<typeof resolveBacklogRowColor>['color']
  picked: boolean
  implied: boolean
  onClick: (event: React.MouseEvent) => void
  domId?: string
  /** The listbox's roving cursor rests here (aria-activedescendant). */
  cursored?: boolean
}): JSX.Element {
  const { color, litFill } = resolveBacklogRowColor(item, epicColor)
  const paint = backlogRowPaintClass({ color, litFill, selected: picked })
  // A child riding its picked epic is NOT a second pick: the approved mockup
  // (prototypes/2026-07-31-new-sprint-dialog.html) marks it with a thin accent
  // rule, deliberately not the selection fill, so an 8-child epic never reads
  // as eight separate picks.
  // design-tokens-allow: implied-child accent rule from the approved mockup — not selection paint
  const impliedClass = implied && !picked ? 'border-l-[color:var(--accent-primary)]' : ''
  const cursorClass = cursored ? 'outline outline-1 -outline-offset-1 outline-[color:var(--border-focus)]' : 'outline-none'
  // A child that will NOT be imported reads as excluded: struck, and without the
  // implied rule its open siblings carry (MC-2129). The count on the source chip
  // and this styling answer the same question — what actually goes in — so they
  // read the status the same way the engine does.
  const closed = !item.isEpic && CLOSED_EPIC_CHILD_STATUSES.has(item.status)
  return (
    <div
      id={domId}
      role="option"
      aria-selected={picked}
      onClick={onClick}
      className={`flex cursor-pointer items-start gap-2 rounded border-l-[3px] py-1 pl-2 pr-2 text-micro text-[color:var(--text-muted)] ${paint} ${impliedClass} ${cursorClass}`}
    >
      <span
        className={`min-w-0 flex-1 ${closed && !picked ? 'line-through decoration-[color:var(--border-strong)]' : ''}`}
      >
        <BacklogRowContent item={item} now={Date.now()} selected={picked} plainTitle />
      </span>
      {picked ? <PickMark /> : null}
    </div>
  )
}

function EpicGroupRows({
  group,
  collapsed,
  onToggleCollapse,
  progress,
  pickedSet,
  onTogglePickEpic,
  onLeafClick,
  rowDomId,
  cursorKey,
}: {
  group: BacklogEpicGroup
  collapsed: boolean
  onToggleCollapse: () => void
  progress: { done: number; total: number } | undefined
  pickedSet: ReadonlySet<string>
  onTogglePickEpic: () => void
  onLeafClick: (key: string, event: React.MouseEvent) => void
  rowDomId: (key: string) => string
  cursorKey: string | null
}): JSX.Element {
  const epicKey = group.slug ? epicPickKey(group.slug) : null
  const epicPicked = Boolean(epicKey && pickedSet.has(epicKey))
  const headerPaint = backlogRowPaintClass({
    color: group.color,
    litFill: false,
    selected: epicPicked,
  })
  const headerCursorClass =
    epicKey && cursorKey === epicKey
      ? 'outline outline-1 -outline-offset-1 outline-[color:var(--border-focus)]'
      : 'outline-none'
  return (
    <>
      {group.kind === 'epic' ? (
        <div
          id={epicKey ? rowDomId(epicKey) : undefined}
          role="option"
          aria-selected={epicPicked}
          onClick={onTogglePickEpic}
          className={`mt-1 flex cursor-pointer items-center gap-2 rounded border-l-[3px] py-1 pl-1.5 pr-2 ${headerPaint} ${headerCursorClass}`}
        >
          <span className="min-w-0 flex-1">
            <BacklogEpicHeaderContent
              group={group}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              progress={progress}
              selected={epicPicked}
            />
          </span>
          {epicPicked ? <PickMark /> : null}
        </div>
      ) : group.children.length > 0 ? (
        <p className="mt-2 px-2 pb-0.5 text-micro font-medium text-[color:var(--text-subtle)]">
          {group.title}
        </p>
      ) : null}
      {collapsed
        ? null
        : group.children.map((item) => (
            <div key={item.relativePath} className={group.kind === 'epic' ? 'ml-3' : ''}>
              <PickRow
                item={item}
                domId={rowDomId(item.relativePath)}
                cursored={cursorKey === item.relativePath}
                epicColor={group.kind === 'epic' ? group.color : null}
                picked={pickedSet.has(item.relativePath)}
                implied={Boolean(epicPicked && !CLOSED_EPIC_CHILD_STATUSES.has(item.status))}
                onClick={(event) => onLeafClick(item.relativePath, event)}
              />
            </div>
          ))}
    </>
  )
}

function SourceChip({
  id,
  title,
  tail,
  color,
  onRemove,
}: {
  id?: string
  title: string
  tail?: string
  color?: Parameters<typeof EpicColorDot>[0]['color']
  onRemove: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2.5 py-1 text-meta">
      {color !== undefined ? <EpicColorDot color={color} /> : null}
      {id ? (
        <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">{id}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[color:var(--text-default)]">{title}</span>
      {tail ? <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">{tail}</span> : null}
      <button
        type="button"
        aria-label={`Remove ${title}`}
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus-visible:focus-ring"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
