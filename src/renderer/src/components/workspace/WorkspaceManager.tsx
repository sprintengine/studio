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
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#2b3442] bg-[#141a23] transition-colors hover:border-[#435064] hover:bg-[#19212c] disabled:opacity-40 disabled:hover:bg-[#141a23]"
              title="Add a new Claude CLI pane to the active workspace"
            >
              <svg width="18" height="18" viewBox="0 0 248 248" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" fill="#D97757"/>
              </svg>
            </button>
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
