import React, { useEffect, useRef, useState } from 'react'
import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import CliIcon from '../CliIcon'
import CommandPalette from '../CommandPalette'
import SettingsModal from '../settings/SettingsModal'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  SPECIALIST_ACTIONS,
  getSpecialistAction,
  loadSpecialistPrompt,
  type SpecialistIcon,
} from '../../specialists/specialistActions'
import type { AgentCli, LayoutTemplate, SpecialistActionId, Workspace } from '../../types/workspace'
import { getModel } from '../../utils/modelRegistry'
import TemplateSelector from './TemplateSelector'
import WorkspaceLayout from './WorkspaceLayout'

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const CLI_OPTIONS: Array<{ value: AgentCli; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
]
type WorkspacePanelComponent = 'explorer' | 'editor' | 'git'
type WorkspaceActivity = 'needs-input' | 'running' | 'idle'
type ActivityLayoutNode = {
  component?: string
  config?: {
    agentId?: string
  }
  children?: ActivityLayoutNode[]
}

function workspaceNeedsInput(workspace: Workspace): boolean {
  return Object.values(workspace.swarmState?.swarmAgents ?? {}).some(
    (agent) => agent.status === 'needs_input'
  )
}

function workspaceHasRunningAgent(workspace: Workspace): boolean {
  const openAgentIds = new Set<string>()

  const collectOpenAgentIds = (node: ActivityLayoutNode | undefined) => {
    if (!node) return

    if (node.component === 'agent') {
      const agentId = node.config?.agentId
      if (agentId) openAgentIds.add(agentId)
    }

    node.children?.forEach(collectOpenAgentIds)
  }

  collectOpenAgentIds(workspace.layoutModel.layout as ActivityLayoutNode)
  workspace.layoutModel.borders?.forEach((border) => collectOpenAgentIds(border as ActivityLayoutNode))

  return [...openAgentIds].some((agentId) => {
    const agent = workspace.agents[agentId]
    return Boolean(agent?.cliStartRequested || agent?.cliHasLaunched || agent?.cliTerminalId)
  })
}

function getWorkspaceActivity(workspace: Workspace): WorkspaceActivity {
  if (workspaceNeedsInput(workspace)) return 'needs-input'
  if (workspaceHasRunningAgent(workspace)) return 'running'
  return 'idle'
}

function workspaceActivityDotClass(activity: WorkspaceActivity): string {
  switch (activity) {
    case 'needs-input':
      return 'animate-pulse bg-[#ffbf2f] shadow-[0_0_10px_rgba(255,191,47,0.9)]'
    case 'running':
      return 'bg-[#30d158] shadow-[0_0_8px_rgba(48,209,88,0.45)]'
    default:
      return 'bg-[#5a5a63]'
  }
}

function workspaceActivityLabel(activity: WorkspaceActivity): string {
  switch (activity) {
    case 'needs-input':
      return 'Workspace needs input'
    case 'running':
      return 'Workspace has running agents'
    default:
      return 'Workspace idle'
  }
}

