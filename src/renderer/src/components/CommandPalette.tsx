import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { SPECIALIST_ACTIONS } from '../specialists/specialistActions'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { SpecialistActionId, Workspace, WorkspaceId, WorkspaceWindowId } from '../types/workspace'
import type { BuiltinSkill, SkillPackEntry } from '../../../shared/electron-api'
import { focusOrAddComponentTab, revealNavRailComponent, togglePanelRailComponent } from '../utils/modelRegistry'
import { openFileSurface } from '../utils/openFileSurface'
import { isHiddenFromRail } from '../utils/workspaceVisibility'
import {
  getEffectiveKeybindingLabel,
  getSpecialistCommandId,
  platformKeybindingsFromApiPlatform,
} from '../commands/effectiveKeybindings'
import { isCommandEnabled, isCommandIdEnabled, type CommandAvailabilityContext } from '../commands/availability'
import type { CommandScope } from '../commands/types'
import { getRendererHost, selectModuleEnabled } from '../modules'
import { commandMatchesQuery, workspaceSearchKeywords } from './commandPaletteSearch'
import { TruncatedText } from './ui'

// The four canonical source groups the global-search palette organizes results
// into (T6), plus a Files group for the active workspace's open editors. The
// order here is the vertical order in the list and therefore the order the
// arrow keys traverse. "Agents & workspaces" folds in the workspace-filtering
// the sidebar "Search workspaces" box used to own.
type CommandGroup = 'agents' | 'skills' | 'commands' | 'actions' | 'files'

const PALETTE_GROUPS: readonly { key: CommandGroup; label: string }[] = [
  { key: 'agents', label: 'Agents & workspaces' },
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'actions', label: 'Actions' },
  { key: 'files', label: 'Files' },
]

const groupRank = (group: CommandGroup): number => PALETTE_GROUPS.findIndex((entry) => entry.key === group)

