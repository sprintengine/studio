import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { SPECIALIST_ACTIONS } from '../specialists/specialistActions'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { SpecialistActionId, Workspace, WorkspaceId, WorkspaceWindowId } from '../types/workspace'
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
import { TruncatedText } from './ui'

interface Command {
  id: string
  label: string
  description?: string
  shortcut?: string
  run: () => void
}

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
  const { setActiveWorkspaceForWindow, addWorkspace, setActiveFile } = useWorkspaceStore()
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const moduleEnablement = useWorkspaceStore((state) => state.appSettings.modules)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = (commandId: string): string | undefined =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const openFiles = activeWorkspace?.editorState?.openFiles ?? []

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
    const switchboardCommands: Command[] = [
      { id: 'switchboard.refresh.board', label: 'Switchboard: Refresh board', run: runPanel('switchboard.refresh.board') },
      { id: 'switchboard.open.runner', label: 'Switchboard: Open runner', run: runPanel('switchboard.open.runner') },
    ].filter((command) => panelCommandEnabled(command.id))
    const watchtowerCommands: Command[] = [
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
    const sprintEngineCommands: Command[] = [
      { id: 'sprintengine.verify.progress', label: 'Sprint: Verify progress', run: runPanel('sprintengine.verify.progress') },
      { id: 'sprintengine.add.role', label: 'Sprint: More roles', run: runPanel('sprintengine.add.role') },
      { id: 'sprintengine.request.plan-reviews', label: 'Sprint: Request plan reviews', run: runPanel('sprintengine.request.plan-reviews') },
      { id: 'sprintengine.address.feedback', label: 'Sprint: Address feedback', run: runPanel('sprintengine.address.feedback') },
      { id: 'sprintengine.read.plan', label: 'Sprint: Read plan', run: runPanel('sprintengine.read.plan') },
      { id: 'sprintengine.focus.agent', label: 'Sprint: Focus active agent', run: runPanel('sprintengine.focus.agent') },
      { id: 'sprintengine.refresh.board', label: 'Sprint: Refresh board', run: runPanel('sprintengine.refresh.board') },
      { id: 'sprintengine.goto.inbox', label: 'Sprint: Inbox', shortcut: shortcutFor('sprintengine.goto.inbox'), run: runPanel('sprintengine.goto.inbox') },
      { id: 'sprintengine.goto.roster', label: 'Sprint: Roster', shortcut: shortcutFor('sprintengine.goto.roster'), run: runPanel('sprintengine.goto.roster') },
      { id: 'sprintengine.goto.tasks', label: 'Sprint: Tasks', shortcut: shortcutFor('sprintengine.goto.tasks'), run: runPanel('sprintengine.goto.tasks') },
      { id: 'sprintengine.goto.graph', label: 'Sprint: Tasks → Graph layout', shortcut: shortcutFor('sprintengine.goto.graph'), run: runPanel('sprintengine.goto.graph') },
      { id: 'sprintengine.goto.kanban', label: 'Sprint: Tasks → Kanban layout', shortcut: shortcutFor('sprintengine.goto.kanban'), run: runPanel('sprintengine.goto.kanban') },
      { id: 'sprintengine.open.settings', label: 'Sprint: Run configuration', shortcut: shortcutFor('sprintengine.open.settings'), run: runPanel('sprintengine.open.settings') },
    ].filter((command) => panelCommandEnabled(command.id))
    // open-coordinator requires a loaded Multiloop state, carried by the shared
    // availability context.
    const multiloopCommands: Command[] = [
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
    const gitCommands: Command[] = [
      { id: 'git.refresh', label: 'Git: Refresh status', shortcut: shortcutFor('git.refresh'), run: runGitPanel('git.refresh') },
      { id: 'git.fetch', label: 'Git: Fetch remotes', shortcut: shortcutFor('git.fetch'), run: runGitPanel('git.fetch') },
      { id: 'git.commit', label: 'Git: Commit staged changes', shortcut: shortcutFor('git.commit'), run: runGitPanel('git.commit') },
    ].filter((command) => panelCommandEnabled(command.id))
    const panelToggleCommands: Command[] = activeWorkspace
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
    const navigationCommands: Command[] = []
    // Commands contributed by enabled capability modules, gated by the same
    // scope + availability predicate as built-in panel commands. Rows label as
    // "<category>: <title>" so a module's commands read like the built-in
    // groups; the handler is the module's own callback.
    const moduleCommands: Command[] = getRendererHost()
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
    return [
      {
        id: 'new-chat',
        label: 'New Chat',
        description: activeWorkspace?.folderPath ? 'Create a one-agent chat in the current project' : 'Create a one-agent chat',
        run: () => {
          onNewChat()
          onClose()
        },
      },
      ...LAYOUT_TEMPLATES.map((template) => ({
        id: `new-${template.id}`,
        label: `New Workspace: ${template.name}`,
        description: template.description,
        run: () => {
          addWorkspace(template, { windowId: workspaceWindowId })
          onClose()
        },
      })),
      // Rail-hidden workspaces (the background Automations host) are never a
      // switch target — the palette mirrors the rail/hotkey navigation surfaces.
      ...workspaces
        .filter((workspace) => !isHiddenFromRail(workspace))
        .map((workspace) => ({
          id: `switch-${workspace.id}`,
          label: `Switch to: ${workspace.name}`,
          description: workspace.id === activeWorkspaceId ? 'active' : '',
          run: () => {
            setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
            onClose()
          },
        })),
      ...(activeWorkspaceId
        ? openFiles.map((file) => ({
            id: `file-${file.path}`,
            label: file.name,
            description: file.path,
            run: () => {
              setActiveFile(activeWorkspaceId, file.path)
              openFileSurface({ workspaceId: activeWorkspaceId, path: file.path, name: file.name })
              onClose()
            },
          }))
        : []),
      ...(activeWorkspace
        ? [
            ...SPECIALIST_ACTIONS.map((action) => ({
              id: `spawn-specialist-${action.id}`,
              label: `Spawn: ${action.label}`,
              description: `${action.shortLabel} specialist with the selected CLI`,
              shortcut: getSpecialistCommandId(action.id) ? shortcutFor(getSpecialistCommandId(action.id)!) : undefined,
              run: () => {
                onSpawnSpecialist(action.id)
                onClose()
              },
            })),
            {
              id: 'content-search',
              label: 'Search: File Contents',
              description: activeWorkspace.folderPath ?? 'Open content search',
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
              run: () => {
                revealNavRailComponent(activeWorkspace.id, 'git', 'Git')
                onClose()
              },
            },
            {
              id: 'connector.railway.connect',
              label: 'Connect: Railway',
              description: 'Open an isolated Railway connector chat in a new worktree',
              run: () => {
                onConnectRailway()
                onClose()
              },
            },
          ]
        : []),
      ...navigationCommands,
      ...panelToggleCommands,
      ...gitCommands,
      ...switchboardCommands,
      ...watchtowerCommands,
      ...sprintEngineCommands,
      ...multiloopCommands,
      ...moduleCommands,
      {
        id: 'workspace.new',
        label: 'New Workspace...',
        shortcut: shortcutFor('workspace.new'),
        run: () => {
          onNewWorkspace()
          onClose()
        },
      },
    ]
  }, [workspaces, activeWorkspace, activeWorkspaceId, openFiles, addWorkspace, setActiveWorkspaceForWindow, setActiveFile, onClose, onNewChat, onNewWorkspace, onConnectRailway, onSpawnSpecialist, workspaceWindowId, keybindingPlatform, keybindingSettings, activeScopes, commandAvailability, moduleEnablement])

  const filtered = query.trim()
    ? commands.filter((command) => {
        const q = query.toLowerCase()
        return command.label.toLowerCase().includes(q) || command.description?.toLowerCase().includes(q)
      })
    : commands.slice(0, 12)

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[color:var(--surface-overlay-backdrop)] pt-[15vh] backdrop-blur-sm"
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
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-[color:var(--text-strong)] placeholder-[color:var(--text-disabled)] focus:outline-none"
          />
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[color:var(--text-disabled)]">No results</p>
          ) : (
            filtered.map((command, index) => (
              <div
                key={command.id}
                onClick={command.run}
                onMouseEnter={() => setSelected(index)}
                className={`flex cursor-pointer items-center justify-between px-4 py-2 transition-colors ${
                  index === selected
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
            ))
          )}
        </div>
      </div>
    </div>
  )
}
