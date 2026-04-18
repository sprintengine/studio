import React, { useEffect, useRef, useState, useMemo } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import { LAYOUT_TEMPLATES } from '../layouts/templates'

interface Command {
  id: string
  label: string
  description?: string
  shortcut?: string
  run: () => void
}

interface Props {
  onClose: () => void
  onNewWorkspace: () => void
  onSettings: () => void
}

export default function CommandPalette({ onClose, onNewWorkspace, onSettings }: Props) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { workspaces, activeWorkspaceId, setActiveWorkspace, addWorkspace, setActiveFile } = useWorkspaceStore()
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)
  const openFiles = activeWs?.editorState?.openFiles ?? []

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commands = useMemo((): Command[] => [
    // Workspace commands
    ...LAYOUT_TEMPLATES.map((t) => ({
      id: `new-${t.id}`,
      label: `New Workspace: ${t.name}`,
      description: t.description,
      run: () => { addWorkspace(t); onClose() },
    })),
    // Switch to open workspace
    ...workspaces.map((ws) => ({
      id: `switch-${ws.id}`,
      label: `Switch to: ${ws.name}`,
      description: ws.id === activeWorkspaceId ? 'active' : '',
      run: () => { setActiveWorkspace(ws.id); onClose() },
    })),
    // Open recent files (from active workspace)
    ...(activeWorkspaceId
      ? openFiles.map((f) => ({
          id: `file-${f.path}`,
          label: f.name,
          description: f.path,
          run: () => { setActiveFile(activeWorkspaceId, f.path); onClose() },
        }))
      : []),
    {
      id: 'settings',
      label: 'Open Settings',
      shortcut: 'Ctrl+,',
      run: () => { onSettings(); onClose() },
    },
    {
      id: 'new-workspace',
      label: 'New Workspace…',
      shortcut: 'Ctrl+T',
      run: () => { onNewWorkspace(); onClose() },
    },
  ], [workspaces, activeWorkspaceId, openFiles, addWorkspace, setActiveWorkspace, setActiveFile, onClose, onNewWorkspace, onSettings])

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description?.toLowerCase().includes(query.toLowerCase())
      )
    : commands.slice(0, 12)

  const [selected, setSelected] = useState(0)

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
    if (e.key === 'Enter')     { filtered[selected]?.run() }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[600px] max-w-[95vw] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <span className="text-zinc-500 text-sm">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={handleKey}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-zinc-200 text-sm placeholder-zinc-600 focus:outline-none"
          />
          <kbd className="text-[10px] text-zinc-600 px-1.5 py-0.5 bg-zinc-800 rounded">Esc</kbd>
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-zinc-600 text-xs px-4 py-3">No results</p>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                onClick={cmd.run}
                onMouseEnter={() => setSelected(i)}
                className={`flex items-center justify-between px-4 py-2 cursor-pointer transition-colors ${
                  i === selected ? 'bg-indigo-600/20 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">{cmd.label}</div>
                  {cmd.description && (
                    <div className="text-[10px] text-zinc-600 truncate mt-0.5">{cmd.description}</div>
                  )}
                </div>
                {cmd.shortcut && (
                  <kbd className="text-[10px] text-zinc-600 px-1.5 py-0.5 bg-zinc-800 rounded ml-3 shrink-0">
                    {cmd.shortcut}
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
