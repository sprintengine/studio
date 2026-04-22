import React, { useEffect, useRef, useState } from 'react'
import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import CliIcon from '../CliIcon'
import CommandPalette from '../CommandPalette'
import SettingsModal from '../settings/SettingsModal'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, LayoutTemplate, Workspace } from '../../types/workspace'
import { getModel } from '../../utils/modelRegistry'
import TemplateSelector from './TemplateSelector'
import WorkspaceLayout from './WorkspaceLayout'

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const CLI_OPTIONS: Array<{ value: AgentCli; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
]

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

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
  const selectedCliOption = CLI_OPTIONS.find((option) => option.value === lastSelectedCli) ?? CLI_OPTIONS[0]

  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [cliMenuOpen, setCliMenuOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const cliMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (workspaces.length === 0) setShowTemplateSelector(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    setCliMenuOpen(false)
  }, [activeWorkspaceId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || renamingId) return

      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl) return

      if (event.key === 'Tab' && activeWorkspaceId) {
        event.preventDefault()
        cycleActiveTab(activeWorkspaceId, event.shiftKey ? -1 : 1)
        return
      }

      if (event.key === 'p') {
        event.preventDefault()
        setShowPalette(true)
      }
      if (event.key === 't') {
        event.preventDefault()
        setShowTemplateSelector(true)
      }
      if (event.key === 'w' && activeWorkspaceId) {
        event.preventDefault()
        removeWorkspace(activeWorkspaceId)
      }

      const n = parseInt(event.key)
      if (n >= 1 && n <= 9 && workspaces[n - 1]) {
        event.preventDefault()
        setActiveWorkspace(workspaces[n - 1].id)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaces, activeWorkspaceId, renamingId, removeWorkspace, setActiveWorkspace])

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
    event.stopPropagation()
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

  const addNewCLI = (cli: AgentCli = lastSelectedCli) => {
    if (!activeWorkspaceId || activeWorkspace?.mode === 'swarm') return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const newId = `agent-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    updateAgent(activeWorkspaceId, newId, { name: newId, cli })
    model.doAction(
      Actions.addNode(
        { type: 'tab', name: newId, component: 'agent', config: { agentId: newId } },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
  }

  const addNewTerminal = () => {
    if (!activeWorkspaceId) return
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

  const handleSelectCli = (cli: AgentCli) => {
    setLastSelectedCli(cli)
    setCliMenuOpen(false)
    addNewCLI(cli)
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
          className="app-drag flex h-[36px] shrink-0 items-center gap-1 border-b border-[#1f2025] bg-[#0d0e11] px-2"
          style={{ paddingRight: 138 }}
        >
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
      )}

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspaceId
            return (
              <div
                key={workspace.id}
                onClick={() => {
                  if (!renamingId) setActiveWorkspace(workspace.id)
                }}
                className={`group inline-flex h-[30px] cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-[13px] transition-colors ${
                  active
                    ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                    : 'border-transparent text-[#8a8a92] hover:bg-[#15161a] hover:text-[#d7d7dc]'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[#30d158]' : 'bg-[#5a5a63]'}`} />
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
            onClick={() => setShowTemplateSelector(true)}
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-[#8a8a92] transition-colors hover:bg-[#15161a] hover:text-[#d7d7dc]"
            title="New workspace (Ctrl+T)"
          >
            + New Workspace
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {activeWorkspace ? (
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

          {activeWorkspace?.mode !== 'swarm' && (
            <div ref={cliMenuRef} className="relative inline-flex">
              <div className="inline-flex overflow-hidden rounded-md border border-[#24252b] bg-[#111216]">
                <button
                  onClick={() => addNewCLI()}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-8 items-center justify-center text-[#30d158] transition-colors hover:bg-[#17181d] disabled:opacity-40 disabled:hover:bg-[#111216]"
                  title={`Add a new ${selectedCliOption.label} pane to the active workspace`}
                  aria-label={`Add ${selectedCliOption.label} pane`}
                >
                  <CliIcon cli={selectedCliOption.value} className="h-[18px] w-[18px]" />
                </button>
                <button
                  onClick={() => setCliMenuOpen((open) => !open)}
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
            {workspaces.length === 0 && <EmptyState onNew={() => setShowTemplateSelector(true)} />}
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
          onNewWorkspace={() => setShowTemplateSelector(true)}
        />
      )}
    </div>
  )
}

function cycleActiveTab(workspaceId: string, step: 1 | -1): void {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!tabset) return

  const tabs = tabset.getChildren().filter((node): node is TabNode => node instanceof TabNode)
  if (tabs.length < 2) return

  const selectedIndex = tabset.getSelected()
  const nextIndex = (selectedIndex + step + tabs.length) % tabs.length
  model?.doAction(Actions.selectTab(tabs[nextIndex].getId()))
}

function firstTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabSetNode) found = node
  })
  return found
}

function findPanelTab(model: Model, component: 'explorer' | 'editor'): TabNode | null {
  let found: TabNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabNode && node.getComponent() === component) {
      found = node
    }
  })
  return found
}

function toggleWorkspacePanel(workspaceId: string, component: 'explorer' | 'editor'): void {
  const model = getModel(workspaceId)
  if (!model) return

  const existingTab = findPanelTab(model, component)
  if (existingTab) {
    model.doAction(Actions.deleteTab(existingTab.getId()))
    return
  }

  const tabName = component === 'explorer' ? 'Files' : 'Editor'
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
  component: 'explorer' | 'editor'
): { id: string; location: DockLocation } {
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
