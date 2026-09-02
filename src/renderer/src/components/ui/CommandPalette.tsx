import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { orderSpecialistActions } from '../../specialists/specialistActions'
import { listSpecialistPacks, resolveEnabledSpecialists } from '../../specialists/specialistPacks'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { SpecialistActionId, Workspace, WorkspaceId, WorkspaceWindowId } from '../../types/workspace'
import type { BuiltinSkill, WorkspaceSkill } from '../../../../shared/electron-api'
import { focusOrAddComponentTab, revealNavRailComponent, togglePanelRailComponent } from '../../utils/modelRegistry'
import { openFileSurface } from '../../utils/openFileSurface'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import {
  getEffectiveKeybindingLabel,
  getSpecialistCommandId,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'
import { isCommandEnabled, isCommandIdEnabled, type CommandAvailabilityContext } from '../../commands/availability'
import type { CommandScope, ModuleCommandContext } from '../../commands/types'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import {
  commandMatchesQuery,
  groupInScope,
  workspaceSearchKeywords,
  type PaletteCommandGroup,
  type PaletteScope,
} from '../commandPaletteSearch'
import { dispatchPanelCommandEvent } from '../../utils/panelCommands'
import { FOCUS_RING_CLASS, TruncatedText } from './index'
import { FocusTrap } from './FocusTrap'
import { OVERLAY_SHELL_CLASS, overlayWidthStyle } from './tokens'

// The four canonical source groups the global-search palette organizes results
// into (T6), plus the two disk-backed groups: Files (name matches, plus the
// active workspace's open editors) and Text in files (content matches). The
// order here is the vertical order in the list and therefore the order the
// arrow keys traverse. "Agents & workspaces" folds in the workspace-filtering
// the sidebar "Search workspaces" box used to own.
type CommandGroup = PaletteCommandGroup

const PALETTE_GROUPS: readonly { key: CommandGroup; label: string }[] = [
  { key: 'agents', label: 'Agents & workspaces' },
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'actions', label: 'Actions' },
  { key: 'files', label: 'Files' },
  { key: 'content', label: 'Text in files' },
]

const groupRank = (group: CommandGroup): number => PALETTE_GROUPS.findIndex((entry) => entry.key === group)

// With no query, each group shows a short preview rather than its full contents,
// so the first frame stays calm and scannable instead of dumping every command.
const PREVIEW_PER_GROUP = 6

// Disk search is a subprocess per keystroke, so it waits for a pause the
// in-memory command filter does not need. 180ms is under the ~200ms that reads
// as lag while still collapsing a burst of typing into one ripgrep run.
const DISK_SEARCH_DEBOUNCE_MS = 180
// A single character matches most of a repo, and the cost is paid in the main
// process. File names stay cheap enough to match from the first character;
// content search — which reads every file's bytes — waits for a second.
const CONTENT_SEARCH_MIN_QUERY = 2
const PALETTE_FILE_SEARCH_LIMIT = 50
const PALETTE_CONTENT_SEARCH_LIMIT = 100

// Stable empty fallbacks so store selectors returning a default don't churn refs.
const EMPTY_SPECIALIST_ORDER: SpecialistActionId[] = []
const EMPTY_DISABLED_SPECIALIST_PACKS: string[] = []
const EMPTY_SEARCH_EXCLUDES: string[] = []

// Results are labelled by their path inside the workspace: an absolute path
// repeats the workspace root on every row and pushes the part that identifies
// the file off the end of the line.
function workspaceRelativePath(rootPath: string, filePath: string): string {
  const root = rootPath.replace(/[\\/]+$/u, '')
  if (!filePath.toLowerCase().startsWith(root.toLowerCase())) return filePath
  return filePath.slice(root.length).replace(/^[\\/]+/u, '')
}

interface Command {
  id: string
  label: string
  description?: string
  // Extra match text that is searched but never displayed — used so a workspace
  // switch row still matches on its type label and curated search terms (e.g.
  // "kanban", "watchtower") the way the retired sidebar search did, without
  // crowding those terms into the visible description.
  keywords?: string
  shortcut?: string
  group: CommandGroup
  run: () => void
}

