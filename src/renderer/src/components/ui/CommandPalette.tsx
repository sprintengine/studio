import React, { useEffect, useMemo, useRef, useState } from 'react'
import { orderSpecialistActions } from '../../specialists/specialistActions'
import { listSpecialistPacks, resolveEnabledSpecialists } from '../../specialists/specialistPacks'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { SpecialistActionId, Workspace, WorkspaceId, WorkspaceWindowId } from '../../types/workspace'
import type { BuiltinSkill, WorkspaceSkill } from '../../../../shared/electron-api'
import { focusOrAddComponentTab, togglePanelRailComponent } from '../../utils/modelRegistry'
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
  orderPaletteCommands,
  workspaceSearchKeywords,
  type PaletteCommandGroup,
  type PaletteScope,
} from '../commandPaletteSearch'
import {
  usePaletteProviders,
  type PaletteCommand,
  type PaletteProviderContext,
  type PaletteResultProvider,
} from '../palette/paletteProvider'
import {
  createExtensionsProvider,
  EXTENSION_ROWS_PER_GROUP,
  PALETTE_ROW_ICON_SIZE,
  type ExtensionPluginRow,
  type ExtensionSkillRow,
  type ExtensionSourceRow,
} from '../palette/extensionsProvider'
import {
  decidePaletteTarget,
  handSkillToAgent,
  installPluginRow,
  installSkillRow,
  planPluginRow,
  type ExtensionActionOutcome,
  type ResolvedSkillOutcome,
} from '../palette/extensionsActions'
import type { PaletteAgentTarget } from '../palette/paletteOpenRequest'
import {
  listLiveAgentSessions,
  resolveWorkspaceSkill,
  NO_LIVE_AGENT_MESSAGE,
  NO_WORKSPACE_FOLDER_MESSAGE,
  type LiveAgentSession,
} from '../../utils/useSkillInAgent'
import { requestTerminalFocus, type TerminalFocusTarget } from '../../utils/terminalFocusRequest'
import { getExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import { dispatchExtensionsSurfaceTarget } from '../workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { showToast } from '../../store/toastStore'
import { dispatchPanelCommandEvent } from '../../utils/panelCommands'
import { ExtensionIcon } from './ExtensionIcon'
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

const PALETTE_GROUP_LABELS: Record<CommandGroup, string> = {
  agents: 'Agents & workspaces',
  skills: 'Skills',
  // Everything a source offers that is not a bare skill: the plugins its
  // marketplace lists, and the first-party registry's entries.
  extensions: 'Plugins',
  commands: 'Commands',
  actions: 'Actions',
  files: 'Files',
  content: 'Text in files',
}

/** The one sentence the input asks for, per scope. */
const PALETTE_PLACEHOLDER: Record<PaletteScope, string> = {
  all: 'Search agents, skills, plugins, commands, files, text...',
  files: 'Search file names and text in files...',
  extensions: 'Search every skill and plugin, installed or not...',
}

const PALETTE_INPUT_LABEL: Record<PaletteScope, string> = {
  all: 'Search agents, skills, plugins, commands, files, and text in files',
  files: 'Search file names and text in files',
  extensions: 'Search every skill and plugin in every source',
}

/** What the scope chip says it is narrowed to, and what widening it means. */
const SCOPE_CHIPS: Record<Exclude<PaletteScope, 'all'>, { label: string; widenLabel: string }> = {
  files: { label: 'Files', widenLabel: 'Search everything instead of files' },
  extensions: {
    label: 'Skills & plugins',
    widenLabel: 'Search everything instead of skills and plugins',
  },
}

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
// The disk provider is memoized on the open-file list, and a fresh `[]` every
// render would rebuild it every render — which, since the runner re-runs a
// provider whose identity changed, would restart ripgrep on every render.
const EMPTY_OPEN_FILES: NonNullable<Workspace['editorState']>['openFiles'] = []

// Results are labelled by their path inside the workspace: an absolute path
// repeats the workspace root on every row and pushes the part that identifies
// the file off the end of the line.
function workspaceRelativePath(rootPath: string, filePath: string): string {
  const root = rootPath.replace(/[\\/]+$/u, '')
  if (!filePath.toLowerCase().startsWith(root.toLowerCase())) return filePath
  return filePath.slice(root.length).replace(/^[\\/]+/u, '')
}

// The row shape is `PaletteCommand` (components/palette/paletteProvider.ts):
// it is what the providers produce, so it cannot be private to this file any
// more. `keywords` is still extra match text that is searched but never
// displayed — a workspace switch row matches on its type label and curated
// search terms ("kanban", "roster") the way the retired sidebar search did,
// without crowding those terms into the visible description.
type Command = PaletteCommand

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
  onNewChat: () => void
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
  // Which groups the palette opens filtered to. ⌘K and Shift Shift open `all`;
  // ⌘⇧F opens `files`; the terminal's star opens `extensions`. Absent behaves
  // as `all`, so existing call sites are unchanged.
  initialScope?: PaletteScope
  /**
   * The agent a chosen skill lands in without asking — the pane the palette was
   * opened FOR. The terminal star passes its own session, which is what turns
   * "find a skill, install it, use it here" into one keystroke and one Enter.
   * Absent means the palette works the target out (the focused agent, the only
   * live agent, or a question).
   */
  preferredTarget?: PaletteAgentTarget | null
}

