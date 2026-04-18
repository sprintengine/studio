import React, { useEffect, useState } from 'react'
import { useEditorStore } from '../../store/editorStore'

type Entry = { name: string; isDir: boolean; path: string }

function toEntries(raw: { name: string; isDir: boolean }[], parent: string): Entry[] {
  return raw
    .map((e) => ({ ...e, path: `${parent}/${e.name}` }))
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase()
  const color =
    ['ts', 'tsx'].includes(ext ?? '') ? 'text-blue-400' :
    ['js', 'jsx'].includes(ext ?? '') ? 'text-yellow-400' :
    ['py'].includes(ext ?? '') ? 'text-green-400' :
    ['json', 'yaml', 'yml'].includes(ext ?? '') ? 'text-orange-400' :
    ['md'].includes(ext ?? '') ? 'text-zinc-300' :
    'text-zinc-500'
  return <span className={`${color} font-mono text-[10px]`}>›</span>
}

function EntryRow({ entry, depth }: { entry: Entry; depth: number }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<Entry[]>([])
  const { openFile } = useEditorStore()

  const toggle = async () => {
    if (!entry.isDir) {
      try {
        const content = await window.api.readfile(entry.path)
        openFile(entry.path, entry.name, content)
      } catch {
        openFile(entry.path, entry.name, '')
      }
      return
    }
    if (!open && children.length === 0) {
      const raw = await window.api.readdir(entry.path)
      setChildren(toEntries(raw, entry.path))
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <div
        onClick={toggle}
        className="flex items-center gap-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 cursor-pointer select-none rounded transition-colors"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {entry.isDir ? (
          <span className="text-yellow-500/80 w-3">{open ? '▾' : '▸'}</span>
        ) : (
          <FileIcon name={entry.name} />
        )}
        <span className={entry.isDir ? 'text-zinc-300' : ''}>{entry.name}</span>
      </div>
      {open &&
        children.map((child) => (
          <EntryRow key={child.path} entry={child} depth={depth + 1} />
        ))}
    </>
  )
}

function ExplorerTree({ rootPath }: { rootPath: string }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    window.api.readdir(rootPath).then((raw) => {
      setEntries(toEntries(raw, rootPath))
      setLoading(false)
    })
  }, [rootPath])

  if (loading) return <div className="text-[10px] text-zinc-600 px-4 py-2">Loading…</div>
  return (
    <div>
      {entries.map((e) => <EntryRow key={e.path} entry={e} depth={0} />)}
    </div>
  )
}

export default function FileExplorer() {
  const { rootPath, setRootPath } = useEditorStore()

  const handleOpen = async () => {
    const dir = await window.api.openDir()
    if (dir) setRootPath(dir)
  }

  return (
    <div className="flex flex-col h-full bg-zinc-900 text-zinc-300 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 shrink-0">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Explorer</span>
        <button
          onClick={handleOpen}
          className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Open Folder
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {rootPath ? (
          <>
            <div className="px-3 py-1 text-[10px] text-zinc-600 font-medium uppercase tracking-wider truncate">
              {rootPath.split(/[/\\]/).pop()}
            </div>
            <ExplorerTree rootPath={rootPath} />
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
            <p className="text-xs text-center px-4">No folder open</p>
            <button
              onClick={handleOpen}
              className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors text-zinc-400"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
