import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getGitEntry, useGitStatus } from '../../hooks/useGitStatus'
import { getGitLineChanges, type GitLineChange } from '../../utils/gitDiff'
import { renderMarkdown } from '../../utils/markdown'
import { isImageFile } from '../../utils/files'
import {
  getEditorBuffer,
  hasEditorBuffer,
  setEditorBuffer,
  subscribeEditorBuffer,
} from '../../utils/editorBuffers'
import { removeFileTabsForPath } from '../../utils/modelRegistry'
import { IconButton, Tooltip } from '../ui'

interface Props {
  workspaceId: string
  filePath?: string
}

type MonacoApi = Parameters<OnMount>[1]
const EDITOR_FOCUS_EVENT = 'multicode:focus-editor'
const GIT_DECORATION_DEBOUNCE_MS = 200
const GIT_DECORATION_MAX_CHARS = 600_000
const GIT_DECORATION_MAX_LINES = 8_000

function readCssVar(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export default function EditorPanel({ workspaceId, filePath }: Props) {
  const editorState = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.editorState
  )
  const folderPath = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null
  )
  const setActiveFile     = useWorkspaceStore((s) => s.setActiveFile)
  const updateFileContent = useWorkspaceStore((s) => s.updateFileContent)
  const markFileClean     = useWorkspaceStore((s) => s.markFileClean)
  const closeFile         = useWorkspaceStore((s) => s.closeFile)
  const { repoRoot, status: gitStatus, refresh: refreshGitStatus } = useGitStatus(folderPath)

  const openFiles = editorState?.openFiles ?? []
  const activeFilePath = filePath ?? editorState?.activeFilePath ?? null
  const activeFile = openFiles.find((f) => f.path === activeFilePath)
  const isImage = Boolean(activeFilePath && activeFile && isImageFile(activeFile.path || activeFile.name))
  const activeFileHasRuntimeBuffer = activeFilePath
    ? hasEditorBuffer(workspaceId, activeFilePath)
    : false
  const activeFileContentReady = !activeFilePath
    || isImage
    || activeFileHasRuntimeBuffer
    || typeof activeFile?.content === 'string'
  const activeContent = useSyncExternalStore(
    (listener) => activeFilePath ? subscribeEditorBuffer(workspaceId, activeFilePath, listener) : () => {},
    () => activeFilePath ? getEditorBuffer(workspaceId, activeFilePath, activeFile?.content ?? '') : '',
    () => ''
  )
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const gitDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [gitBaseContent, setGitBaseContent] = useState<{ path: string; content: string } | null>(null)
  const [contentLoadError, setContentLoadError] = useState<{ path: string; message: string } | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<{ path: string; url: string } | null>(null)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
  const isMarkdown = activeFile?.language === 'markdown'
  const showPreview = isMarkdown && markdownMode === 'preview'
  const activeGitEntry = useMemo(
    () => getGitEntry(gitStatus, activeFilePath),
    [activeFilePath, gitStatus]
  )
  const activeGitEntrySignature = activeGitEntry
    ? [
      activeGitEntry.path,
      activeGitEntry.status,
      activeGitEntry.staged ? '1' : '0',
      activeGitEntry.unstaged ? '1' : '0',
    ].join('\u001f')
    : ''
  const previewGitLineChanges = useMemo(() => {
    if (!showPreview || !activeFile || gitBaseContent?.path !== activeFile.path) return []

    const lineCount = Math.max(activeContent.split(/\r\n|\r|\n/).length, 1)
    const baseLineCount = gitBaseContent.content.split(/\r\n|\r|\n/).length
    const tooLargeForDetailedDiff =
      activeContent.length > GIT_DECORATION_MAX_CHARS
      || gitBaseContent.content.length > GIT_DECORATION_MAX_CHARS
      || lineCount > GIT_DECORATION_MAX_LINES
      || baseLineCount > GIT_DECORATION_MAX_LINES

    return tooLargeForDetailedDiff
      ? []
      : getGitLineChanges(gitBaseContent.content, activeContent)
  }, [activeContent, activeFile?.path, gitBaseContent, showPreview])

  useEffect(() => {
    if (filePath) setActiveFile(workspaceId, filePath)
  }, [filePath, setActiveFile, workspaceId])

  useEffect(() => {
    if (activeFile?.language === 'markdown') {
      setMarkdownMode('preview')
    }
  }, [activeFilePath, activeFile?.language])

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    gitDecorationsRef.current = editor.createDecorationsCollection()
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      const state = useWorkspaceStore.getState()
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      const pathToSave = filePath ?? ws?.editorState?.activeFilePath
      const file = ws?.editorState?.openFiles.find((f) => f.path === pathToSave)
      if (!file) return
      if (isImageFile(file.path || file.name)) return
      if (!hasEditorBuffer(workspaceId, file.path) && typeof file.content !== 'string') return
      await window.api.writefile(file.path, getEditorBuffer(workspaceId, file.path, file.content ?? ''))
      markFileClean(workspaceId, file.path)
      void refreshGitStatus()
    })
  }

  useEffect(() => {
    if (!activeFilePath || !activeFile) {
      setContentLoadError(null)
      return
    }
    if (activeFileContentReady) {
      setContentLoadError((error) => error?.path === activeFilePath ? null : error)
      return
    }

    let cancelled = false
    setContentLoadError(null)

    const loadRestoredContent = async () => {
      try {
        const content = await window.api.readfile(activeFilePath)
        if (cancelled || hasEditorBuffer(workspaceId, activeFilePath)) return
        setEditorBuffer(workspaceId, activeFilePath, content)
      } catch (error) {
        if (cancelled) return
        setContentLoadError({
          path: activeFilePath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void loadRestoredContent()

    return () => {
      cancelled = true
    }
  }, [activeFile, activeFileContentReady, activeFilePath, workspaceId])

  useEffect(() => {
    if (!isImage || !activeFilePath) {
      setImageDataUrl(null)
      return
    }

    let cancelled = false
    setContentLoadError(null)
    setImageDataUrl((current) => current?.path === activeFilePath ? current : null)

    const loadImage = async () => {
      try {
        const url = await window.api.readImageDataUrl(activeFilePath)
        if (!cancelled) setImageDataUrl({ path: activeFilePath, url })
      } catch (error) {
        if (cancelled) return
        setContentLoadError({
          path: activeFilePath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void loadImage()

    return () => {
      cancelled = true
    }
  }, [activeFilePath, isImage])

  useEffect(() => {
    if (showPreview) return

    const handleFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail
      if (detail?.workspaceId !== workspaceId) return

      window.requestAnimationFrame(() => {
        editorRef.current?.focus()
      })
    }

    window.addEventListener(EDITOR_FOCUS_EVENT, handleFocusRequest)
    return () => window.removeEventListener(EDITOR_FOCUS_EVENT, handleFocusRequest)
  }, [showPreview, workspaceId])

  const showEditorContextMenu = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (showPreview || !editorRef.current) return

    event.preventDefault()
    const editor = editorRef.current
    const selection = editor.getSelection()
    const hasSelection = Boolean(selection && !selection.isEmpty())
    const canCloseOtherEditorTabs = Boolean(activeFilePath && openFiles.some((file) => file.path !== activeFilePath))

    const command = await window.api.showContextMenu([
      { id: 'cut', label: 'Cut', enabled: hasSelection },
      { id: 'copy', label: 'Copy', enabled: hasSelection },
      { id: 'paste', label: 'Paste' },
      { type: 'separator' },
      { id: 'select-all', label: 'Select All' },
      { type: 'separator' },
      { id: 'close-other-editor-tabs', label: 'Close Other Editor Tabs', enabled: canCloseOtherEditorTabs },
    ])

    if (command === 'cut') {
      editor.trigger('context-menu', 'editor.action.clipboardCutAction', null)
    } else if (command === 'copy') {
      editor.trigger('context-menu', 'editor.action.clipboardCopyAction', null)
    } else if (command === 'paste') {
      editor.trigger('context-menu', 'editor.action.clipboardPasteAction', null)
    } else if (command === 'select-all') {
      editor.trigger('context-menu', 'editor.action.selectAll', null)
    } else if (command === 'close-other-editor-tabs' && activeFilePath) {
      openFiles
        .filter((file) => file.path !== activeFilePath)
        .forEach((file) => {
          closeFile(workspaceId, file.path)
          removeFileTabsForPath(workspaceId, file.path)
        })
    }
  }

  useEffect(() => {
    let cancelled = false

    if (!activeFilePath || !repoRoot) {
      setGitBaseContent(null)
      return
    }

    const loadBaseContent = async () => {
      if (activeGitEntry?.status === 'new') {
        setGitBaseContent({ path: activeFilePath, content: '' })
        return
      }

      if (typeof window.api.getGitFileBase !== 'function') {
        setGitBaseContent(null)
        return
      }

      const result = await window.api.getGitFileBase(repoRoot, activeFilePath)
      if (cancelled) return

      setGitBaseContent(result.ok ? { path: activeFilePath, content: result.content } : null)
    }

    void loadBaseContent()

    return () => {
      cancelled = true
    }
  }, [activeFilePath, activeGitEntry?.status, activeGitEntrySignature, repoRoot])

  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const decorations = gitDecorationsRef.current
    const model = editor?.getModel()

    if (!editor || !monaco || !decorations || !model || !activeFile || gitBaseContent?.path !== activeFile.path || showPreview) {
      decorations?.clear()
      return
    }

    const lineCount = Math.max(model.getLineCount(), 1)
    const tooLargeForDetailedDiff =
      activeContent.length > GIT_DECORATION_MAX_CHARS
      || gitBaseContent.content.length > GIT_DECORATION_MAX_CHARS
      || lineCount > GIT_DECORATION_MAX_LINES

    if (tooLargeForDetailedDiff) {
      decorations.clear()
      return
    }

    const baseLineCount = gitBaseContent.content.split(/\r\n|\r|\n/).length
    if (baseLineCount > GIT_DECORATION_MAX_LINES) {
      decorations.clear()
      return
    }

    const toDecoration = (change: GitLineChange): Monaco.editor.IModelDeltaDecoration => {
      const startLine = Math.min(Math.max(change.startLine, 1), lineCount)
      const endLine = Math.min(Math.max(change.endLine, startLine), lineCount)
      const className = change.kind === 'added'
        ? 'git-change-gutter git-change-added'
        : change.kind === 'modified'
          ? 'git-change-gutter git-change-modified'
          : 'git-change-gutter git-change-deleted'
      const color = change.kind === 'added'
        ? readCssVar('--tone-good')
        : change.kind === 'modified'
          ? readCssVar('--tone-warn')
          : readCssVar('--tone-error')
      const label = change.kind === 'added'
        ? 'Added lines'
        : change.kind === 'modified'
          ? 'Modified lines'
          : `${change.deletedCount ?? 1} deleted line${change.deletedCount === 1 ? '' : 's'}`

      return {
        range: new monaco.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: className,
          glyphMarginHoverMessage: { value: label },
          overviewRuler: {
            color,
            position: monaco.editor.OverviewRulerLane.Left,
          },
          zIndex: 20,
        },
      }
    }

    const timer = window.setTimeout(() => {
      decorations.set(getGitLineChanges(gitBaseContent.content, activeContent).map(toDecoration))
    }, GIT_DECORATION_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [activeContent, activeFile?.path, gitBaseContent, showPreview])

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center bg-[color:var(--bg-app)] text-[color:var(--text-disabled)] text-[13px] font-mono">
        Open a file from the Files pane
      </div>
    )
  }

  if (!activeFile) {
    return (
      <div className="h-full flex items-center justify-center bg-[color:var(--bg-app)] px-4 text-center text-[color:var(--text-disabled)] text-[13px] font-mono">
        This file is no longer open.
      </div>
    )
  }

  if (contentLoadError?.path === activeFilePath) {
    return (
      <div className="h-full flex items-center justify-center bg-[color:var(--bg-app)] px-4 text-center text-[color:var(--tone-error)] text-[13px] font-mono">
        Failed to load file: {contentLoadError.message}
      </div>
    )
  }

  if (!activeFileContentReady) {
    return (
      <div className="h-full flex items-center justify-center bg-[color:var(--bg-app)] text-[color:var(--text-disabled)] text-[13px] font-mono">
        Loading file...
      </div>
    )
  }

  const markdownModeToggle = isMarkdown ? (
    <div className="absolute right-3 top-3 z-10">
      <Tooltip content={showPreview ? 'Edit Markdown source' : 'Preview Markdown'} placement="bottom">
        <IconButton
          aria-label={showPreview ? 'Edit Markdown source' : 'Preview Markdown'}
          onClick={() => setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))}
          className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]"
        >
          {showPreview ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
              <path d="M2.5 11.75L2.5 13.5h1.75L12 5.75 10.25 4 2.5 11.75z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M9.25 5L11 6.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
              <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          )}
        </IconButton>
      </Tooltip>
    </div>
  ) : null

  if (isImage && activeFilePath) {
    if (!imageDataUrl || imageDataUrl.path !== activeFilePath) {
      return (
        <div className="h-full flex items-center justify-center bg-[color:var(--bg-app)] text-[color:var(--text-disabled)] text-[13px] font-mono">
          Loading image...
        </div>
      )
    }

    return (
      <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img
            src={imageDataUrl.url}
            alt={activeFile.name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[color:var(--bg-app)]">
      <div className="relative flex-1 overflow-hidden">
        {markdownModeToggle}
        {showPreview ? (
          <div className="h-full overflow-y-auto bg-[color:var(--bg-app)] px-8 pb-8 pt-14">
            <div className="max-w-4xl mx-auto">
              {renderMarkdown(activeContent, { lineChanges: previewGitLineChanges })}
            </div>
          </div>
        ) : (
          <div className="h-full" onContextMenu={(event) => void showEditorContextMenu(event)}>
            <MonacoEditor
              height="100%"
              language={activeFile.language}
              value={activeContent}
              theme="vs-dark"
              options={{
                fontSize: 13,
                fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderLineHighlight: 'gutter',
                glyphMargin: true,
                lineNumbers: 'on',
                wordWrap: 'off',
                tabSize: 2,
                automaticLayout: true,
                contextmenu: false,
                padding: { top: isMarkdown ? 44 : 12 },
              }}
              onChange={(value) => {
                if (value !== undefined && activeFilePath) {
                  setEditorBuffer(workspaceId, activeFilePath, value)
                  if (!activeFile.isDirty) updateFileContent(workspaceId, activeFilePath, value)
                }
              }}
              onMount={handleMount}
            />
          </div>
        )}
      </div>
    </div>
  )
}