// A command shape before its source group is stamped on — used by the
// panel/registry sub-lists that are all one group, so the group is applied once
// where they are composed instead of repeated on every literal.
type UngroupedCommand = Omit<Command, 'group'>

/**
 * Dispatch a panel command. Panel components listen on `window` for
 * `multicode:panel-command` events and run the local action that corresponds
 * to the command id. The id is `<panel>.<verb>.<noun>` so it matches the
 * overflow item / settings popover row of the same capability.
 */
function dispatchPanelCommand(id: string) {
  dispatchPanelCommandEvent(id)
}

interface Props {
  onClose: () => void
  onNewWorkspace: () => void
  onNewChat: () => void
  onConnectRailway: () => void
  onSpawnSpecialist: (specialistId: SpecialistActionId) => void
  workspaceWindowId: WorkspaceWindowId
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  // The active command scopes and runtime availability that the keyboard
  // dispatcher uses, supplied by WorkspaceManager so the palette offers a panel
  // command only when the shortcut path would also run it.
  activeScopes: readonly CommandScope[]
  commandAvailability: CommandAvailabilityContext
  // The published context view module availability predicates evaluate
  // against — same object the dispatcher uses, so both stay in agreement.
  moduleCommandContext: ModuleCommandContext
  // Which groups the palette opens filtered to. ⌘K opens `all`; ⌘⇧F opens
  // `files`. Absent behaves as `all`, so existing call sites are unchanged.
  initialScope?: PaletteScope
}

