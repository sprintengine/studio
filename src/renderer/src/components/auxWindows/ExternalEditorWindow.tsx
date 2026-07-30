import React, { useCallback, useEffect, useRef, useState } from 'react'
import MonacoEditor from '@monaco-editor/react'
import { detectLanguage } from '../../utils/files'
import { MONO_FONT_STACK } from '../../utils/fonts'
import { useMonacoBaseTheme } from '../../hooks/useAppTheme'
import { renderMarkdown } from '../../utils/markdown'
import { TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_INSET } from '../workspace/AppTitleBar'
import { IconButton, Tooltip } from '../ui'
import {
  createExternalFileLoadingBuffer,
  createExternalFileTab,
  isExternalFileBufferDirty,
  loadExternalFileBuffer,
  type ExternalFileBuffer,
  type ExternalFileTab,
} from './externalEditorFile'

// Match EditorPanel: above this size the rendered preview is disabled and the
// file falls back to the Monaco source view so a huge document can't hang the
// markdown renderer.
const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

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
  const monacoTheme = useMonacoBaseTheme()
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Record<string, FileBuffer>>({})
  // Markdown files default to the rendered preview; the toggle drops to the
  // Monaco source view for editing, mirroring the in-app EditorPanel.
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
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
  const activeTextBuffer =
    activeBuffer && !activeBuffer.loading && activeBuffer.kind === 'text' ? activeBuffer : null
  const isMarkdown = activeTab ? detectLanguage(activeTab.name) === 'markdown' : false
  const markdownPreviewTooLarge =
    isMarkdown && !!activeTextBuffer && activeTextBuffer.value.length > MARKDOWN_PREVIEW_MAX_CHARS
  const showPreview = isMarkdown && !!activeTextBuffer && markdownMode === 'preview' && !markdownPreviewTooLarge

  // Land on the rendered preview each time a markdown file becomes active, so
  // opening one shows the formatted document rather than the last source view.
  useEffect(() => {
    if (isMarkdown) setMarkdownMode('preview')
  }, [activePath, isMarkdown])

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

  // Cmd/Ctrl+S saves the active file; Escape dismisses the window. Escape is
  // guarded by the same no-silent-discard rule the tab close affordance uses:
  // with unsaved edits in any tab it does nothing, so the file is saved or
  // docked first rather than lost to a single keypress.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveActive()
        return
      }
      if (event.key === 'Escape') {
        if (tabsRef.current.some((tab) => isDirty(buffersRef.current[tab.path]))) return
        event.preventDefault()
        void window.api.windowClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveActive])

  return (
    <div className="flex h-screen w-screen flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
      <div
        className={`app-drag flex ${TITLE_BAR_HEIGHT} shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] pr-2 ${
          isMac ? TRAFFIC_LIGHT_INSET : 'pl-2'
        }`}
      >
        <div className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const selected = tab.path === activePath
            return (
              <div
                key={tab.path}
                className={`app-no-drag group/tab flex h-[28px] min-w-0 shrink-0 items-center gap-1.5 self-center rounded-md px-2 text-meta transition-colors ${
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
          className="app-no-drag inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-micro text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Dock into workspace
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {isMarkdown && activeTextBuffer ? (
          <div className="absolute right-3 top-3 z-10">
            <Tooltip
              content={
                markdownPreviewTooLarge
                  ? 'Markdown preview disabled for large files'
                  : showPreview
                    ? 'Edit Markdown source'
                    : 'Preview Markdown'
              }
              placement="bottom"
            >
              <IconButton
                aria-label={showPreview ? 'Edit Markdown source' : 'Preview Markdown'}
                onClick={() => setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))}
                disabled={markdownPreviewTooLarge}
                className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]"
              >
                {showPreview ? (
                  <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
                    <path d="M2.5 11.75L2.5 13.5h1.75L12 5.75 10.25 4 2.5 11.75z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                    <path d="M9.25 5L11 6.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" className="icon-sm" fill="none" aria-hidden="true">
                    <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                    <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                )}
              </IconButton>
            </Tooltip>
          </div>
        ) : null}
        {renderBody(activeTab, activeBuffer, activePath, setBuffers, showPreview, monacoTheme)}
      </div>
    </div>
  )
}

function renderBody(
  activeTab: FileTab | null,
  buffer: FileBuffer | undefined,
  activePath: string | null,
  setBuffers: React.Dispatch<React.SetStateAction<Record<string, FileBuffer>>>,
  showPreview: boolean,
  monacoTheme: 'vs' | 'vs-dark'
): React.ReactNode {
  if (!activeTab || !activePath) {
    return (
      <div className="flex h-full items-center justify-center text-body font-mono text-[color:var(--text-disabled)]">
        No file open.
      </div>
    )
  }
  if (!buffer || buffer.loading) {
    return (
      <div className="flex h-full items-center justify-center text-body font-mono text-[color:var(--text-disabled)]">
        Loading…
      </div>
    )
  }
  if (buffer.error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-body font-mono text-[color:var(--tone-error)]">
        {buffer.error}
      </div>
    )
  }
  if (buffer.kind === 'image') {
    if (!buffer.dataUrl) {
      return (
        <div className="flex h-full items-center justify-center text-body font-mono text-[color:var(--text-disabled)]">
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
  if (showPreview) {
    return (
      <div className="h-full overflow-y-auto bg-[color:var(--bg-app)] px-8 pb-8 pt-14">
        <div className="mx-auto max-w-4xl">{renderMarkdown(buffer.value)}</div>
      </div>
    )
  }
  return (
    <MonacoEditor
      key={activePath}
      height="100%"
      theme={monacoTheme}
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
