import React, { useCallback, useEffect, useRef, useState } from 'react'
import MonacoEditor from '@monaco-editor/react'
import { detectLanguage } from '../../utils/files'
import { MONO_FONT_STACK } from '../../utils/fonts'
import {
  createExternalFileLoadingBuffer,
  createExternalFileTab,
  isExternalFileBufferDirty,
  loadExternalFileBuffer,
  type ExternalFileBuffer,
  type ExternalFileTab,
} from './externalEditorFile'

// One open file in the external editor window. Content is read off disk and
// edited in place; `saved` is the on-disk baseline used to derive the dirty dot.
type FileTab = ExternalFileTab
type FileBuffer = ExternalFileBuffer

export type IncomingFile = {
  filePath: string
  fileName: string
  workspaceId: string
}

type Props = {
  // The most recent file the opener asked to show. `nonce` bumps on every
  // request (even a repeat of the same path) so re-opening focuses its tab.
  incoming: IncomingFile | null
  nonce: number
}

function isDirty(buffer: FileBuffer | undefined): boolean {
  return isExternalFileBufferDirty(buffer)
}

export default function ExternalEditorWindow({ incoming, nonce }: Props) {
  const isMac = window.api.platform === 'darwin'
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Record<string, FileBuffer>>({})
  const tabsRef = useRef<FileTab[]>([])
  tabsRef.current = tabs
  const buffersRef = useRef<Record<string, FileBuffer>>({})
  buffersRef.current = buffers

  const loadBuffer = useCallback((tab: FileTab) => {
    setBuffers((prev) => ({ ...prev, [tab.path]: createExternalFileLoadingBuffer(tab.kind) }))
    void loadExternalFileBuffer(tab.path, tab.kind, window.api).then((buffer) => {
      setBuffers((prev) => ({ ...prev, [tab.path]: buffer }))
    })
  }, [])

  // Add (or focus) the incoming file as a tab whenever the opener sends one.
  useEffect(() => {
    if (!incoming) return
    const { filePath, fileName, workspaceId } = incoming
    setActivePath(filePath)
    if (!tabsRef.current.some((tab) => tab.path === filePath)) {
      const tab = createExternalFileTab({ path: filePath, name: fileName, workspaceId })
      setTabs((prev) => [...prev, tab])
      loadBuffer(tab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null
  const activeBuffer = activePath ? buffers[activePath] : undefined

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const next = prev.filter((tab) => tab.path !== path)
        if (next.length === 0) {
          void window.api.windowClose()
          return prev
        }
        setActivePath((current) => {
          if (current !== path) return current
          const closedIndex = prev.findIndex((tab) => tab.path === path)
          const neighbor = next[Math.min(closedIndex, next.length - 1)]
          return neighbor?.path ?? null
        })
        return next
      })
      setBuffers((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
    },
    []
  )

  const saveBuffer = useCallback(async (path: string): Promise<void> => {
    const buffer = buffersRef.current[path]
    if (!buffer || buffer.kind !== 'text' || buffer.loading || !isDirty(buffer)) return
    const value = buffer.value
    try {
      await window.api.writefile(path, value)
      setBuffers((prev) => {
        const current = prev[path]
        if (!current) return prev
        return { ...prev, [path]: { ...current, saved: value } }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setBuffers((prev) => {
        const current = prev[path]
        if (!current) return prev
        return { ...prev, [path]: { ...current, error: message } }
      })
    }
  }, [])

  const saveActive = useCallback(() => {
    if (activePath) void saveBuffer(activePath)
  }, [activePath, saveBuffer])

  const dockActive = useCallback(async () => {
    if (!activeTab) return
    // Persist pending edits before docking so the workspace tab (which reloads
    // from disk) reflects them — docking moves the file, it does not discard work.
    await saveBuffer(activeTab.path)
    await window.api.dockFileToWorkspace({
      workspaceId: activeTab.workspaceId,
      path: activeTab.path,
      name: activeTab.name,
    })
    closeTab(activeTab.path)
  }, [activeTab, closeTab, saveBuffer])

  // Cmd/Ctrl+S saves the active file; the editor itself is the focus target.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveActive()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveActive])

  return (
    <div className="flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <div
        className={`app-drag flex h-[36px] shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] pr-2 ${
          isMac ? 'pl-[78px]' : 'pl-2'
        }`}
      >
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const selected = tab.path === activePath
            return (
              <div
                key={tab.path}
                className={`app-no-drag group/tab flex h-[28px] min-w-0 shrink-0 items-center gap-1.5 self-center rounded-md px-2 text-[12px] transition-colors ${
                  selected
                    ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActivePath(tab.path)}
                  className="min-w-0 max-w-[200px] truncate bg-transparent"
                  title={tab.path}
                >
                  {tab.name}
                </button>
                <span
                  className={`inline-flex h-3 w-3 shrink-0 items-center justify-center ${isDirty(buffers[tab.path]) ? '' : 'opacity-0 group-hover/tab:opacity-100'}`}
                >
                  {isDirty(buffers[tab.path]) ? (
                    <span className="text-[color:var(--tone-warn)]" aria-label="Unsaved changes" title="Unsaved changes">
                      •
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => closeTab(tab.path)}
                      aria-label={`Close ${tab.name}`}
                      className="text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]"
                    >
                      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => void dockActive()}
          disabled={!activeTab}
          aria-label="Dock current file back into the workspace"
          className="app-no-drag inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Dock into workspace
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {renderBody(activeTab, activeBuffer, activePath, setBuffers)}
      </div>
    </div>
  )
}

function renderBody(
  activeTab: FileTab | null,
  buffer: FileBuffer | undefined,
  activePath: string | null,
  setBuffers: React.Dispatch<React.SetStateAction<Record<string, FileBuffer>>>
): React.ReactNode {
  if (!activeTab || !activePath) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] font-mono text-[color:var(--text-disabled)]">
        No file open.
      </div>
    )
  }
  if (!buffer || buffer.loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] font-mono text-[color:var(--text-disabled)]">
        Loading…
      </div>
    )
  }
  if (buffer.error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] font-mono text-[color:var(--tone-error)]">
        {buffer.error}
      </div>
    )
  }
  if (buffer.kind === 'image') {
    if (!buffer.dataUrl) {
      return (
        <div className="flex h-full items-center justify-center text-[13px] font-mono text-[color:var(--text-disabled)]">
          Loading image…
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img
            src={buffer.dataUrl}
            alt={activeTab.name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      </div>
    )
  }
  return (
    <MonacoEditor
      key={activePath}
      height="100%"
      theme="vs-dark"
      language={detectLanguage(activeTab.name)}
      value={buffer.value}
      options={{
        fontSize: 13,
        fontFamily: MONO_FONT_STACK,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
      onChange={(value) => {
        if (value === undefined) return
        setBuffers((prev) => {
          const current = prev[activePath]
          if (!current || current.kind !== 'text') return prev
          return { ...prev, [activePath]: { ...current, value } }
        })
      }}
    />
  )
}