export default function CommandPalette({
  onClose,
  onNewWorkspace,
  onNewChat,
  onConnectRailway,
  onSpawnSpecialist,
  workspaceWindowId,
  workspaces,
  activeWorkspaceId,
  activeScopes,
  commandAvailability,
  moduleCommandContext,
  initialScope = 'all',
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [scope, setScope] = useState<PaletteScope>(initialScope)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRowRef = useRef<HTMLDivElement>(null)
  const { setActiveWorkspaceForWindow, addWorkspace, setActiveFile, openExtensionsSurface } = useWorkspaceStore()
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const moduleEnablement = useWorkspaceStore((state) => state.appSettings.modules)
  const specialistOrder = useWorkspaceStore((state) => state.appSettings.specialistOrder ?? EMPTY_SPECIALIST_ORDER)
  const disabledSpecialistPacks = useWorkspaceStore(
    (state) => state.appSettings.specialistPacks?.disabled ?? EMPTY_DISABLED_SPECIALIST_PACKS,
  )
  const sprintEngineRoleRegistry = useWorkspaceStore((state) => state.sprintEngineRoleRegistry)
  // Specialist spawn commands are sourced from the role registry, not a bundled
  // catalog: no installed pack → no specialist rows in the palette (the other
  // command groups are unaffected).
  const specialistActions = useMemo(
    () =>
      orderSpecialistActions(
        specialistOrder,
        resolveEnabledSpecialists(disabledSpecialistPacks, listSpecialistPacks(sprintEngineRoleRegistry)),
      ),
    [specialistOrder, disabledSpecialistPacks, sprintEngineRoleRegistry],
  )
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = (commandId: string): string | undefined =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const openFiles = activeWorkspace?.editorState?.openFiles ?? []
  const activeFolderPath = activeWorkspace?.folderPath ?? null
  const searchExcludes = useWorkspaceStore((state) => state.appSettings.searchExcludes ?? EMPTY_SEARCH_EXCLUDES)

  // Disk-backed results. The palette's Files group used to list only the editors
  // already open, so the launcher could not find a file the user had never
  // opened — let alone a line of text inside one. These two are the same ripgrep
  // the "Search in files" panel runs, driven off the palette query.
  //
  // Note the main process keys one active content search per sender (window), so
  // this and an open ContentSearchPanel supersede each other's ripgrep child.
  // Harmless — both re-run on their next keystroke — but it is why the cancel
  // below is unconditional rather than tracked per surface.
  const [fileMatches, setFileMatches] = useState<FileSearchEntry[]>([])
  const [contentMatches, setContentMatches] = useState<ContentSearchEntry[]>([])
  const [diskSearching, setDiskSearching] = useState(false)
  const [diskSearchError, setDiskSearchError] = useState<string | null>(null)
  // Monotonic request id: ripgrep runs are cancelled but not instantaneous, so a
  // slow earlier run must not overwrite the results of a later one.
  const diskSeqRef = useRef(0)

  const trimmedQuery = query.trim()

  useEffect(() => {
    if (!activeFolderPath || !trimmedQuery) {
      diskSeqRef.current += 1
      setFileMatches([])
      setContentMatches([])
      setDiskSearching(false)
      setDiskSearchError(null)
      return
    }

    const requestSeq = ++diskSeqRef.current
    setDiskSearching(true)
    setDiskSearchError(null)
    let searchStarted = false

    const timeout = window.setTimeout(() => {
      searchStarted = true
      const wantsContent = trimmedQuery.length >= CONTENT_SEARCH_MIN_QUERY
      void Promise.all([
        window.api
          .searchFiles(activeFolderPath, trimmedQuery, {
            limit: PALETTE_FILE_SEARCH_LIMIT,
            excludes: searchExcludes,
          })
          .catch((error: unknown) => ({ ok: false as const, message: String(error), engine: null })),
        wantsContent
          ? window.api
              .searchContent(activeFolderPath, trimmedQuery, {
                limit: PALETTE_CONTENT_SEARCH_LIMIT,
                excludes: searchExcludes,
              })
              .catch((error: unknown) => ({ ok: false as const, message: String(error), engine: null }))
          : Promise.resolve(null),
      ]).then(([fileResult, contentResult]) => {
        if (requestSeq !== diskSeqRef.current) return
        setFileMatches(fileResult.ok ? fileResult.results : [])
        setContentMatches(contentResult?.ok ? contentResult.results : [])
        // Only a failure the user would otherwise read as "no matches" is worth
        // surfacing; a cancelled run resolves ok with an empty list.
        const failure = !fileResult.ok ? fileResult.message : contentResult && !contentResult.ok ? contentResult.message : null
        setDiskSearchError(failure)
        setDiskSearching(false)
      })
    }, DISK_SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeout)
      // Superseded or unmounted: stop the ripgrep child rather than let it run
      // the whole tree for a query nobody is waiting on.
      if (searchStarted) void window.api.cancelContentSearch().catch(() => {})
    }
  }, [activeFolderPath, searchExcludes, trimmedQuery])

  // Skills source (T6). Built-in skills are global and always listed; installed
  // skill packs are workspace-scoped, so they load only when a workspace is
  // open. Loading is best-effort: these are an auxiliary group, so a failed
  // list leaves the Skills group empty rather than breaking the palette — the
  // command/action/agent groups do not depend on it. Selecting a skill opens the
  // Connectors surface, which is where skills are browsed, installed, and
  // managed; per-skill deep-linking is deferred with the rest of global content
  // navigation (DEF-4).
  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([])
  const [installedSkills, setInstalledSkills] = useState<WorkspaceSkill[]>([])

  useEffect(() => {
    let cancelled = false
    void window.api
      .builtinSkillsList()
      .then((skills) => {
        if (!cancelled) setBuiltinSkills(skills)
      })
      .catch(() => {
        if (!cancelled) setBuiltinSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeFolderPath) {
      setInstalledSkills([])
      return
    }
    let cancelled = false
    void window.api
      .workspaceSkillsList({ workspaceRoot: activeFolderPath })
      .then((result) => {
        if (cancelled) return
        // Only what the workspace actually holds, and only what the bundled
        // list above does not already carry: a builtin listed twice would be
        // two palette rows running the same skill.
        setInstalledSkills(
          result.ok
            ? result.skills.filter(
                (skill) => skill.installState !== 'available' && skill.source !== 'builtin',
              )
            : [],
        )
      })
      .catch(() => {
        if (!cancelled) setInstalledSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [activeFolderPath])

  // Initial focus into the input, and focus back to whatever opened the palette
  // when it closes — the same open/close contract `Modal` carries, so dismissing
  // the palette leaves the keyboard where it started (MC-2109). Its own effect,
  // with no dependencies: a re-created `onClose` must not re-run focus and pull
  // the caret out of the input mid-search.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A child surface (menu, popover) that already handled Escape marks the
      // event; the palette must not also close — same guard Modal carries.
      if (event.defaultPrevented) return
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commands = useMemo((): Command[] => {
    const runPanel = (id: string) => () => {
      dispatchPanelCommand(id)
      onClose()
    }
    // A panel command is offered only when its scope is active and its runtime
    // preconditions are met — the exact predicate the keyboard dispatcher
    // applies. Rows that fail are dropped rather than left to silently no-op, so
    // the palette and the shortcut path always agree on availability. The panel
    // that owns the command still performs the final precondition check and
    // surfaces a real diagnostic if state changed between open and run.
    const panelCommandEnabled = (id: string): boolean =>
      isCommandIdEnabled(id, activeScopes, commandAvailability)
    // verify-progress requires an architect on the roster and focus-agent
    // requires a focusable running/waiting agent; both come through the shared
    // availability context, so a row only appears when the shortcut would run.
    const sprintEngineCommands: UngroupedCommand[] = [
      { id: 'sprintengine.verify.progress', label: 'Sprint: Verify progress', run: runPanel('sprintengine.verify.progress') },
      { id: 'sprintengine.add.role', label: 'Sprint: More roles', run: runPanel('sprintengine.add.role') },
      { id: 'sprintengine.read.plan', label: 'Sprint: Read plan', run: runPanel('sprintengine.read.plan') },
      { id: 'sprintengine.focus.agent', label: 'Sprint: Focus active agent', run: runPanel('sprintengine.focus.agent') },
      { id: 'sprintengine.refresh.board', label: 'Sprint: Refresh board', run: runPanel('sprintengine.refresh.board') },
      { id: 'sprintengine.goto.inbox', label: 'Sprint: Inbox', shortcut: shortcutFor('sprintengine.goto.inbox'), run: runPanel('sprintengine.goto.inbox') },
      { id: 'sprintengine.goto.roster', label: 'Sprint: Agents', shortcut: shortcutFor('sprintengine.goto.roster'), run: runPanel('sprintengine.goto.roster') },
      { id: 'sprintengine.goto.tasks', label: 'Sprint: Tasks', shortcut: shortcutFor('sprintengine.goto.tasks'), run: runPanel('sprintengine.goto.tasks') },
      { id: 'sprintengine.goto.graph', label: 'Sprint: Tasks → Graph layout', shortcut: shortcutFor('sprintengine.goto.graph'), run: runPanel('sprintengine.goto.graph') },
      { id: 'sprintengine.goto.kanban', label: 'Sprint: Tasks → Kanban layout', shortcut: shortcutFor('sprintengine.goto.kanban'), run: runPanel('sprintengine.goto.kanban') },
      { id: 'sprintengine.open.settings', label: 'Sprint: Run configuration', shortcut: shortcutFor('sprintengine.open.settings'), run: runPanel('sprintengine.open.settings') },
    ].filter((command) => panelCommandEnabled(command.id))
    // Git refresh/fetch/commit run the Git panel's real handlers; the shared
    // availability context (gitPanelActive) keeps them listed only while the Git
    // panel is open, so a selection cannot land on an unmounted handler. They are
    // targeted at the active workspace so commit never fires in a background repo.
    const runGitPanel = (id: string) => () => {
      dispatchPanelCommandEvent(id, activeWorkspaceId ?? undefined)
      onClose()
    }
    const gitCommands: UngroupedCommand[] = [
      { id: 'git.refresh', label: 'Git: Refresh status', shortcut: shortcutFor('git.refresh'), run: runGitPanel('git.refresh') },
      { id: 'git.fetch', label: 'Git: Fetch remotes', shortcut: shortcutFor('git.fetch'), run: runGitPanel('git.fetch') },
      { id: 'git.commit', label: 'Git: Commit staged changes', shortcut: shortcutFor('git.commit'), run: runGitPanel('git.commit') },
    ].filter((command) => panelCommandEnabled(command.id))
    const panelToggleCommands: UngroupedCommand[] = activeWorkspace
      ? [
          {
            id: 'panel.files.toggle',
            label: 'Toggle File Explorer',
            shortcut: shortcutFor('panel.files.toggle'),
            run: () => {
              togglePanelRailComponent(activeWorkspace.id, 'explorer', 'Files')
              onClose()
            },
          },
          {
            id: 'panel.editor.toggle',
            label: 'Toggle Code Editor',
            shortcut: shortcutFor('panel.editor.toggle'),
            run: () => {
              togglePanelRailComponent(activeWorkspace.id, 'editor', 'Editor')
              onClose()
            },
          },
          {
            id: 'panel.git.toggle',
            label: 'Toggle Git Panel',
            shortcut: shortcutFor('panel.git.toggle'),
            run: () => {
              togglePanelRailComponent(activeWorkspace.id, 'git', 'Git')
              onClose()
            },
          },
          // The Knowledge Graph has no rail glyph, so this row (and the View
          // menu) is its entry point. Availability-gated like the panel
          // commands: hidden while the memory-graph module is disabled.
          ...(panelCommandEnabled('panel.knowledge-graph.toggle')
            ? [
                {
                  id: 'panel.knowledge-graph.toggle',
                  label: 'Toggle Knowledge Graph',
                  shortcut: shortcutFor('panel.knowledge-graph.toggle'),
                  run: () => {
                    togglePanelRailComponent(activeWorkspace.id, 'memory-graph', 'Knowledge Graph')
                    onClose()
                  },
                },
              ]
            : []),
        ]
      : []
    // Commands contributed by enabled capability modules, gated by the same
    // scope + availability predicate as built-in panel commands. Rows label as
    // "<category>: <title>" so a module's commands read like the built-in
    // groups; the handler is the module's own callback.
    const moduleCommands: UngroupedCommand[] = getRendererHost()
      .getModuleCommands((moduleId) => selectModuleEnabled(moduleEnablement, moduleId))
      .filter((moduleCommand) => isCommandEnabled(moduleCommand, activeScopes, commandAvailability, moduleCommandContext))
      .map((moduleCommand) => ({
        id: moduleCommand.id,
        label: `${moduleCommand.category}: ${moduleCommand.title}`,
        shortcut:
          getEffectiveKeybindingLabel(moduleCommand.id, keybindingSettings, keybindingPlatform, moduleCommand)
          ?? undefined,
        run: () => {
          void moduleCommand.run()
          onClose()
        },
      }))

    // Registry- and panel-backed commands are all one source group; stamp it
    // once here rather than on every literal above.
    const registryCommands: Command[] = [
      ...panelToggleCommands,
      ...gitCommands,
      ...sprintEngineCommands,
      ...moduleCommands,
    ].map((command) => ({ ...command, group: 'commands' as const }))

    // Skills: built-in skills first, then installed skill packs. Both route to
    // the Plugins modal (their management home) on select.
    const skillCommands: Command[] = [
      ...builtinSkills.map((skill) => ({
        id: `skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills' as const,
        run: () => {
          openExtensionsSurface()
          onClose()
        },
      })),
      ...installedSkills.map((skill) => ({
        id: `installed-skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills' as const,
        run: () => {
          openExtensionsSurface()
          onClose()
        },
      })),
    ]

    return [
      // Agents & workspaces — the switch targets that absorb the sidebar's
      // former "Search workspaces" box. Rail-hidden workspaces are never a switch
      // target: the palette mirrors the rail/hotkey navigation surfaces exactly,
      // so the background Automations host and (since item 1767) sprint runs stay
      // out. A sprint is found on the Sprints door, which lists every run across
      // every project — including the historical ones no workspace holds. The
      // folder path rides `description` so typing a path filters here too,
      // preserving the sidebar's path matching.
      ...workspaces
        .filter((workspace) => !isHiddenFromRail(workspace))
        .map((workspace): Command => ({
          id: `switch-${workspace.id}`,
          label: `Switch to: ${workspace.name}`,
          description:
            workspace.folderPath ?? (workspace.id === activeWorkspaceId ? 'active workspace' : undefined),
          keywords: workspaceSearchKeywords(workspace.mode),
          group: 'agents',
          run: () => {
            setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
            onClose()
          },
        })),
      ...skillCommands,
      ...registryCommands,
      // Actions — the create/spawn/connect verbs.
      {
        id: 'new-chat',
        label: 'New Chat',
        description: activeWorkspace?.folderPath ? 'Create a one-agent chat in the current project' : 'Create a one-agent chat',
        group: 'actions' as const,
        run: () => {
          onNewChat()
          onClose()
        },
      },
      ...LAYOUT_TEMPLATES.map((template): Command => ({
        id: `new-${template.id}`,
        label: `New Workspace: ${template.name}`,
        description: template.description,
        group: 'actions' as const,
        run: () => {
          addWorkspace(template, { windowId: workspaceWindowId })
          onClose()
        },
      })),
      ...(activeWorkspace
        ? [
            ...specialistActions.map((action): Command => ({
              id: `spawn-specialist-${action.id}`,
              label: `Spawn: ${action.label}`,
              description: `${action.shortLabel} specialist with the selected CLI`,
              shortcut: getSpecialistCommandId(action.id) ? shortcutFor(getSpecialistCommandId(action.id)!) : undefined,
              group: 'actions' as const,
              run: () => {
                onSpawnSpecialist(action.id)
                onClose()
              },
            })),
            {
              id: 'content-search',
              label: 'Search: File Contents',
              description: activeWorkspace.folderPath ?? 'Open content search',
              group: 'actions' as const,
              run: () => {
                focusOrAddComponentTab(activeWorkspace.id, 'content-search', 'Content Search')
                onClose()
              },
            },
            {
              id: 'git.worktrees.open',
              label: 'Git: Manage Worktrees',
              description: activeWorkspace.folderPath ?? 'Open the Git panel',
              shortcut: shortcutFor('git.worktrees.open'),
              group: 'commands' as const,
              run: () => {
                revealNavRailComponent(activeWorkspace.id, 'git', 'Git')
                onClose()
              },
            },
            {
              id: 'connector.railway.connect',
              label: 'Connect: Railway',
              description: 'Start a new chat with the Railway connector attached',
              group: 'actions' as const,
              run: () => {
                onConnectRailway()
                onClose()
              },
            },
          ]
        : []),
      // Files — the active workspace's open editors.
      ...(activeWorkspaceId
        ? openFiles.map((file): Command => ({
            id: `file-${file.path}`,
            label: file.name,
            description: file.path,
            group: 'files',
            run: () => {
              setActiveFile(activeWorkspaceId, file.path)
              openFileSurface({ workspaceId: activeWorkspaceId, path: file.path, name: file.name })
              onClose()
            },
          }))
        : []),
      {
        id: 'workspace.new',
        label: 'New Workspace...',
        shortcut: shortcutFor('workspace.new'),
        group: 'actions' as const,
        run: () => {
          onNewWorkspace()
          onClose()
        },
      },
    ]
  }, [workspaces, activeWorkspace, activeWorkspaceId, openFiles, addWorkspace, setActiveWorkspaceForWindow, setActiveFile, openExtensionsSurface, onClose, onNewChat, onNewWorkspace, onConnectRailway, onSpawnSpecialist, workspaceWindowId, keybindingPlatform, keybindingSettings, activeScopes, commandAvailability, moduleCommandContext, moduleEnablement, builtinSkills, installedSkills, specialistActions])

  // Disk results are already matched — ripgrep did the matching in the main
  // process — so they are assembled apart from `commands` and never run back
  // through `commandMatchesQuery`, which would re-filter a content hit against
  // its own line text and drop every match whose query spans a word boundary.
  const diskCommands = useMemo((): Command[] => {
    if (!activeWorkspaceId || !activeFolderPath) return []

    const openFilePaths = new Set(openFiles.map((file) => file.path))
    const openOnDisk = (path: string, name: string, lineNumber?: number, column?: number) => {
      void window.api
        .readfile(path)
        .then((content) => {
          openFileSurface({ workspaceId: activeWorkspaceId, path, name, content, lineNumber, column })
        })
        .catch(() => {
          // A file ripgrep listed can be gone by the time it is picked (a branch
          // switch, a build). Opening is best-effort; the palette is closing.
        })
      onClose()
    }

    return [
      // A file already open is listed by the in-memory Files rows above; listing
      // it again from disk would put the same file in the group twice.
      ...fileMatches
        .filter((entry) => !openFilePaths.has(entry.path))
        .map((entry): Command => ({
          id: `disk-file-${entry.path}`,
          label: entry.name,
          description: workspaceRelativePath(activeFolderPath, entry.path),
          group: 'files',
          run: () => openOnDisk(entry.path, entry.name),
        })),
      ...contentMatches.map((entry, index): Command => ({
        // Line and column are part of the id: one file legitimately contributes
        // many rows, and React keys and the selection index both need them apart.
        id: `disk-content-${entry.path}:${entry.lineNumber}:${entry.column}:${index}`,
        // The matched line is the row's identity here — the file path is the
        // supporting detail, which is the inverse of the Files group.
        label: entry.lineText.trim() || entry.matchText,
        description: `${workspaceRelativePath(activeFolderPath, entry.path)}:${entry.lineNumber}`,
        group: 'content',
        run: () => openOnDisk(entry.path, entry.name, entry.lineNumber, entry.column),
      })),
    ]
  }, [activeFolderPath, activeWorkspaceId, contentMatches, fileMatches, onClose, openFiles])

  // Matches are ordered by group so the arrow keys traverse the same top-to-
  // bottom order the grouped list renders in. With no query each group shows a
  // capped preview; a query searches every group at once.
  const filtered = useMemo((): Command[] => {
    const q = query.trim().toLowerCase()
    const inScope = (command: Command) => groupInScope(command.group, scope)
    const matched = q ? commands.filter((command) => commandMatchesQuery(command, q)) : commands
    // Disk results exist only for a query — with an empty one there is nothing
    // to have searched for, so the resting palette stays the launcher it was.
    const all = q ? [...matched.filter(inScope), ...diskCommands] : matched.filter(inScope)
    const ordered = [...all].sort((a, b) => groupRank(a.group) - groupRank(b.group))
    if (q) return ordered
    const perGroup = new Map<CommandGroup, number>()
    return ordered.filter((command) => {
      const count = (perGroup.get(command.group) ?? 0) + 1
      perGroup.set(command.group, count)
      return count <= PREVIEW_PER_GROUP
    })
  }, [commands, diskCommands, query, scope])

  const groupedResults = useMemo(
    () =>
      PALETTE_GROUPS.map((group) => ({
        ...group,
        items: filtered.filter((command) => command.group === group.key),
      })).filter((group) => group.items.length > 0),
    [filtered],
  )

  // The flat selection index for each command, so a row can highlight/scroll
  // without an O(n) indexOf scan per render.
  const flatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    filtered.forEach((command, index) => map.set(command.id, index))
    return map
  }, [filtered])

  // Keep the highlighted row in view as the selection moves by keyboard.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, filtered.length - 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(current - 1, 0))
    }
    if (event.key === 'Enter') {
      filtered[selected]?.run()
    }
    // Backspace at an empty query pops the scope token, the way it pops a chip
    // in a token field — so ⌘⇧F's narrowing is reversible from the keyboard
    // without reaching for the mouse or reopening as ⌘K.
    if (event.key === 'Backspace' && !query && scope !== 'all') {
      event.preventDefault()
      setScope('all')
      setSelected(0)
    }
  }

  const activeOptionId = filtered[selected] ? `palette-option-${filtered[selected].id}` : undefined

  return (
    <div
      className="overlay-scrim fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh]"
      // `mousedown`, matching `Modal`: on `click`, a drag that STARTED inside
      // the palette (selecting the query text) and was released over the scrim
      // dismisses it, which reads as the palette closing itself (MC-2109).
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      {/* The palette is a modal surface like any other: it says so (`role`,
          `aria-modal`), and the trap is what makes the claim true (MC-2109). */}
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          tabIndex={-1}
          style={overlayWidthStyle('palette')}
          // The palette keeps its own scrim — it sits at 15vh rather than
          // centred, which no dialog does — but not its own geometry: shell
          // chrome and width both come from the scale, so `Modal` and this read
          // as the same surface at last (MC-2110). `overflow-hidden` is the one
          // local addition: the input's bottom rule has to be clipped by the
          // shell's corners.
          className={`${OVERLAY_SHELL_CLASS} overflow-hidden outline-none`}
        >
          <div className="flex items-center gap-2 border-b border-[color:var(--border-default)] px-4 py-3">
            {scope === 'files' ? (
              // The scope reads as a removable token, the way a filter chip does
              // in the panels: it says what the palette is narrowed to, and
              // clicking it (or Backspace at an empty query) widens back to the
              // full launcher without reopening the overlay.
              <button
                type="button"
                onClick={() => {
                  setScope('all')
                  setSelected(0)
                  inputRef.current?.focus()
                }}
                aria-label="Search everything instead of files"
                className={`flex shrink-0 items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--bg-surface-raised)] px-2 py-0.5 text-micro text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
              >
                Files
                {/* The kit's close mark, at the chip's scale — the same stroke
                    CloseIconButton draws, not a literal ✕ character. */}
                <svg className="icon-xs" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path
                    d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : (
              <span className="text-heading text-[color:var(--text-disabled)]">⌘</span>
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setSelected(0)
              }}
              onKeyDown={handleKey}
              placeholder={
                scope === 'files'
                  ? 'Search file names and text in files...'
                  : 'Search agents, skills, commands, files, text...'
              }
              aria-label={
                scope === 'files'
                  ? 'Search file names and text in files'
                  : 'Search agents, skills, commands, files, and text in files'
              }
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-controls="command-palette-results"
              aria-activedescendant={activeOptionId}
              className={`flex-1 bg-transparent text-heading text-[color:var(--text-strong)] placeholder-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
            />
            {/* Disk search is the one part of the palette that is not instant, so
                it is the one part that says it is working. */}
            {diskSearching && (
              <span role="status" className="shrink-0 text-micro text-[color:var(--text-disabled)]">
                Searching…
              </span>
            )}
          </div>

          <div id="command-palette-results" role="listbox" aria-label="Search results" className="max-h-[360px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              // "No results" is only true once the search that would have
              // produced them has finished, and only meaningful when there was a
              // folder to search in the first place.
              <p className="px-4 py-3 text-meta text-[color:var(--text-muted)]">
                {diskSearchError
                  ? diskSearchError
                  : diskSearching
                    ? 'Searching…'
                    : trimmedQuery && !activeFolderPath
                      ? 'Open a folder to search files and their contents.'
                      : 'No results'}
              </p>
            ) : (
              groupedResults.map((group) => (
                <div key={group.key} role="group" aria-label={group.label}>
                  <div
                    aria-hidden="true"
                    className="flex items-center gap-3 px-4 pb-1 pt-2 text-micro font-medium text-[color:var(--text-disabled)]"
                  >
                    <span>{group.label}</span>
                    <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                    <span className="tabular-nums">{group.items.length}</span>
                  </div>
                  {group.items.map((command) => {
                    const index = flatIndexById.get(command.id) ?? -1
                    const isSelected = index === selected
                    return (
                      <div
                        key={command.id}
                        ref={isSelected ? selectedRowRef : undefined}
                        id={`palette-option-${command.id}`}
                        role="option"
                        aria-selected={isSelected}
                        onClick={command.run}
                        onMouseEnter={() => setSelected(index)}
                        className={`flex cursor-pointer items-center justify-between px-4 py-2 transition-colors ${
                          isSelected
                            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                        }`}
                      >
                        <div className="min-w-0">
                          {/* A content hit's label is a line of source, not a
                              title: it reads in mono at body size, with the
                              file:line beneath it as the locator. */}
                          <TruncatedText
                            as="div"
                            text={command.label}
                            className={command.group === 'content' ? 'font-mono text-meta' : 'text-heading'}
                          />
                          {command.description && (
                            <TruncatedText
                              as="div"
                              text={command.description}
                              className={`mt-0.5 text-micro text-[color:var(--text-disabled)] ${command.group === 'content' ? 'font-mono' : ''}`}
                            />
                          )}
                        </div>
                        {command.shortcut && (
                          <kbd className="ml-3 shrink-0 rounded bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-micro text-[color:var(--text-disabled)]">
                            {command.shortcut}
                          </kbd>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </FocusTrap>
    </div>
  )
}