// With no query, each group shows a short preview rather than its full contents,
// so the first frame stays calm and scannable instead of dumping every command.
const PREVIEW_PER_GROUP = 6

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
  window.dispatchEvent(new CustomEvent('multicode:panel-command', { detail: { id } }))
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
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRowRef = useRef<HTMLDivElement>(null)
  const { setActiveWorkspaceForWindow, addWorkspace, setActiveFile, openConnectorsSurface } = useWorkspaceStore()
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const moduleEnablement = useWorkspaceStore((state) => state.appSettings.modules)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = (commandId: string): string | undefined =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const openFiles = activeWorkspace?.editorState?.openFiles ?? []
  const activeFolderPath = activeWorkspace?.folderPath ?? null

  // Skills source (T6). Built-in skills are global and always listed; installed
  // skill packs are workspace-scoped, so they load only when a workspace is
  // open. Loading is best-effort: these are an auxiliary group, so a failed
  // list leaves the Skills group empty rather than breaking the palette — the
  // command/action/agent groups do not depend on it. Selecting a skill opens the
  // Connectors surface, which is where skills are browsed, installed, and
  // managed; per-skill deep-linking is deferred with the rest of global content
  // navigation (DEF-4).
  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([])
  const [installedSkillPacks, setInstalledSkillPacks] = useState<SkillPackEntry[]>([])

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
      setInstalledSkillPacks([])
      return
    }
    let cancelled = false
    void window.api
      .skillPackListInstalled({ workspaceRoot: activeFolderPath })
      .then((result) => {
        if (!cancelled) setInstalledSkillPacks(result.ok ? result.installed : [])
      })
      .catch(() => {
        if (!cancelled) setInstalledSkillPacks([])
      })
    return () => {
      cancelled = true
    }
  }, [activeFolderPath])

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
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
    const switchboardCommands: UngroupedCommand[] = [
      { id: 'switchboard.refresh.board', label: 'Switchboard: Refresh board', run: runPanel('switchboard.refresh.board') },
      { id: 'switchboard.open.runner', label: 'Switchboard: Open runner', run: runPanel('switchboard.open.runner') },
    ].filter((command) => panelCommandEnabled(command.id))
    const watchtowerCommands: UngroupedCommand[] = [
      { id: 'watchtower.run.review', label: 'Watchtower: Run review', run: runPanel('watchtower.run.review') },
      { id: 'watchtower.triage.inbox', label: 'Watchtower: Triage inbox', run: runPanel('watchtower.triage.inbox') },
      { id: 'watchtower.open.active-review', label: 'Watchtower: Active review', run: runPanel('watchtower.open.active-review') },
      { id: 'watchtower.import.github', label: 'Watchtower: Import from GitHub', run: runPanel('watchtower.import.github') },
      { id: 'watchtower.import.jira', label: 'Watchtower: Import from Jira', run: runPanel('watchtower.import.jira') },
      { id: 'watchtower.refresh.board', label: 'Watchtower: Refresh', run: runPanel('watchtower.refresh.board') },
    ].filter((command) => panelCommandEnabled(command.id))
    // verify-progress requires an architect on the roster and focus-agent
    // requires a focusable running/waiting agent; both come through the shared
    // availability context, so a row only appears when the shortcut would run.
    const sprintEngineCommands: UngroupedCommand[] = [
      { id: 'sprintengine.verify.progress', label: 'Sprint: Verify progress', run: runPanel('sprintengine.verify.progress') },
      { id: 'sprintengine.add.role', label: 'Sprint: More roles', run: runPanel('sprintengine.add.role') },
      { id: 'sprintengine.request.plan-reviews', label: 'Sprint: Request plan reviews', run: runPanel('sprintengine.request.plan-reviews') },
      { id: 'sprintengine.address.feedback', label: 'Sprint: Address feedback', run: runPanel('sprintengine.address.feedback') },
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
    // open-coordinator requires a loaded Multiloop state, carried by the shared
    // availability context.
    const multiloopCommands: UngroupedCommand[] = [
      { id: 'multiloop.toggle.auto-run', label: 'Multiloop: Toggle auto-run', run: runPanel('multiloop.toggle.auto-run') },
      { id: 'multiloop.open.coordinator', label: 'Multiloop: Open coordinator', run: runPanel('multiloop.open.coordinator') },
      { id: 'multiloop.open.settings', label: 'Multiloop: Settings', shortcut: shortcutFor('multiloop.open.settings'), run: runPanel('multiloop.open.settings') },
    ].filter((command) => panelCommandEnabled(command.id))
    // Git refresh/fetch/commit run the Git panel's real handlers; the shared
    // availability context (gitPanelActive) keeps them listed only while the Git
    // panel is open, so a selection cannot land on an unmounted handler. They are
    // targeted at the active workspace so commit never fires in a background repo.
    const runGitPanel = (id: string) => () => {
      window.dispatchEvent(new CustomEvent('multicode:panel-command', { detail: { id, workspaceId: activeWorkspaceId } }))
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
      .filter((moduleCommand) => isCommandEnabled(moduleCommand, activeScopes, commandAvailability))
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
      ...switchboardCommands,
      ...watchtowerCommands,
      ...sprintEngineCommands,
      ...multiloopCommands,
      ...moduleCommands,
    ].map((command) => ({ ...command, group: 'commands' as const }))

    // Skills: built-in skills first, then installed skill packs. Both route to
    // the Connectors surface (their management home) on select.
    const skillCommands: Command[] = [
      ...builtinSkills.map((skill) => ({
        id: `skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills' as const,
        run: () => {
          openConnectorsSurface()
          onClose()
        },
      })),
      ...installedSkillPacks.map((pack) => ({
        id: `skill-pack-${pack.id}`,
        label: pack.name,
        description: pack.description ?? pack.category,
        group: 'skills' as const,
        run: () => {
          openConnectorsSurface()
          onClose()
        },
      })),
    ]

    return [
      // Agents & workspaces — the switch targets that absorb the sidebar's
      // former "Search workspaces" box. Rail-hidden workspaces (the background
      // Automations host) are never a switch target — the palette mirrors the
      // rail/hotkey navigation surfaces. The folder path rides `description` so
      // typing a path filters here too, preserving the sidebar's path matching.
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
            ...SPECIALIST_ACTIONS.map((action): Command => ({
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
              description: 'Open an isolated Railway connector chat in a new worktree',
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
  }, [workspaces, activeWorkspace, activeWorkspaceId, openFiles, addWorkspace, setActiveWorkspaceForWindow, setActiveFile, openConnectorsSurface, onClose, onNewChat, onNewWorkspace, onConnectRailway, onSpawnSpecialist, workspaceWindowId, keybindingPlatform, keybindingSettings, activeScopes, commandAvailability, moduleEnablement, builtinSkills, installedSkillPacks])

  // Matches are ordered by group so the arrow keys traverse the same top-to-
  // bottom order the grouped list renders in. With no query each group shows a
  // capped preview; a query searches every group at once.
  const filtered = useMemo((): Command[] => {
    const q = query.trim().toLowerCase()
    const matched = q ? commands.filter((command) => commandMatchesQuery(command, q)) : commands
    const ordered = [...matched].sort((a, b) => groupRank(a.group) - groupRank(b.group))
    if (q) return ordered
    const perGroup = new Map<CommandGroup, number>()
    return ordered.filter((command) => {
      const count = (perGroup.get(command.group) ?? 0) + 1
      perGroup.set(command.group, count)
      return count <= PREVIEW_PER_GROUP
    })
  }, [commands, query])

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
  }

  const activeOptionId = filtered[selected] ? `palette-option-${filtered[selected].id}` : undefined

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="w-[600px] max-w-[95vw] overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[color:var(--border-default)] px-4 py-3">
          <span className="text-sm text-[color:var(--text-disabled)]">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={handleKey}
            placeholder="Search agents, skills, commands, actions..."
            aria-label="Search agents, skills, commands, and actions"
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-controls="command-palette-results"
            aria-activedescendant={activeOptionId}
            className="flex-1 bg-transparent text-sm text-[color:var(--text-strong)] placeholder-[color:var(--text-disabled)] focus:outline-none"
          />
        </div>

        <div id="command-palette-results" role="listbox" aria-label="Search results" className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[color:var(--text-disabled)]">No results</p>
          ) : (
            groupedResults.map((group) => (
              <div key={group.key} role="group" aria-label={group.label}>
                <div
                  aria-hidden="true"
                  className="flex items-center gap-3 px-4 pb-1 pt-2 text-[10px] font-medium text-[color:var(--text-disabled)]"
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
                          ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      <div className="min-w-0">
                        <TruncatedText as="div" text={command.label} className="text-sm" />
                        {command.description && (
                          <TruncatedText as="div" text={command.description} className="mt-0.5 text-[10px] text-[color:var(--text-disabled)]" />
                        )}
                      </div>
                      {command.shortcut && (
                        <kbd className="ml-3 shrink-0 rounded bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-disabled)]">
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
    </div>
  )
}