export default function WorkspaceManager() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli ?? 'claude')
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const lastSelectedSpecialist = useWorkspaceStore(
    (s) => s.appSettings.lastSelectedSpecialist ?? SPECIALIST_ACTIONS[0].id
  )
  const setLastSelectedSpecialist = useWorkspaceStore((s) => s.setLastSelectedSpecialist)

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
  const selectedCliOption = CLI_OPTIONS.find((option) => option.value === lastSelectedCli) ?? CLI_OPTIONS[0]
  const selectedSpecialistAction = getSpecialistAction(lastSelectedSpecialist)

  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [cliMenuOpen, setCliMenuOpen] = useState(false)
  const [specialistMenuOpen, setSpecialistMenuOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [windowState, setWindowState] = useState<WindowState>({
    isMaximized: false,
    isFullScreen: false,
  })
  const renameInputRef = useRef<HTMLInputElement>(null)
  const cliMenuRef = useRef<HTMLDivElement>(null)
  const specialistMenuRef = useRef<HTMLDivElement>(null)
  const workspaceActionsEnabled = activeWorkspace && !showTemplateSelector

  const openTemplateSelector = () => {
    setShowTemplateSelector(true)
    setCliMenuOpen(false)
    setSpecialistMenuOpen(false)
  }

  useEffect(() => {
    if (workspaces.length === 0) setShowTemplateSelector(true)
  }, [workspaces.length])

  useEffect(() => {
    if (window.api.platform === 'darwin') return

    let mounted = true
    void window.api.getWindowState().then((state) => {
      if (mounted && state) setWindowState(state)
    })

    const unsubscribe = window.api.onWindowStateChanged(setWindowState)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select()
  }, [renamingId])

  useEffect(() => {
    if (!cliMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!cliMenuRef.current?.contains(event.target as Node)) {
        setCliMenuOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCliMenuOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [cliMenuOpen])

  useEffect(() => {
    if (!specialistMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!specialistMenuRef.current?.contains(event.target as Node)) {
        setSpecialistMenuOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSpecialistMenuOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [specialistMenuOpen])

  useEffect(() => {
    setCliMenuOpen(false)
    setSpecialistMenuOpen(false)
  }, [activeWorkspaceId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || renamingId) return

      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl) return

      if (event.key === 'Tab') {
        event.preventDefault()
        const nextWorkspaceId = getNextWorkspaceId(
          workspaces,
          activeWorkspaceId,
          event.shiftKey ? -1 : 1
        )
        if (nextWorkspaceId) {
          setShowTemplateSelector(false)
          setActiveWorkspace(nextWorkspaceId)
        }
        return
      }

      if (event.key === 'p') {
        event.preventDefault()
        setShowPalette(true)
      }
      if (event.key === 't') {
        event.preventDefault()
        openTemplateSelector()
      }
      if (event.key === 'w' && showTemplateSelector) {
        event.preventDefault()
        if (workspaces.length > 0) setShowTemplateSelector(false)
      } else if (event.key === 'w' && activeWorkspaceId) {
        event.preventDefault()
        closeActiveLayoutTab(activeWorkspaceId)
      }

      const n = parseInt(event.key)
      if (n >= 1 && n <= 9 && workspaces[n - 1]) {
        event.preventDefault()
        setShowTemplateSelector(false)
        setActiveWorkspace(workspaces[n - 1].id)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    workspaces,
    activeWorkspaceId,
    showTemplateSelector,
    renamingId,
    removeWorkspace,
    setActiveWorkspace,
  ])

  useEffect(() => {
    return window.api.onAppMenuCommand((command) => {
      if (command === 'show-settings') {
        setShowSettings(true)
        return
      }
      if (command === 'show-about') {
        setShowSettings(true)
        return
      }
      if (!activeWorkspaceId) return
      if (command === 'toggle-explorer') {
        toggleWorkspacePanel(activeWorkspaceId, 'explorer')
      } else if (command === 'toggle-editor') {
        toggleWorkspacePanel(activeWorkspaceId, 'editor')
      }
    })
  }, [activeWorkspaceId])

  const handleCreate = ({
    template,
    name,
    folderPath,
    swarmState,
  }: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    swarmState?: Workspace['swarmState']
  }) => {
    addWorkspace(template, { name, folderPath, swarmState })
    setShowTemplateSelector(false)
  }

  const handleCloseTab = (event: React.MouseEvent, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    const workspace = workspaces.find((candidate) => candidate.id === id)
    if (workspace) terminateWorkspaceTerminals(workspace)
    removeWorkspace(id)
  }

  const startRename = (event: React.MouseEvent, workspace: Workspace) => {
    event.stopPropagation()
    setRenamingId(workspace.id)
    setRenameValue(workspace.name)
  }

  const commitRename = () => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const addNewSpecialist = async (specialistId: SpecialistActionId = lastSelectedSpecialist) => {
    if (showTemplateSelector || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const specialist = getSpecialistAction(specialistId)
    const newId = `specialist-${specialist.id}-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    updateAgent(activeWorkspaceId, newId, {
      name: specialist.shortLabel,
      cli: lastSelectedCli,
      kind: 'specialist',
      specialistId: specialist.id,
      cliStartupPrompt: await loadSpecialistPrompt(specialist.id),
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
    })
    model.doAction(
      Actions.addNode(
        {
          type: 'tab',
          name: specialist.shortLabel,
          component: 'agent',
          config: { agentId: newId },
        },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
  }

  const addNewTerminal = () => {
    if (showTemplateSelector || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const newId = `terminal-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    model.doAction(
      Actions.addNode(
        { type: 'tab', name: 'Terminal', component: 'terminal', config: { terminalId: newId } },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
  }

  const addGitPanel = () => {
    if (showTemplateSelector || !activeWorkspaceId) return
    setCliMenuOpen(false)
    setSpecialistMenuOpen(false)
    toggleWorkspacePanel(activeWorkspaceId, 'git')
  }

  const handleSelectCli = (cli: AgentCli) => {
    setLastSelectedCli(cli)
    setCliMenuOpen(false)
  }

  const handleSelectSpecialist = (specialistId: SpecialistActionId) => {
    setLastSelectedSpecialist(specialistId)
    setSpecialistMenuOpen(false)
    void addNewSpecialist(specialistId)
  }

  const handleShowMenubarMenu = async (
    event: React.MouseEvent<HTMLButtonElement>,
    label: (typeof MENU_BAR_ITEMS)[number]
  ) => {
    const rect = event.currentTarget.getBoundingClientRect()
    await window.api.showMenubarMenu(label, {
      x: rect.left,
      y: rect.bottom + 4,
    })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#08090b] text-[#ececee]">
      {window.api.platform !== 'darwin' && (
        <div
          className="app-drag flex h-[34px] shrink-0 items-stretch justify-between border-b border-[#1f2025] bg-[#0d0e11]"
        >
          <div className="flex min-w-0 items-center gap-1 px-2">
            {MENU_BAR_ITEMS.map((label) => (
              <button
                key={label}
                onClick={(event) => void handleShowMenubarMenu(event, label)}
                className="app-no-drag inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                {label}
              </button>
            ))}
          </div>

          <WindowControls isMaximized={windowState.isMaximized} />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {workspaces.map((workspace) => {
            const active = !showTemplateSelector && workspace.id === activeWorkspaceId
            const activity = getWorkspaceActivity(workspace)
            const activityLabel = workspaceActivityLabel(activity)
            return (
              <div
                key={workspace.id}
                onMouseDown={(event) => {
                  if (event.button !== 1) return
                  handleCloseTab(event, workspace.id)
                }}
                onClick={() => {
                  if (!renamingId) {
                    setShowTemplateSelector(false)
                    setActiveWorkspace(workspace.id)
                  }
                }}
                className={`group inline-flex h-[30px] cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-[13px] transition-colors ${
                  active
                    ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                    : 'border-transparent text-[#8a8a92] hover:bg-[#15161a] hover:text-[#d7d7dc]'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${workspaceActivityDotClass(activity)}`}
                  title={activityLabel}
                  aria-label={activityLabel}
                />
                {renamingId === workspace.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') setRenamingId(null)
                      event.stopPropagation()
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="w-32 rounded border border-[#303139] bg-[#090a0c] px-1.5 py-0 text-[13px] text-[#ececee] focus:outline-none"
                  />
                ) : (
                  <span onDoubleClick={(event) => startRename(event, workspace)}>{workspace.name}</span>
                )}

                <button
                  onClick={(event) => handleCloseTab(event, workspace.id)}
                  className="text-xs leading-none text-[#5a5a63] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#d7d7dc]"
                  aria-label={`Close ${workspace.name}`}
                >
                  x
                </button>
              </div>
            )
          })}

          <button
            onClick={openTemplateSelector}
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-[#8a8a92] transition-colors hover:bg-[#15161a] hover:text-[#d7d7dc]"
            title="New workspace (Ctrl+T)"
          >
            + New Workspace
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {workspaceActionsEnabled ? (
            <button
              onClick={addGitPanel}
              disabled={!activeWorkspaceId}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:opacity-40 disabled:hover:bg-[#111216]"
              title="Toggle Git panel"
              aria-label="Toggle Git panel"
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M7 5.5A2.5 2.5 0 1 0 7 10.5A2.5 2.5 0 0 0 7 5.5Z" stroke="currentColor" strokeWidth="1.7" />
                <path d="M17 13.5A2.5 2.5 0 1 0 17 18.5A2.5 2.5 0 0 0 17 13.5Z" stroke="currentColor" strokeWidth="1.7" />
                <path d="M7 10.5V12.25C7 14.18 8.57 15.75 10.5 15.75H14.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                <path d="M7 10.5V18.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}

          {workspaceActionsEnabled ? (
            <button
              onClick={addNewTerminal}
              disabled={!activeWorkspaceId}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:opacity-40 disabled:hover:bg-[#111216]"
              title="Open terminal"
              aria-label="Open terminal"
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12.5 15H16.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}

          {workspaceActionsEnabled ? (
            <div ref={specialistMenuRef} className="relative inline-flex">
              <div className="inline-flex overflow-hidden rounded-md border border-[#24252b] bg-[#111216]">
                <button
                  onClick={() => void addNewSpecialist()}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-8 items-center justify-center text-[#6ee7d8] transition-colors hover:bg-[#17181d] disabled:opacity-40 disabled:hover:bg-[#111216]"
                  title={`Spawn ${selectedSpecialistAction.label} specialist with ${selectedCliOption.label}`}
                  aria-label={`Spawn ${selectedSpecialistAction.label} specialist`}
                >
                  <SpecialistActionIcon icon={selectedSpecialistAction.icon} className="h-[18px] w-[18px]" />
                </button>
                <button
                  onClick={() => {
                    setSpecialistMenuOpen((open) => !open)
                    setCliMenuOpen(false)
                  }}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-6 items-center justify-center border-l border-[#24252b] text-[#8a8a92] transition-colors hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:opacity-40 disabled:hover:bg-[#111216]"
                  title="Choose specialist"
                  aria-haspopup="menu"
                  aria-expanded={specialistMenuOpen}
                  aria-label="Choose specialist"
                >
                  <svg className={`h-3.5 w-3.5 transition-transform ${specialistMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              {specialistMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-9 z-40 w-72 overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                >
                  {SPECIALIST_ACTIONS.map((action) => {
                    const selected = action.id === selectedSpecialistAction.id
                    return (
                      <button
                        key={action.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => handleSelectSpecialist(action.id)}
                        className={`flex w-full items-start gap-3 rounded px-2.5 py-2 text-left transition-colors ${
                          selected
                            ? 'bg-[#6ee7d8]/10 text-[#ececee]'
                            : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border ${
                            selected
                              ? 'border-[#6ee7d8]/40 bg-[#6ee7d8]/10 text-[#6ee7d8]'
                              : 'border-[#24252b] bg-[#111216] text-[#5a5a63]'
                          }`}
                        >
                          <SpecialistActionIcon icon={action.icon} className="h-[18px] w-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold">
                            {action.label}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-[#8a8a92]">
                            {action.description}
                          </span>
                        </span>
                        {selected ? (
                          <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-[#6ee7d8]" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {workspaceActionsEnabled && activeWorkspace.mode !== 'swarm' && (
            <div ref={cliMenuRef} className="relative inline-flex">
              <div className="inline-flex overflow-hidden rounded-md border border-[#24252b] bg-[#111216]">
                <button
                  onClick={() => {
                    setCliMenuOpen((open) => !open)
                    setSpecialistMenuOpen(false)
                  }}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-8 items-center justify-center text-[#30d158] transition-colors hover:bg-[#17181d] disabled:opacity-40 disabled:hover:bg-[#111216]"
                  title={`Base CLI: ${selectedCliOption.label}`}
                  aria-haspopup="menu"
                  aria-expanded={cliMenuOpen}
                  aria-label={`Base CLI: ${selectedCliOption.label}`}
                >
                  <CliIcon cli={selectedCliOption.value} className="h-[18px] w-[18px]" />
                </button>
                <button
                  onClick={() => {
                    setCliMenuOpen((open) => !open)
                    setSpecialistMenuOpen(false)
                  }}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-6 items-center justify-center border-l border-[#24252b] text-[#8a8a92] transition-colors hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:opacity-40 disabled:hover:bg-[#111216]"
                  title="Choose CLI"
                  aria-haspopup="menu"
                  aria-expanded={cliMenuOpen}
                  aria-label="Choose CLI"
                >
                  <svg className={`h-3.5 w-3.5 transition-transform ${cliMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              {cliMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-9 z-40 w-44 overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                >
                  {CLI_OPTIONS.map((option) => {
                    const selected = option.value === selectedCliOption.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => handleSelectCli(option.value)}
                        className={`flex w-full items-center gap-3 rounded px-2.5 py-2 text-left transition-colors ${
                          selected
                            ? 'bg-[#30d158]/10 text-[#ececee]'
                            : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
                        }`}
                      >
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border ${
                            selected
                                ? 'border-[#30d158]/35 bg-[#30d158]/10 text-[#30d158]'
                                : 'border-[#24252b] bg-[#111216] text-[#5a5a63]'
                          }`}
                        >
                          <CliIcon cli={option.value} className="h-[18px] w-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                          {option.label}
                        </span>
                        {selected ? (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#30d158]" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {showTemplateSelector ? (
          <TemplateSelector
            onCreate={handleCreate}
            onClose={() => setShowTemplateSelector(false)}
            allowClose={workspaces.length > 0}
          />
        ) : (
          <>
            {workspaces.length === 0 && <EmptyState onNew={openTemplateSelector} />}
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspaceId
              return (
                <div
                  key={workspace.id}
                  className="absolute inset-0"
                  style={{
                    display: active ? 'block' : 'none',
                    pointerEvents: active ? 'auto' : 'none',
                  }}
                  aria-hidden={!active}
                >
                  <WorkspaceLayout workspaceId={workspace.id} />
                </div>
              )
            })}
          </>
        )}
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewWorkspace={openTemplateSelector}
        />
      )}
    </div>
  )
}

function WindowControls({ isMaximized }: { isMaximized: boolean }) {
  const minimizeWindow = () => {
    void window.api.windowMinimize()
  }

  const toggleWindowSize = () => {
    void window.api.windowToggleMaximize()
  }

  const closeWindow = () => {
    void window.api.windowClose()
  }

  return (
    <div className="app-no-drag flex shrink-0 items-stretch" aria-label="Window controls">
      <button
        type="button"
        onClick={minimizeWindow}
        className="inline-flex w-10 items-center justify-center text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:bg-[#17181d] focus:text-[#ececee] focus:outline-none"
        aria-label="Minimize window"
        title="Minimize"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8H12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        onClick={toggleWindowSize}
        className="inline-flex w-10 items-center justify-center text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:bg-[#17181d] focus:text-[#ececee] focus:outline-none"
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.5 6.5H11.5V12.5H5.5V6.5Z" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4.5 9.5H3.5V3.5H9.5V4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4H12V12H4V4Z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={closeWindow}
        className="inline-flex w-10 items-center justify-center text-[#9a9aa2] transition-colors hover:bg-[#c42b1c] hover:text-white focus:bg-[#c42b1c] focus:text-white focus:outline-none"
        aria-label="Close window"
        title="Close"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function getNextWorkspaceId(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  step: 1 | -1
): string | null {
  if (workspaces.length < 2) return null

  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId)
  if (activeIndex === -1) return workspaces[0].id

  const nextIndex = (activeIndex + step + workspaces.length) % workspaces.length
  return workspaces[nextIndex].id
}

function closeActiveLayoutTab(workspaceId: string): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!model || !tabset) return false

  const selectedIndex = tabset.getSelected()
  const selectedNode = tabset.getChildren()[selectedIndex]
  if (!(selectedNode instanceof TabNode) || !selectedNode.isEnableClose()) return false

  model.doAction(Actions.deleteTab(selectedNode.getId()))
  return true
}

function firstTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabSetNode) found = node
  })
  return found
}

function findPanelTab(model: Model, component: WorkspacePanelComponent): TabNode | null {
  let found: TabNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabNode && node.getComponent() === component) {
      found = node
    }
  })
  return found
}

function toggleWorkspacePanel(workspaceId: string, component: WorkspacePanelComponent): void {
  const model = getModel(workspaceId)
  if (!model) return

  const existingTab = findPanelTab(model, component)
  if (existingTab) {
    model.doAction(Actions.deleteTab(existingTab.getId()))
    return
  }

  const tabName = component === 'explorer' ? 'Files' : component === 'git' ? 'Git' : 'Editor'
  const target = getPreferredPanelTarget(model, component)

  model.doAction(
    Actions.addNode(
      { type: 'tab', name: tabName, component },
      target.id,
      target.location,
      -1,
      true
    )
  )
}

function getPreferredPanelTarget(
  model: Model,
  component: WorkspacePanelComponent
): { id: string; location: DockLocation } {
  if (component === 'git') {
    const explorerTab = findPanelTab(model, 'explorer')
    const explorerParent = explorerTab?.getParent()
    if (explorerParent instanceof TabSetNode) {
      return {
        id: explorerParent.getId(),
        location: DockLocation.CENTER,
      }
    }
  }

  if (component === 'explorer') {
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    return {
      id: targetTabset?.getId() ?? model.getRoot().getId(),
      location: DockLocation.LEFT,
    }
  }

  const explorerTab = findPanelTab(model, 'explorer')
  const explorerParent = explorerTab?.getParent()
  if (explorerParent instanceof TabSetNode) {
    return {
      id: explorerParent.getId(),
      location: DockLocation.RIGHT,
    }
  }

  const targetTabset = model.getActiveTabset() ?? firstTabset(model)
  return {
    id: targetTabset?.getId() ?? model.getRoot().getId(),
    location: DockLocation.LEFT,
  }
}

type LayoutSessionNode = {
  component?: string
  config?: {
    agentId?: string
    terminalId?: string
  }
  children?: LayoutSessionNode[]
}

function terminateWorkspaceTerminals(workspace: Workspace): void {
  const sessionIds = new Set<string>()

  Object.values(workspace.agents).forEach((agent) => {
    if (agent.cliTerminalId) sessionIds.add(agent.cliTerminalId)
  })

  const collectLayoutSessions = (node: LayoutSessionNode | undefined) => {
    if (!node) return

    if (node.component === 'agent') {
      const agentId = node.config?.agentId
      const terminalId = agentId ? workspace.agents[agentId]?.cliTerminalId : undefined
      if (terminalId) sessionIds.add(terminalId)
    }

    if (node.component === 'terminal') {
      const terminalId = node.config?.terminalId
      if (terminalId) sessionIds.add(`terminal-${terminalId}`)
    }

    node.children?.forEach(collectLayoutSessions)
  }

  collectLayoutSessions(workspace.layoutModel.layout as LayoutSessionNode)
  workspace.layoutModel.borders?.forEach((border) => collectLayoutSessions(border as LayoutSessionNode))

  sessionIds.forEach((sessionId) => {
    void window.api.terminalKill(sessionId).catch(() => {})
  })
}

function SpecialistActionIcon({ icon, className }: { icon: SpecialistIcon; className?: string }) {
  if (icon === 'shield') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3.75L18.75 6.25V11.15C18.75 15.35 16.08 19.08 12 20.25C7.92 19.08 5.25 15.35 5.25 11.15V6.25L12 3.75Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9 12.05L11.05 14.1L15.25 9.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (icon === 'design') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4.5 17.5H19.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M7 17.5L9.4 7.2C9.65 6.13 10.52 5.35 11.55 5.35H12.45C13.48 5.35 14.35 6.13 14.6 7.2L17 17.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.4 12.75H15.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    )
  }

  if (icon === 'review') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6.5 4.75H15.25L18.5 8V19.25H6.5V4.75Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M15.25 4.75V8H18.5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M8.9 12.25L10.35 13.7L13.1 10.95" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.9 16.3H15.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 18.75V13.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M10 18.75V9.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M15 18.75V11.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M20 18.75V5.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4.5 19H20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="space-y-4 text-center">
        <p className="text-sm text-[#5a5a63]">No workspace open</p>
        <button
          onClick={onNew}
          className="rounded bg-[#111216] px-4 py-2 text-sm font-medium text-[#ececee] transition-colors hover:bg-[#17181d]"
        >
          New Workspace
        </button>
      </div>
    </div>
  )
}
