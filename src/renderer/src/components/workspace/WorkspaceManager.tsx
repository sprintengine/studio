import React, { useState, useEffect, useRef } from 'react'
import { Actions, DockLocation, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useEditorStore } from '../../store/editorStore'
import { useSettingsStore } from '../../store/settingsStore'
import { getModel } from '../../utils/modelRegistry'
import TemplateSelector from './TemplateSelector'
import WorkspaceLayout from './WorkspaceLayout'
import SettingsModal from '../settings/SettingsModal'
import CommandPalette from '../CommandPalette'
import type { LayoutTemplate, Workspace } from '../../types/workspace'

export default function WorkspaceManager() {
  const workspaces         = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId  = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace    = useWorkspaceStore((s) => s.removeWorkspace)
  const renameWorkspace    = useWorkspaceStore((s) => s.renameWorkspace)
  const addWorkspace       = useWorkspaceStore((s) => s.addWorkspace)
  const updateSwarm        = useWorkspaceStore((s) => s.updateSwarm)
  const importWorkspace    = useWorkspaceStore((s) => s.importWorkspace)
  const setRootPath        = useEditorStore((s) => s.setRootPath)
  const apiKey             = useSettingsStore((s) => s.apiKey)
  const provider           = useSettingsStore((s) => s.provider)
  const needsApiKey        = provider === 'anthropic' && !apiKey

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const swarmEnabled = activeWorkspace?.swarmConfig.enabled ?? false

  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [showSettings, setShowSettings]   = useState(false)
  const [showPalette, setShowPalette]     = useState(false)
  const [renamingId, setRenamingId]       = useState<string | null>(null)
  const [renameValue, setRenameValue]     = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Onboarding: auto-open new-workspace screen on first launch
  useEffect(() => {
    if (workspaces.length === 0) setShowTemplateSelector(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync editor rootPath with active workspace folder.
  useEffect(() => {
    if (activeWorkspace?.folderPath) setRootPath(activeWorkspace.folderPath)
  }, [activeWorkspaceId, activeWorkspace?.folderPath, setRootPath])

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId) renameInputRef.current?.select()
  }, [renamingId])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renamingId) return
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      if (e.key === 'p')             { e.preventDefault(); setShowPalette(true) }
      if (e.key === 't')             { e.preventDefault(); setShowTemplateSelector(true) }
      if (e.key === 'w' && activeWorkspaceId) { e.preventDefault(); removeWorkspace(activeWorkspaceId) }
      if (e.key === ',')             { e.preventDefault(); setShowSettings(true) }
      const n = parseInt(e.key)
      if (n >= 1 && n <= 9 && workspaces[n - 1]) {
        e.preventDefault()
        setActiveWorkspace(workspaces[n - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaces, activeWorkspaceId, renamingId, removeWorkspace, setActiveWorkspace])

  const handleCreate = ({
    template, name, folderPath,
  }: { template: LayoutTemplate; name: string; folderPath: string | null }) => {
    addWorkspace(template, { name, folderPath })
    if (folderPath) setRootPath(folderPath)
    setShowTemplateSelector(false)
  }

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    removeWorkspace(id)
  }

  const startRename = (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation()
    setRenamingId(ws.id)
    setRenameValue(ws.name)
  }

  const commitRename = () => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const handleExport = async (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation()
    const filePath = await window.api.saveFile({
      title: 'Export Workspace',
      defaultPath: `${ws.name.replace(/[^a-z0-9_\- ]/gi, '_')}.swarm.json`,
      filters: [{ name: 'Swarm Workspace', extensions: ['swarm.json', 'json'] }],
    })
    if (!filePath) return
    const exportData = {
      ...ws,
      agents: Object.fromEntries(
        Object.entries(ws.agents).map(([id, a]) => [
          id,
          { ...a, streamBuffer: '', status: 'idle' as const },
        ])
      ),
    }
    await window.api.writefile(filePath, JSON.stringify(exportData, null, 2))
  }

  const handleImport = async () => {
    const filePath = await window.api.openFile({
      title: 'Import Workspace',
      filters: [{ name: 'Swarm Workspace', extensions: ['swarm.json', 'json'] }],
    })
    if (!filePath) return
    try {
      const raw = await window.api.readfile(filePath)
      const ws = JSON.parse(raw) as Workspace
      importWorkspace(ws)
    } catch {
      console.error('[import] Failed to parse workspace file')
    }
  }

  const addNewCLI = () => {
    if (!activeWorkspaceId) return
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

  const toggleSwarm = () => {
    if (!activeWorkspaceId) return
    updateSwarm(activeWorkspaceId, { enabled: !swarmEnabled })
  }

  return (
    <div className="flex flex-col h-screen text-zinc-100 overflow-hidden bg-[#09090a]">
      {/* Subtle background texture */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.018) 0, rgba(255,255,255,0.018) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      {/* ── Global bar ─────────────────────────────────────────────────── */}
      <div
        className="relative z-10 grid items-center gap-4 px-4 h-[52px] border-b border-[#23262d] bg-[#101114] shrink-0"
        style={{ gridTemplateColumns: 'auto 1fr auto' }}
      >
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg border border-[#393c44] bg-gradient-to-b from-[#2d2f34] to-[#1a1c21]" />
          <strong className="text-[13px] font-semibold tracking-tight text-zinc-100">Free AI IDE</strong>
        </div>

        <button
          onClick={() => setShowPalette(true)}
          className="flex items-center gap-2 h-9 px-3.5 rounded-[11px] border border-[#23262d] bg-[#14161a] text-[12px] text-zinc-500 hover:text-zinc-300 hover:border-[#2d3139] transition-colors max-w-[520px] w-full justify-self-center"
          title="Command palette (Ctrl+P)"
        >
          <span className="opacity-70">⌕</span>
          <span className="flex-1 text-left truncate">Search files, commands, workspaces</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="relative h-9 px-3 rounded-[11px] border border-[#23262d] bg-[#14161a] text-[12px] text-zinc-400 hover:text-zinc-200 hover:border-[#2d3139] transition-colors"
            title="Settings (Ctrl+,)"
          >
            Settings
            {needsApiKey && (
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
            )}
          </button>
        </div>
      </div>

      {/* ── Workspace tabs row ─────────────────────────────────────────── */}
      <div className="relative z-10 flex items-center justify-between gap-3 px-3 py-2 border-b border-[#23262d] bg-[#111214] shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto">
          {workspaces.map((ws) => {
            const active = ws.id === activeWorkspaceId
            return (
              <div
                key={ws.id}
                onClick={() => { if (!renamingId) setActiveWorkspace(ws.id) }}
                className={`group inline-flex items-center gap-2 h-[30px] px-2.5 rounded-[10px] text-[13px] cursor-pointer select-none whitespace-nowrap border transition-colors ${
                  active
                    ? 'border-[#2d3139] bg-[#1a1c20] text-zinc-100'
                    : 'border-transparent text-zinc-500 hover:text-zinc-200 hover:bg-[#16181c]'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-[#d2b48c]' : 'bg-[#4c515a]'}`}
                />
                {renamingId === ws.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenamingId(null)
                      e.stopPropagation()
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-32 bg-[#0f1012] border border-[#3d4252] rounded px-1.5 py-0 text-[13px] text-zinc-100 focus:outline-none"
                  />
                ) : (
                  <span onDoubleClick={(e) => startRename(e, ws)}>{ws.name}</span>
                )}

                <button
                  onClick={(e) => handleExport(e, ws)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-200 text-xs leading-none transition-opacity"
                  title={`Export "${ws.name}"`}
                >
                  ↓
                </button>
                <button
                  onClick={(e) => handleCloseTab(e, ws.id)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-200 text-xs leading-none transition-opacity"
                  aria-label={`Close ${ws.name}`}
                >
                  ×
                </button>
              </div>
            )
          })}

          <button
            onClick={() => setShowTemplateSelector(true)}
            className="inline-flex items-center gap-1.5 h-[30px] px-2.5 rounded-[10px] text-[13px] text-zinc-500 hover:text-zinc-200 hover:bg-[#16181c] transition-colors shrink-0"
            title="New workspace (Ctrl+T)"
          >
            + New Workspace
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={addNewCLI}
            disabled={!activeWorkspaceId}
            className="inline-flex items-center gap-2 h-8 px-3 rounded-[10px] border border-[#2d3139] bg-[#1c1f25] text-[12px] font-medium text-zinc-100 hover:bg-[#222530] transition-colors disabled:opacity-40 disabled:hover:bg-[#1c1f25]"
            title="Add a new CLI pane to the active workspace"
          >
            New CLI
          </button>
          <button
            onClick={toggleSwarm}
            disabled={!activeWorkspaceId}
            className={`inline-flex items-center gap-2 h-8 px-3 rounded-[10px] border text-[12px] font-medium transition-colors disabled:opacity-40 ${
              swarmEnabled
                ? 'border-[#3d4c6b] bg-[#1a223a] text-[#a9c8ff] hover:bg-[#1d2742]'
                : 'border-[#23262d] bg-[#17191d] text-zinc-400 hover:text-zinc-200 hover:bg-[#1c1f25]'
            }`}
            title="Toggle swarm mode for this workspace"
          >
            Swarm {swarmEnabled ? '· on' : ''}
          </button>
          <button
            onClick={handleImport}
            className="inline-flex items-center h-8 w-8 justify-center rounded-[10px] border border-[#23262d] bg-[#17191d] text-zinc-500 hover:text-zinc-200 hover:bg-[#1c1f25] transition-colors"
            title="Import workspace from .swarm.json"
          >
            +
          </button>
        </div>
      </div>

      {/* ── Active workspace ──────────────────────────────────────────── */}
      <div className="relative z-10 flex-1 min-h-0">
        {activeWorkspaceId ? (
          <WorkspaceLayout key={activeWorkspaceId} workspaceId={activeWorkspaceId} />
        ) : (
          <EmptyState onNew={() => setShowTemplateSelector(true)} />
        )}
      </div>

      {showTemplateSelector && (
        <TemplateSelector
          onCreate={handleCreate}
          onClose={() => setShowTemplateSelector(false)}
          allowClose={workspaces.length > 0}
        />
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewWorkspace={() => setShowTemplateSelector(true)}
          onSettings={() => setShowSettings(true)}
        />
      )}
    </div>
  )
}

function firstTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabSetNode) found = node
  })
  return found
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <p className="text-zinc-600 text-sm">No workspace open</p>
        <button
          onClick={onNew}
          className="px-4 py-2 bg-zinc-200 hover:bg-white rounded text-zinc-950 text-sm font-medium transition-colors"
        >
          New Workspace
        </button>
      </div>
    </div>
  )
}
