import React, { useState, useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useSettingsStore } from '../../store/settingsStore'
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
  const importWorkspace    = useWorkspaceStore((s) => s.importWorkspace)
  const apiKey             = useSettingsStore((s) => s.apiKey)
  const provider           = useSettingsStore((s) => s.provider)
  const needsApiKey        = provider === 'anthropic' && !apiKey

  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [showSettings, setShowSettings]   = useState(false)
  const [showPalette, setShowPalette]     = useState(false)
  const [renamingId, setRenamingId]       = useState<string | null>(null)
  const [renameValue, setRenameValue]     = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Onboarding: auto-open template selector on first launch
  useEffect(() => {
    if (workspaces.length === 0) setShowTemplateSelector(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId) renameInputRef.current?.select()
  }, [renamingId])

  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renamingId) return // let rename input handle keys
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      if (e.key === 'p') { e.preventDefault(); setShowPalette(true) }
      if (e.key === 't') { e.preventDefault(); setShowTemplateSelector(true) }
      if (e.key === 'w' && activeWorkspaceId) { e.preventDefault(); removeWorkspace(activeWorkspaceId) }
      if (e.key === ',') { e.preventDefault(); setShowSettings(true) }
      const n = parseInt(e.key)
      if (n >= 1 && n <= 9 && workspaces[n - 1]) {
        e.preventDefault()
        setActiveWorkspace(workspaces[n - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaces, activeWorkspaceId, renamingId, removeWorkspace, setActiveWorkspace])

  const handleSelect = (template: LayoutTemplate) => {
    addWorkspace(template)
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
    // Strip in-flight stream state before export
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

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Workspace tab bar */}
      <div className="flex items-center gap-0.5 px-2 h-10 bg-zinc-900 border-b border-zinc-800 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              onClick={() => { if (!renamingId) setActiveWorkspace(ws.id) }}
              className={`group flex items-center gap-1.5 px-2 py-1 rounded text-sm cursor-pointer select-none whitespace-nowrap transition-colors ${
                ws.id === activeWorkspaceId
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
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
                  className="w-32 bg-zinc-800 border border-indigo-500 rounded px-1.5 py-0 text-sm text-zinc-100 focus:outline-none"
                />
              ) : (
                <span onDoubleClick={(e) => startRename(e, ws)}>{ws.name}</span>
              )}

              {/* Export button — shown on hover */}
              <button
                onClick={(e) => handleExport(e, ws)}
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 text-xs leading-none transition-opacity"
                title={`Export "${ws.name}"`}
              >
                ↓
              </button>

              {/* Close button */}
              <button
                onClick={(e) => handleCloseTab(e, ws.id)}
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 text-xs leading-none transition-opacity"
                aria-label={`Close ${ws.name}`}
              >
                ×
              </button>
            </div>
          ))}

          <button
            onClick={() => setShowTemplateSelector(true)}
            className="px-3 py-1 rounded text-sm text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
            title="New workspace (Ctrl+T)"
          >
            +
          </button>

          <button
            onClick={handleImport}
            className="px-2 py-1 rounded text-xs text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
            title="Import workspace from .swarm.json"
          >
            ↑
          </button>
        </div>

        {/* Settings button — amber dot if no API key */}
        <button
          onClick={() => setShowSettings(true)}
          className="relative ml-auto shrink-0 px-2 py-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          title="Settings (Ctrl+,)"
        >
          <span className="text-base leading-none">⚙</span>
          {needsApiKey && (
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
          )}
        </button>
      </div>

      {/* Active workspace content */}
      <div className="flex-1 overflow-hidden">
        {activeWorkspaceId ? (
          <WorkspaceLayout key={activeWorkspaceId} workspaceId={activeWorkspaceId} />
        ) : (
          <EmptyState onNew={() => setShowTemplateSelector(true)} />
        )}
      </div>

      {showTemplateSelector && (
        <TemplateSelector onSelect={handleSelect} onClose={() => setShowTemplateSelector(false)} />
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

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <p className="text-zinc-600 text-sm">No workspace open</p>
        <button
          onClick={onNew}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-white text-sm transition-colors"
        >
          Create Workspace
        </button>
      </div>
    </div>
  )
}
