import React, { useEffect, useRef, useState } from 'react'
import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import CommandPalette from '../CommandPalette'
import SettingsModal from '../settings/SettingsModal'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { LayoutTemplate, Workspace } from '../../types/workspace'
import { getModel } from '../../utils/modelRegistry'
import TemplateSelector from './TemplateSelector'
import WorkspaceLayout from './WorkspaceLayout'

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const

export default function WorkspaceManager() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const importWorkspace = useWorkspaceStore((s) => s.importWorkspace)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null

  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (workspaces.length === 0) setShowTemplateSelector(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select()
  }, [renamingId])

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

  const handleExport = async (event: React.MouseEvent, workspace: Workspace) => {
    event.stopPropagation()
    const filePath = await window.api.saveFile({
      title: 'Export Workspace',
      defaultPath: `${workspace.name.replace(/[^a-z0-9_\- ]/gi, '_')}.workspace.json`,
      filters: [{ name: 'Workspace', extensions: ['json'] }],
    })
    if (!filePath) return

    const exportData = {
      ...workspace,
      agents: Object.fromEntries(
        Object.entries(workspace.agents).map(([id, agent]) => [
          id,
          { ...agent, streamBuffer: '', status: 'idle' as const },
        ])
      ),
    }

    await window.api.writefile(filePath, JSON.stringify(exportData, null, 2))
  }

  const handleImport = async () => {
    const filePath = await window.api.openFile({
      title: 'Import Workspace',
      filters: [{ name: 'Workspace', extensions: ['json'] }],
    })
    if (!filePath) return

    try {
      const raw = await window.api.readfile(filePath)
      const workspace = JSON.parse(raw) as Workspace
      importWorkspace(workspace)
    } catch {
      console.error('[import] Failed to parse workspace file')
    }
  }

  const addNewCLI = () => {
    if (!activeWorkspaceId || activeWorkspace?.mode === 'swarm') return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const newId = `agent-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

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
    <div className="flex h-screen flex-col overflow-hidden bg-[#0b0d10] text-zinc-100">
      {window.api.platform !== 'darwin' && (
        <div
          className="app-drag flex h-[36px] shrink-0 items-center gap-1 border-b border-[#202631] bg-[#0f1217] px-2"
          style={{ paddingRight: 138 }}
        >
          {MENU_BAR_ITEMS.map((label) => (
            <button
              key={label}
              onClick={(event) => void handleShowMenubarMenu(event, label)}
              className="app-no-drag inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-[#8d96a8] transition-colors hover:bg-[#171d26] hover:text-[#e7ecf4]"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#202631] bg-[#0d1015] px-3 py-2">
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
                    ? 'border-[#344152] bg-[#151c26] text-[#f2f5f9]'
                    : 'border-transparent text-[#778196] hover:bg-[#141a23] hover:text-[#dbe1ea]'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[#6ee7d8]' : 'bg-[#4c5668]'}`} />
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
                    className="w-32 rounded border border-[#3a4454] bg-[#0b0f14] px-1.5 py-0 text-[13px] text-[#f2f5f9] focus:outline-none"
                  />
                ) : (
                  <span onDoubleClick={(event) => startRename(event, workspace)}>{workspace.name}</span>
                )}

                <button
                  onClick={(event) => handleExport(event, workspace)}
                  className="text-xs leading-none text-[#5f6878] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#dbe1ea]"
                  title={`Export "${workspace.name}"`}
                >
                  Export
                </button>
                <button
                  onClick={(event) => handleCloseTab(event, workspace.id)}
                  className="text-xs leading-none text-[#5f6878] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#dbe1ea]"
                  aria-label={`Close ${workspace.name}`}
                >
                  x
                </button>
              </div>
            )
          })}

          <button
            onClick={() => setShowTemplateSelector(true)}
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-[#778196] transition-colors hover:bg-[#141a23] hover:text-[#dbe1ea]"
            title="New workspace (Ctrl+T)"
          >
            + New Workspace
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {activeWorkspace?.mode !== 'swarm' && (
            <button
              onClick={addNewCLI}
              disabled={!activeWorkspaceId}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-[#2b3442] bg-[#141a23] px-3 text-[12px] font-medium text-[#e7ecf4] transition-colors hover:border-[#435064] hover:bg-[#19212c] disabled:opacity-40 disabled:hover:bg-[#141a23]"
              title="Add a new CLI pane to the active workspace"
            >
              New CLI
            </button>
          )}
          <button
            onClick={handleImport}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#222833] bg-[#11161d] text-[#778196] transition-colors hover:border-[#384456] hover:bg-[#141a23] hover:text-[#dbe1ea]"
            title="Import workspace"
          >
            +
          </button>
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
                    visibility: active ? 'visible' : 'hidden',
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
        <p className="text-sm text-zinc-600">No workspace open</p>
        <button
          onClick={onNew}
          className="rounded bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
        >
          New Workspace
        </button>
      </div>
    </div>
  )
}