export default function CommandPalette({
  onClose,
  onNewChat,
  onSpawnSpecialist,
  workspaceWindowId,
  workspaces,
  activeWorkspaceId,
  activeScopes,
  commandAvailability,
  moduleCommandContext,
  initialScope = 'all',
  preferredTarget = null,
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [scope, setScope] = useState<PaletteScope>(initialScope)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRowRef = useRef<HTMLDivElement>(null)
  const { setActiveWorkspaceForWindow, setActiveFile, openExtensionsSurface } = useWorkspaceStore()
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
  const openFiles = activeWorkspace?.editorState?.openFiles ?? EMPTY_OPEN_FILES
  const activeFolderPath = activeWorkspace?.folderPath ?? null

  // The workspace's own skills. Built-in skills are global and always listed;
  // installed skill packs are workspace-scoped, so they load only when a
  // workspace is open. Loading is best-effort: a failed list leaves the Skills
  // group thinner rather than breaking the palette.
  //
  // They are held here rather than inside a provider because TWO providers read
  // them — the installed-skills provider lists them, and the extensions
  // provider needs them to know which of a source's skills you already have.
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

  // The terminal an invocation was just parked in, when one was. Set right
  // before the palette closes over a successful paste, and read by the
  // focus-restore cleanup below: the whole point of the round trip is that the
  // person's next keystroke is Enter at THAT prompt, and "whatever opened the
  // palette" is the star button, or a sidebar, or a Monaco editor — not it.
  const focusAfterCloseRef = useRef<TerminalFocusTarget | null>(null)

  // Initial focus into the input, and focus back to whatever opened the palette
  // when it closes — the same open/close contract `Modal` carries, so dismissing
  // the palette leaves the keyboard where it started (MC-2109). Its own effect,
  // with no dependencies: a re-created `onClose` must not re-run focus and pull
  // the caret out of the input mid-search.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => {
      // The pane that took the paste, when a pane is still mounted to answer;
      // otherwise the opener, as before. `requestTerminalFocus` is synchronous
      // and says whether anyone took it, so there is no guessing here.
      const pasted = focusAfterCloseRef.current
      if (pasted && requestTerminalFocus(pasted)) return
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // Escape steps OUT of the "which agent" question before it closes the
  // palette: the question replaced the result list, and the way back to that
  // list must not be "reopen the palette and search again". Read through a ref
  // so the listener is not re-bound on every state change.
  const agentChoiceOpenRef = useRef(false)
  const dismissAgentChoiceRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A child surface (menu, popover) that already handled Escape marks the
      // event; the palette must not also close — same guard Modal carries.
      if (event.defaultPrevented) return
      if (event.key !== 'Escape') return
      if (agentChoiceOpenRef.current) {
        event.preventDefault()
        dismissAgentChoiceRef.current()
        return
      }
      onClose()
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
      { id: 'git.changes.showDiff', label: 'Git: Show diff for the selected file', shortcut: shortcutFor('git.changes.showDiff'), run: runGitPanel('git.changes.showDiff') },
      { id: 'git.changes.discard', label: 'Git: Discard changes in the selected files', shortcut: shortcutFor('git.changes.discard'), run: runGitPanel('git.changes.discard') },
      { id: 'git.changes.moveToChangelist', label: 'Git: Move the selected files to another changelist', shortcut: shortcutFor('git.changes.moveToChangelist'), run: runGitPanel('git.changes.moveToChangelist') },
    ].filter((command) => panelCommandEnabled(command.id))
    const panelToggleCommands: UngroupedCommand[] = activeWorkspace
      ? [
          {
            id: 'panel.files.toggle',
            label: 'Toggle File Explorer',
            searchLabel: 'File Explorer',
            shortcut: shortcutFor('panel.files.toggle'),
            run: () => {
              // Files is a workspace-pane tab (browser-pane epic).
              useWorkspaceStore.getState().togglePaneKind(activeWorkspace.id, 'files')
              onClose()
            },
          },
          {
            id: 'panel.editor.toggle',
            label: 'Toggle Code Editor',
            searchLabel: 'Code Editor',
            shortcut: shortcutFor('panel.editor.toggle'),
            run: () => {
              togglePanelRailComponent(activeWorkspace.id, 'editor', 'Editor')
              onClose()
            },
          },
          {
            id: 'panel.git.toggle',
            label: 'Toggle Git Panel',
            searchLabel: 'Git Panel',
            shortcut: shortcutFor('panel.git.toggle'),
            run: () => {
              useWorkspaceStore.getState().togglePaneKind(activeWorkspace.id, 'git')
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
                  searchLabel: 'Knowledge Graph',
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

    // Skills are a provider now (see below): they are one of three sources that
    // fetch, and the group also carries every skill the configured SOURCES hold.

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
          // The workspace's own name is the obvious query for this row, and
          // "Switch to: " in front of it would hold it to a word-start score
          // that any file beginning with the same letters beats.
          searchLabel: workspace.name,
          description:
            workspace.folderPath ?? (workspace.id === activeWorkspaceId ? 'active workspace' : undefined),
          keywords: workspaceSearchKeywords(workspace.mode),
          group: 'agents',
          run: () => {
            setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
            onClose()
          },
        })),
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
      ...(activeWorkspace
        ? [
            ...specialistActions.map((action): Command => ({
              id: `spawn-specialist-${action.id}`,
              label: `Spawn: ${action.label}`,
              searchLabel: action.label,
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
                useWorkspaceStore.getState().openPaneTab(activeWorkspace.id, { kind: 'git' })
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
    ]
  }, [workspaces, activeWorkspace, activeWorkspaceId, openFiles, setActiveWorkspaceForWindow, setActiveFile, onClose, onNewChat, onSpawnSpecialist, workspaceWindowId, keybindingPlatform, keybindingSettings, activeScopes, commandAvailability, moduleCommandContext, moduleEnablement, specialistActions])

  // ── Handing a result to an agent ────────────────────────────────────────
  //
  // Every skill row in this palette — one the workspace has, one a source
  // holds, one a plugin ships — ends in the same place: written where the
  // agent's CLI reads skills, with that CLI's own invocation parked at its
  // prompt, unsubmitted. What differs is only how the skill comes to exist,
  // which is what `prepare` carries.

  // The pane the person was last looking at in this workspace, so a workspace
  // with several agents still answers without a question.
  const focusedAgentId = useWorkspaceStore((state) =>
    state.activeWorkspaceId ? state.focusedAgentByWorkspaceId[state.activeWorkspaceId] : undefined,
  )
  const clis = useWorkspaceStore((state) => state.pluginCatalogEntries)

  // The second step, when there IS a question: which agent. It replaces the
  // result list rather than opening a menu over it — the palette is already a
  // keyboard surface with a selection, and a popover inside it would be a
  // second one to arrow around.
  const [agentChoice, setAgentChoice] = useState<{ title: string; options: Command[] } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  // The guard is a ref, not the state: the flow awaits the session list before
  // it sets anything, so two Enters inside that wait would both read `false`
  // from their own render closure and both run the whole trip — two installs
  // and two invocations parked at the agent — the same hole the door's menu
  // had, review 2026-09-10. The state still drives what the surface SAYS.
  const actionBusyRef = useRef(false)

  const runSkillFlow = async (skillName: string, prepare: () => Promise<ResolvedSkillOutcome>) => {
    if (actionBusyRef.current) return
    if (!activeFolderPath) {
      setActionError(NO_WORKSPACE_FOLDER_MESSAGE)
      return
    }
    const workspaceRoot = activeFolderPath
    const settle = (session: LiveAgentSession, outcome: ExtensionActionOutcome) => {
      actionBusyRef.current = false
      setActionBusy(false)
      if (!outcome.ok) {
        setActionError(outcome.message)
        return
      }
      // grok and opencode declare that they re-read their skills directory only
      // on restart, and nothing used to say so.
      if (outcome.toast) showToast(outcome.toast)
      // The invocation is at that agent's prompt, unsubmitted; the keyboard
      // goes there with it (see the focus-restore effect).
      focusAfterCloseRef.current =
        session.workspaceId && session.agentId
          ? { workspaceId: session.workspaceId, agentId: session.agentId }
          : null
      onClose()
    }
    const useIn = async (session: LiveAgentSession) => {
      if (actionBusyRef.current) return
      actionBusyRef.current = true
      setActionBusy(true)
      setActionError(null)
      const prepared = await prepare()
      if (!prepared.ok) {
        actionBusyRef.current = false
        setActionBusy(false)
        setActionError(prepared.message)
        return
      }
      settle(session, await handSkillToAgent({ workspaceRoot, skill: prepared.skill, session, clis }))
    }

    const sessions = await listLiveAgentSessions({ workspaceId: activeWorkspaceId })
    // The pane the palette was opened for wins while it is live and is never
    // replaced by a guess once it is not; with no pane named, the focused
    // agent, then one live agent — see `decidePaletteTarget` for the ruling.
    const decision = decidePaletteTarget(sessions, preferredTarget, focusedAgentId)
    if (decision.kind === 'use') {
      await useIn(decision.session)
      return
    }

    // "New agent…" is the shell's route, read from the door's host seam at
    // click time the way every other host action is — and offered only when a
    // shell is mounted to take it.
    const host = getExtensionsSurfaceHost()
    const options: Command[] = sessions.map((session): Command => ({
      id: `palette-agent-${session.sessionId}`,
      label: session.label,
      description: session.cli,
      group: 'agents',
      run: () => void useIn(session),
    }))
    if (host) {
      options.push({
        id: 'palette-agent-new',
        label: 'New agent…',
        description: `Start an agent with ${skillName} attached`,
        group: 'agents',
        run: () => {
          void (async () => {
            if (actionBusyRef.current) return
            actionBusyRef.current = true
            setActionBusy(true)
            setActionError(null)
            const prepared = await prepare()
            actionBusyRef.current = false
            setActionBusy(false)
            if (!prepared.ok) {
              setActionError(prepared.message)
              return
            }
            getExtensionsSurfaceHost()?.onUseSkillInNewAgent(prepared.skill)
            onClose()
          })()
        },
      })
    }
    if (options.length === 0) {
      setActionError(decision.notice ?? NO_LIVE_AGENT_MESSAGE)
      return
    }
    setActionError(decision.notice)
    setAgentChoice({ title: `Use ${skillName} in…`, options })
    setSelected(0)
  }
  agentChoiceOpenRef.current = agentChoice !== null
  dismissAgentChoiceRef.current = () => {
    setAgentChoice(null)
    setActionError(null)
    setSelected(0)
  }

  // A skill the workspace already has: nothing to install, just resolve it.
  const useInstalledSkill = (skillId: string, skillName: string) =>
    runSkillFlow(skillName, () =>
      resolveWorkspaceSkill({ workspaceRoot: activeFolderPath, skillId }),
    )

  // A skill a source holds: installed first when it is not in yet.
  const onSelectSkill = (row: ExtensionSkillRow) =>
    runSkillFlow(row.name, () => installSkillRow({ row, workspaceRoot: activeFolderPath }))

  // Open one plugin's detail pane in the Extensions door. The door is opened
  // first and the full target dispatched after, because the store's opener
  // latches a view-only target of its own and the last dispatch wins.
  const deepLinkToPlugin = (row: ExtensionPluginRow) => {
    openExtensionsSurface({ view: 'plugins' })
    dispatchExtensionsSurfaceTarget({
      view: 'plugins',
      pluginId: row.pluginId,
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
    })
    onClose()
  }

  // A source nothing has read yet: the read happens in the door, on purpose,
  // not as a side effect of a palette warm — so the row opens that source's
  // tab, where opening it IS the read.
  const onSelectSource = (row: ExtensionSourceRow) => {
    openExtensionsSurface({ view: 'skills' })
    dispatchExtensionsSurfaceTarget({ view: 'skills', sourceId: row.sourceId })
    onClose()
  }

  // A plugin: one press only when the answer is unambiguous AND safe. Hooks,
  // MCP servers, an unread linked repository, several skills or a first-party
  // registry entry all mean a page — see `planPluginRow`, which owns that ruling.
  const onSelectPlugin = (row: ExtensionPluginRow) => {
    const plan = planPluginRow(row)
    if (plan.kind === 'deep-link') {
      deepLinkToPlugin(row)
      return
    }
    return runSkillFlow(row.name, () =>
      installPluginRow({
        row,
        workspaceRoot: activeFolderPath,
        skillDirName: plan.skillDirName,
      }),
    )
  }

  // The providers below are memoized on their DATA, so they must not close over
  // handlers that are re-created every render; the refs are how a stable
  // provider reaches the current handler.
  const useInstalledSkillRef = useRef(useInstalledSkill)
  useInstalledSkillRef.current = useInstalledSkill
  const onSelectSkillRef = useRef(onSelectSkill)
  onSelectSkillRef.current = onSelectSkill
  const onSelectPluginRef = useRef(onSelectPlugin)
  onSelectPluginRef.current = onSelectPlugin
  const onSelectSourceRef = useRef(onSelectSource)
  onSelectSourceRef.current = onSelectSource

  // ── The three fetching sources ──────────────────────────────────────────
  //
  // Disk, installed skills, and every source's catalogue. They are providers
  // (components/palette/paletteProvider.ts) rather than three shapes bolted
  // onto this component: one of them debounces and cancels a subprocess, one
  // filters an array in memory, and one warms once and then filters — and the
  // runner is what knows the difference so this file does not have to.

  // Disk. The palette's Files group used to list only the editors already open,
  // so the launcher could not find a file the user had never opened — let alone
  // a line of text inside one. This is the same ripgrep the "Search in files"
  // panel runs, driven off the palette query.
  //
  // Note the main process keys one active content search per sender (window),
  // so this and an open ContentSearchPanel supersede each other's ripgrep
  // child. Harmless — both re-run on their next keystroke — but it is why the
  // cancel is unconditional rather than tracked per surface.
  const diskProvider = useMemo((): PaletteResultProvider => {
    const openFilePaths = new Set(openFiles.map((file) => file.path))
    return {
      id: 'disk',
      group: 'files',
      // Disk search is a subprocess per keystroke, so it waits for a pause the
      // in-memory filters do not need.
      debounceMs: DISK_SEARCH_DEBOUNCE_MS,
      minQueryLength: 1,
      cancel: () => {
        void window.api.cancelContentSearch().catch(() => {})
      },
      load: async (searchQuery, context): Promise<Command[]> => {
        if (!activeWorkspaceId || !activeFolderPath) return []
        const openOnDisk = (path: string, name: string, lineNumber?: number, column?: number) => {
          void window.api
            .readfile(path)
            .then((content) => {
              openFileSurface({ workspaceId: activeWorkspaceId, path, name, content, lineNumber, column })
            })
            .catch(() => {
              // A file ripgrep listed can be gone by the time it is picked (a
              // branch switch, a build). Opening is best-effort; the palette is
              // closing.
            })
          // Through the context rather than the captured prop: `onClose` is a
          // new function on most renders, and a provider rebuilt for that
          // reason would restart the search it is in the middle of.
          context.close()
        }
        // A single character matches most of a repo, and the cost is paid in
        // the main process. File names stay cheap enough to match from the
        // first character; content search — which reads every file's bytes —
        // waits for a second.
        const wantsContent = searchQuery.length >= CONTENT_SEARCH_MIN_QUERY
        const [fileResult, contentResult] = await Promise.all([
          window.api
            .searchFiles(activeFolderPath, searchQuery, { limit: PALETTE_FILE_SEARCH_LIMIT })
            .catch((error: unknown) => ({ ok: false as const, message: String(error), engine: null })),
          wantsContent
            ? window.api
                .searchContent(activeFolderPath, searchQuery, { limit: PALETTE_CONTENT_SEARCH_LIMIT })
                .catch((error: unknown) => ({ ok: false as const, message: String(error), engine: null }))
            : Promise.resolve(null),
        ])
        // Only a failure the user would otherwise read as "no matches" is worth
        // surfacing; a cancelled run resolves ok with an empty list.
        const failure = !fileResult.ok
          ? fileResult.message
          : contentResult && !contentResult.ok
            ? contentResult.message
            : null
        if (failure) throw new Error(failure)
        // Disk results are already matched — ripgrep did the matching in the
        // main process — so they carry no keywords and are never re-filtered
        // against their own line text, which would drop every match whose query
        // spans a word boundary.
        return [
          // A file already open is listed by the in-memory Files rows; listing
          // it again from disk would put the same file in the group twice.
          ...(fileResult.ok ? fileResult.results : [])
            .filter((entry) => !openFilePaths.has(entry.path))
            .map((entry): Command => ({
              id: `disk-file-${entry.path}`,
              label: entry.name,
              description: workspaceRelativePath(activeFolderPath, entry.path),
              group: 'files',
              run: () => openOnDisk(entry.path, entry.name),
            })),
          ...(contentResult?.ok ? contentResult.results : []).map((entry, index): Command => ({
            // Line and column are part of the id: one file legitimately
            // contributes many rows, and React keys and the selection index
            // both need them apart.
            id: `disk-content-${entry.path}:${entry.lineNumber}:${entry.column}:${index}`,
            // The matched line is the row's identity here — the file path is
            // the supporting detail, which is the inverse of the Files group.
            label: entry.lineText.trim() || entry.matchText,
            description: `${workspaceRelativePath(activeFolderPath, entry.path)}:${entry.lineNumber}`,
            group: 'content',
            run: () => openOnDisk(entry.path, entry.name, entry.lineNumber, entry.column),
          })),
        ]
      },
    }
  }, [activeFolderPath, activeWorkspaceId, openFiles])

  // The skills the workspace already has: the bundled ones and the packs it
  // installed. Selecting one hands it to a running agent — the same round trip
  // the doors run — instead of the old behaviour, which was to open the
  // Extensions door and leave the person to find the row again.
  const skillsProvider = useMemo((): PaletteResultProvider => {
    const rows: Command[] = [
      ...builtinSkills.map((skill): Command => ({
        id: `skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills',
        badge: 'Installed',
        installed: true,
        run: () => void useInstalledSkillRef.current(skill.id, skill.name),
      })),
      ...installedSkills.map((skill): Command => ({
        id: `installed-skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills',
        badge: 'Installed',
        installed: true,
        run: () => void useInstalledSkillRef.current(skill.id, skill.name),
      })),
    ]
    return {
      id: 'installed-skills',
      group: 'skills',
      respondsToEmptyQuery: true,
      load: (searchQuery) => orderPaletteCommands(rows, searchQuery).filter((row) => commandMatchesQuery(row, searchQuery)),
    }
  }, [builtinSkills, installedSkills])

  // Every skill and plugin every configured source holds, from the cached scans
  // the Extensions door reads — plus the first-party registry. This is the one
  // that makes the palette a search for things you have NOT installed.
  const installedDirNames = useMemo(
    () => new Set(installedSkills.map((skill) => skill.id)),
    [installedSkills],
  )
  // Constructed once, deliberately: it warms by reading every source's cached
  // scan, and a provider re-created because the inventory landed or the scope
  // chip was popped would throw that warm away and read them all again. The two
  // facts that DO change are read through refs at load time.
  const installedDirNamesRef = useRef(installedDirNames)
  installedDirNamesRef.current = installedDirNames
  // The cap is per group, and it is lifted when the palette is narrowed to
  // extensions: the scope IS the person saying they want the whole list.
  const rowLimitRef = useRef(EXTENSION_ROWS_PER_GROUP)
  rowLimitRef.current = scope === 'extensions' ? Number.MAX_SAFE_INTEGER : EXTENSION_ROWS_PER_GROUP
  const extensionsProvider = useMemo(
    () =>
      createExtensionsProvider({
        getInstalledDirNames: () => installedDirNamesRef.current,
        getLimit: () => rowLimitRef.current,
        onSelectSkill: (row) => void onSelectSkillRef.current(row),
        onSelectPlugin: (row) => void onSelectPluginRef.current(row),
        onSelectSource: (row) => onSelectSourceRef.current(row),
      }),
    [],
  )

  // Only the providers whose groups the scope admits. A provider whose rows
  // would be filtered out anyway must not RUN: Find-in-Path would otherwise
  // read every source's scan for a list it hides, and the terminal star would
  // start a ripgrep for a snippet nobody asked for.
  //
  // `scope` is a dependency of the ARRAY rather than of any provider in it:
  // popping the chip also lifts or reapplies the per-group cap, and a new array
  // is how the runner is told to ask again. The provider objects are unchanged,
  // so a warm already done is not repeated.
  const providers = useMemo(() => {
    const active: PaletteResultProvider[] = []
    if (groupInScope('skills', scope)) active.push(skillsProvider)
    if (groupInScope('extensions', scope)) active.push(extensionsProvider)
    if (groupInScope('files', scope)) active.push(diskProvider)
    return active
  }, [skillsProvider, extensionsProvider, diskProvider, scope])
  const providerContext = useMemo(
    (): PaletteProviderContext => ({
      workspaceRoot: activeFolderPath,
      workspaceId: activeWorkspaceId,
      scope,
      close: onClose,
    }),
    [activeFolderPath, activeWorkspaceId, scope, onClose],
  )
  const provided = usePaletteProviders(providers, query, providerContext)

  // Matches are ranked, then grouped in the order the ranking first mentions
  // each group — so the arrow keys traverse exactly what the eye reads, and a
  // row that scored best is not buried under a group that merely sorts earlier.
  // With no query each group shows a capped preview.
  const filtered = useMemo((): Command[] => {
    const q = query.trim()
    const inScope = (command: Command) => groupInScope(command.group, scope)
    const matched = q ? commands.filter((command) => commandMatchesQuery(command, q)) : commands
    const all = [...matched, ...provided.commands].filter(inScope)
    const ordered = orderPaletteCommands(all, q)
    if (q) return ordered
    const perGroup = new Map<CommandGroup, number>()
    return ordered.filter((command) => {
      const count = (perGroup.get(command.group) ?? 0) + 1
      perGroup.set(command.group, count)
      return count <= PREVIEW_PER_GROUP
    })
  }, [commands, provided.commands, query, scope])

  // Groups appear in the order the RANKING first mentions them, not in a fixed
  // order the ranking then fights: an exact skill-name match puts Skills at the
  // top, and the canonical order (PALETTE_GROUP_ORDER) is only the tie-break
  // inside the scorer. While the palette is asking which agent, the whole list
  // is that one question.
  const groupedResults = useMemo((): { key: CommandGroup; label: string; items: Command[] }[] => {
    if (agentChoice) return [{ key: 'agents', label: agentChoice.title, items: agentChoice.options }]
    const order: CommandGroup[] = []
    const items = new Map<CommandGroup, Command[]>()
    filtered.forEach((command) => {
      const existing = items.get(command.group)
      if (existing) existing.push(command)
      else {
        order.push(command.group)
        items.set(command.group, [command])
      }
    })
    return order.map((key) => ({ key, label: PALETTE_GROUP_LABELS[key], items: items.get(key) ?? [] }))
  }, [filtered, agentChoice])

  // The rows on screen, in the order they are drawn — which is what the arrow
  // keys traverse. Grouping compacts the ranked list (a group's rows are drawn
  // together), so the selection index is taken from the grouped order rather
  // than from `filtered`, or the highlight would drift off the row under it.
  const visible = useMemo(() => groupedResults.flatMap((group) => group.items), [groupedResults])

  // The flat selection index for each command, so a row can highlight/scroll
  // without an O(n) indexOf scan per render.
  const flatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    visible.forEach((command, index) => map.set(command.id, index))
    return map
  }, [visible])

  // Keep the highlighted row in view as the selection moves by keyboard.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, visible.length - 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(current - 1, 0))
    }
    if (event.key === 'Enter') {
      if (!actionBusy) visible[selected]?.run()
    }
    if (event.key === 'Backspace' && !query) {
      // Backspace at an empty query steps back one state: out of the "which
      // agent" question first, then out of the scope token — the way it pops a
      // chip in a token field, so ⌘⇧F's narrowing and the star's are both
      // reversible from the keyboard without reopening the overlay.
      if (agentChoice) {
        event.preventDefault()
        setAgentChoice(null)
        setActionError(null)
        setSelected(0)
        return
      }
      if (scope !== 'all') {
        event.preventDefault()
        setScope('all')
        setSelected(0)
      }
    }
  }

  const activeOptionId = visible[selected] ? `palette-option-${visible[selected].id}` : undefined

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
            {scope !== 'all' ? (
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
                aria-label={SCOPE_CHIPS[scope].widenLabel}
                className={`flex shrink-0 items-center gap-1 rounded-[var(--radius-xs)] bg-[color:var(--bg-surface-raised)] px-2 py-0.5 text-micro text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
              >
                {SCOPE_CHIPS[scope].label}
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
              placeholder={PALETTE_PLACEHOLDER[scope]}
              aria-label={PALETTE_INPUT_LABEL[scope]}
              role="combobox"
              aria-expanded={visible.length > 0}
              aria-controls="command-palette-results"
              aria-activedescendant={activeOptionId}
              className={`flex-1 bg-transparent text-heading text-[color:var(--text-strong)] placeholder-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
            />
            {/* The parts of the palette that are not instant are the parts that
                say they are working: ripgrep, and an install-and-use round trip. */}
            {(provided.loading || actionBusy) && (
              <span role="status" className="shrink-0 text-micro text-[color:var(--text-disabled)]">
                {actionBusy ? 'Working…' : 'Searching…'}
              </span>
            )}
          </div>

          <div id="command-palette-results" role="listbox" aria-label="Search results" className="max-h-[360px] overflow-y-auto py-1">
            {/* An action that failed says so where the person is looking, and
                the list stays up: a skill whose install was refused must not
                also make the palette vanish. */}
            {actionError && (
              <p role="alert" className="px-4 py-2 text-meta text-[color:var(--tone-danger)]">
                {actionError}
              </p>
            )}
            {visible.length === 0 ? (
              // "No results" is only true once the search that would have
              // produced them has finished, and only meaningful when there was a
              // folder to search in the first place.
              <p className="px-4 py-3 text-meta text-[color:var(--text-muted)]">
                {provided.error
                  ? provided.error
                  : provided.loading
                    ? 'Searching…'
                    : query.trim() && !activeFolderPath
                      ? 'Open a folder to search files, their contents, and the skills a source holds.'
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
                        className={`flex cursor-pointer items-center gap-2.5 px-4 py-2 transition-colors ${
                          isSelected
                            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                        }`}
                      >
                        {/* The plugin's own mark, where it has one — the same
                            ladder the Extensions door draws (glyph → logo →
                            the publishing account's avatar → monogram), so a
                            row reads the same in both places. */}
                        {command.icon ? (
                          <ExtensionIcon
                            name={command.label}
                            size={PALETTE_ROW_ICON_SIZE}
                            {...command.icon}
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            {/* A content hit's label is a line of source, not a
                                title: it reads in mono at body size, with the
                                file:line beneath it as the locator. */}
                            <TruncatedText
                              as="div"
                              text={command.label}
                              className={`min-w-0 ${command.group === 'content' ? 'font-mono text-meta' : 'text-heading'}`}
                            />
                            {/* Where it came from, or that you already have it —
                                the one fact a cross-source list cannot leave
                                out, because the same skill name appears in
                                several marketplaces. */}
                            {command.badge ? (
                              <span className="shrink-0 rounded-[var(--radius-xs)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-micro text-[color:var(--text-subtle)]">
                                {command.badge}
                              </span>
                            ) : null}
                          </div>
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
