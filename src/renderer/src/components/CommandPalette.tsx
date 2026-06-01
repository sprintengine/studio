import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { SPECIALIST_ACTIONS } from '../specialists/specialistActions'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { SpecialistActionId, Workspace, WorkspaceId, WorkspaceWindowId } from '../types/workspace'
import { focusOrAddComponentTab, focusOrAddFileTab, revealNavRailComponent } from '../utils/modelRegistry'
import {
  buildSprintEngineAgentRosterForState,
  computeSprintEngineFocusAgentAvailability,
} from '../utils/sprintengine'

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
  onSpawnSpecialist: (specialistId: SpecialistActionId) => void
  workspaceWindowId: WorkspaceWindowId
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
}

export default function CommandPalette({
  onClose,
  onNewWorkspace,
  onSpawnSpecialist,
  workspaceWindowId,
  workspaces,
  activeWorkspaceId,
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { setActiveWorkspaceForWindow, addWorkspace, setActiveFile } = useWorkspaceStore()
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
    const workspaceMode = activeWorkspace?.mode
    // Tool-conditional command groups. Only commands that have a mounted panel
    // handler are registered — palette selections must produce a real product
    // action (state change, dialog open, IPC). Chord display strings are
    // limited to the one global keybinding actually wired in each panel
    // (Cmd/Ctrl+, where the panel's Settings popover exists); multi-key chords
    // remain reachable via the palette's fuzzy search but are not advertised
    // as direct keybindings because no chord-key dispatcher is shipped yet.
    const switchboardCommands: Command[] = workspaceMode === 'switchboard'
      ? [
          { id: 'switchboard.refresh.board', label: 'Switchboard: Refresh board', run: runPanel('switchboard.refresh.board') },
          { id: 'switchboard.open.runner', label: 'Switchboard: Open runner', run: runPanel('switchboard.open.runner') },
        ]
      : []
    const watchtowerCommands: Command[] = [
      { id: 'watchtower.run.review', label: 'Watchtower: Run review', run: runPanel('watchtower.run.review') },
      { id: 'watchtower.triage.inbox', label: 'Watchtower: Triage inbox', run: runPanel('watchtower.triage.inbox') },
      { id: 'watchtower.open.active-review', label: 'Watchtower: Active review', run: runPanel('watchtower.open.active-review') },
      { id: 'watchtower.import.github', label: 'Watchtower: Import from GitHub', run: runPanel('watchtower.import.github') },
      { id: 'watchtower.import.jira', label: 'Watchtower: Import from Jira', run: runPanel('watchtower.import.jira') },
      { id: 'watchtower.refresh.board', label: 'Watchtower: Refresh', run: runPanel('watchtower.refresh.board') },
    ]
    // Preconditioned Sprint Engine commands. verify-progress requires an
    // architect agent on the roster; focus-agent uses the same effective
    // predicate the panel applies (roster-derived runtime, localExited
    // override, role-task-launch supersession). Commands whose precondition is
    // not met are omitted from the palette so a selection cannot silently
    // no-op and the palette agrees with the panel overflow.
    const sprintEngineState = activeWorkspace?.sprintEngineState ?? null
    const sprintEngineRoster = buildSprintEngineAgentRosterForState(sprintEngineState)
    const sprintEngineHasArchitect = sprintEngineRoster.some((agent) => agent.role === 'architect')
    const focusAgentAvailability = computeSprintEngineFocusAgentAvailability(
      sprintEngineState,
      activeWorkspace?.agents ?? {},
    )
    const sprintEngineFocusAgentVisible = focusAgentAvailability.showFocusAgentAction
    const sprintEngineCommands: Command[] = workspaceMode === 'sprintengine'
      ? [
          { id: 'sprintengine.open.automation-settings', label: 'Sprint Engine: Automation settings', run: runPanel('sprintengine.open.automation-settings') },
          ...(sprintEngineHasArchitect
            ? [{ id: 'sprintengine.verify.progress', label: 'Sprint Engine: Verify progress', run: runPanel('sprintengine.verify.progress') }]
            : []),
          { id: 'sprintengine.add.role', label: 'Sprint Engine: More roles', run: runPanel('sprintengine.add.role') },
          { id: 'sprintengine.request.plan-reviews', label: 'Sprint Engine: Request plan reviews', run: runPanel('sprintengine.request.plan-reviews') },
          { id: 'sprintengine.address.feedback', label: 'Sprint Engine: Address feedback', run: runPanel('sprintengine.address.feedback') },
          { id: 'sprintengine.read.plan', label: 'Sprint Engine: Read plan', run: runPanel('sprintengine.read.plan') },
          ...(sprintEngineFocusAgentVisible
            ? [{ id: 'sprintengine.focus.agent', label: 'Sprint Engine: Focus active agent', run: runPanel('sprintengine.focus.agent') }]
            : []),
          { id: 'sprintengine.refresh.board', label: 'Sprint Engine: Refresh board', run: runPanel('sprintengine.refresh.board') },
          { id: 'sprintengine.goto.inbox', label: 'Sprint Engine: Inbox', run: runPanel('sprintengine.goto.inbox') },
          { id: 'sprintengine.goto.roster', label: 'Sprint Engine: Roster', run: runPanel('sprintengine.goto.roster') },
          { id: 'sprintengine.goto.tasks', label: 'Sprint Engine: Tasks', run: runPanel('sprintengine.goto.tasks') },
          { id: 'sprintengine.goto.activity', label: 'Sprint Engine: Activity', run: runPanel('sprintengine.goto.activity') },
          { id: 'sprintengine.goto.graph', label: 'Sprint Engine: Tasks → Graph layout', run: runPanel('sprintengine.goto.graph') },
          { id: 'sprintengine.goto.kanban', label: 'Sprint Engine: Tasks → Kanban layout', run: runPanel('sprintengine.goto.kanban') },
          { id: 'sprintengine.open.settings', label: 'Sprint Engine: Settings', shortcut: '⌘ ,', run: runPanel('sprintengine.open.settings') },
        ]
      : []
    // Multiloop open-coordinator requires a loaded Multiloop state.
    const multiloopState = activeWorkspace?.multiloopState ?? null
    const multiloopCommands: Command[] = workspaceMode === 'multiloop'
      ? [
          { id: 'multiloop.toggle.auto-run', label: 'Multiloop: Toggle auto-run', run: runPanel('multiloop.toggle.auto-run') },
          ...(multiloopState
            ? [{ id: 'multiloop.open.coordinator', label: 'Multiloop: Open coordinator', run: runPanel('multiloop.open.coordinator') }]
            : []),
          { id: 'multiloop.open.settings', label: 'Multiloop: Settings', shortcut: '⌘ ,', run: runPanel('multiloop.open.settings') },
        ]
      : []
    const navigationCommands: Command[] = []
    return [
      ...LAYOUT_TEMPLATES.map((template) => ({
        id: `new-${template.id}`,
        label: `New Workspace: ${template.name}`,
        description: template.description,
        run: () => {
          addWorkspace(template, { windowId: workspaceWindowId })
          onClose()
        },
      })),
      ...workspaces.map((workspace) => ({
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
              focusOrAddFileTab(activeWorkspaceId, file.path, file.name)
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
              shortcut: action.shortcut,
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
              id: 'git-worktrees',
              label: 'Git: Manage Worktrees',
              description: activeWorkspace.folderPath ?? 'Open the Git panel',
              run: () => {
                revealNavRailComponent(activeWorkspace.id, 'git', 'Git')
                onClose()
              },
            },
          ]
        : []),
      ...navigationCommands,
      ...switchboardCommands,
      ...watchtowerCommands,
      ...sprintEngineCommands,
      ...multiloopCommands,
      {
        id: 'new-workspace',
        label: 'New Workspace...',
        shortcut: 'Ctrl+T',
        run: () => {
          onNewWorkspace()
          onClose()
        },
      },
    ]
  }, [workspaces, activeWorkspace, activeWorkspaceId, openFiles, addWorkspace, setActiveWorkspaceForWindow, setActiveFile, onClose, onNewWorkspace, onSpawnSpecialist, workspaceWindowId])

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
          <kbd className="rounded bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-disabled)]">Esc</kbd>
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
                  <div className="truncate text-sm">{command.label}</div>
                  {command.description && (
                    <div className="mt-0.5 truncate text-[10px] text-[color:var(--text-disabled)]">{command.description}</div>
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
