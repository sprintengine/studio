import React, { useEffect, useState } from 'react'
import { useEditorStore } from '../../store/editorStore'

type Entry = { name: string; isDir: boolean; path: string }

function toEntries(raw: { name: string; isDir: boolean }[], parent: string): Entry[] {
  const joiner = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return raw
    .map((e) => ({ ...e, path: `${parent}${parent.endsWith(joiner) ? '' : joiner}${e.name}` }))
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

// File-type visual treatment. Keep the palette restrained: folders yellow,
// TS family blue, Java warm, JSON/package amber, markdown/text neutral.
function fileAppearance(name: string): { color: string; label: string } {
  if (name === 'package.json') return { color: 'text-amber-300',  label: '{}' }
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':   return { color: 'text-[#7ea4dd]', label: 'TS' }
    case 'js':
    case 'jsx':   return { color: 'text-amber-300',  label: 'JS' }
    case 'java':  return { color: 'text-[#d97b59]', label: 'JV' }
    case 'py':    return { color: 'text-emerald-400', label: 'PY' }
    case 'rs':    return { color: 'text-orange-400', label: 'RS' }
    case 'go':    return { color: 'text-sky-300',    label: 'GO' }
    case 'json':  return { color: 'text-amber-300',  label: '{}' }
    case 'yaml':
    case 'yml':   return { color: 'text-yellow-300', label: 'YML' }
    case 'md':    return { color: 'text-zinc-300',   label: 'MD' }
    case 'txt':   return { color: 'text-zinc-400',   label: 'TXT' }
    case 'html':  return { color: 'text-orange-300', label: '<>' }
    case 'css':
    case 'scss':  return { color: 'text-sky-300',    label: '#' }
    case 'sh':
    case 'bash':  return { color: 'text-emerald-300', label: 'SH' }
    default:      return { color: 'text-zinc-500',   label: '·' }
  }
}

function FileIcon({ name }: { name: string }) {
  const { color, label } = fileAppearance(name)
  return (
    <span className={`inline-flex justify-center items-center w-[18px] h-[16px] text-[9px] font-bold font-mono leading-none ${color}`}>
      {label}
    </span>
  )
}

function EntryRow({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: Entry
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const { openFile } = useEditorStore()

  const toggle = async () => {
    onSelect(entry.path)
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
      setLoading(true)
      try {
        const raw = await window.api.readdir(entry.path)
        setChildren(toEntries(raw, entry.path))
      } finally {
        setLoading(false)
      }
    }
    setOpen((o) => !o)
  }

  const isSelected = selected === entry.path

  return (
    <>
      <div
        onClick={toggle}
        className={`group flex items-center gap-2 h-[26px] rounded-md text-[12px] cursor-pointer select-none transition-colors ${
          isSelected
            ? 'bg-[#1d2026] text-zinc-100'
            : 'text-zinc-400 hover:text-zinc-100 hover:bg-[#17191d]'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px`, paddingRight: 8 }}
      >
        {entry.isDir ? (
          <>
            <span className="w-3 text-[10px] text-zinc-500 shrink-0">
              {open ? '▾' : '▸'}
            </span>
            <span className="inline-flex justify-center items-center w-[18px] text-[11px] font-bold text-[#d2b48c] shrink-0 leading-none">
              ▢
            </span>
            <span className={`truncate ${entry.name === 'node_modules' ? 'text-zinc-600' : ''}`}>
              {entry.name}
            </span>
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileIcon name={entry.name} />
            <span className="truncate">{entry.name}</span>
          </>
        )}
      </div>
      {open && !loading &&
        children.map((child) => (
          <EntryRow
            key={child.path}
            entry={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      {open && loading && (
        <div
          className="text-[11px] text-zinc-600 py-0.5"
          style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
        >
          loading…
        </div>
      )}
    </>
  )
}

function ExplorerTree({ rootPath }: { rootPath: string }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setSelected(null)
    window.api.readdir(rootPath).then((raw) => {
      setEntries(toEntries(raw, rootPath))
      setLoading(false)
    })
  }, [rootPath])

  if (loading) return <div className="text-[11px] text-zinc-600 px-4 py-2">Loading…</div>
  return (
    <div className="flex flex-col gap-px">
      {entries.map((e) => (
        <EntryRow
          key={e.path}
          entry={e}
          depth={0}
          selected={selected}
          onSelect={setSelected}
        />
      ))}
    </div>
  )
}

export default function FileExplorer() {
  const { rootPath, setRootPath } = useEditorStore()

  const handleOpen = async () => {
    const dir = await window.api.openDir()
    if (dir) setRootPath(dir)
  }

  const rootName = rootPath?.split(/[/\\]/).filter(Boolean).pop() ?? ''

  return (
    <div className="flex flex-col h-full bg-[#121316] text-zinc-300 overflow-hidden">
      <div className="flex items-center justify-between px-3 h-9 border-b border-[#23262d] shrink-0 bg-[#14161a]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-zinc-500">Files</span>
          {rootName && (
            <span className="text-[11px] text-zinc-400 font-mono truncate">{rootName}</span>
          )}
        </div>
        <button
          onClick={handleOpen}
          className="h-6 px-2 rounded-md border border-[#23262d] bg-[#17191d] text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-[#1c1f25] transition-colors"
        >
          Open
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5 px-1">
        {rootPath ? (
          <ExplorerTree rootPath={rootPath} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
            <p className="text-[12px] text-center px-4">No folder open</p>
            <button
              onClick={handleOpen}
              className="text-[11px] px-3 py-1.5 bg-[#17191d] hover:bg-[#1c1f25] rounded-md border border-[#23262d] transition-colors text-zinc-400"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
