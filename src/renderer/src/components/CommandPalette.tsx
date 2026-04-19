import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUT_TEMPLATES } from '../layouts/templates'
import { useWorkspaceStore } from '../store/workspaceStore'

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
}

export default function CommandPalette({ onClose, onNewWorkspace }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { workspaces, activeWorkspaceId, setActiveWorkspace, addWorkspace, setActiveFile } = useWorkspaceStore()
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const openFiles = activeWorkspace?.editorState?.openFiles ?? []

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commands = useMemo((): Command[] => [
    ...LAYOUT_TEMPLATES.map((template) => ({
      id: `new-${template.id}`,
      label: `New Workspace: ${template.name}`,
      description: template.description,
      run: () => {
        addWorkspace(template)
        onClose()
      },
    })),
    ...workspaces.map((workspace) => ({
      id: `switch-${workspace.id}`,
      label: `Switch to: ${workspace.name}`,
      description: workspace.id === activeWorkspaceId ? 'active' : '',
      run: () => {
        setActiveWorkspace(workspace.id)
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
            onClose()
          },
        }))
      : []),
    {
      id: 'new-workspace',
      label: 'New Workspace...',
      shortcut: 'Ctrl+T',
      run: () => {
        onNewWorkspace()
        onClose()
      },
    },
  ], [workspaces, activeWorkspaceId, openFiles, addWorkspace, setActiveWorkspace, setActiveFile, onClose, onNewWorkspace])

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh] backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="w-[600px] max-w-[95vw] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <span className="text-sm text-zinc-500">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={handleKey}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none"
          />
          <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-600">Esc</kbd>
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-3 text-xs text-zinc-600">No results</p>
          ) : (
            filtered.map((command, index) => (
              <div
                key={command.id}
                onClick={command.run}
                onMouseEnter={() => setSelected(index)}
                className={`flex cursor-pointer items-center justify-between px-4 py-2 transition-colors ${
                  index === selected
                    ? 'bg-indigo-600/20 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{command.label}</div>
                  {command.description && (
                    <div className="mt-0.5 truncate text-[10px] text-zinc-600">{command.description}</div>
                  )}
                </div>
                {command.shortcut && (
                  <kbd className="ml-3 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-600">
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
