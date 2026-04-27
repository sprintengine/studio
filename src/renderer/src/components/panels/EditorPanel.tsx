import React, { useEffect, useRef, useState } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getGitEntry, useGitStatus } from '../../hooks/useGitStatus'
import { getGitLineChanges, type GitLineChange } from '../../utils/gitDiff'
import { renderMarkdown } from '../../utils/markdown'

interface Props {
  workspaceId: string
  filePath?: string
}

type MonacoApi = Parameters<OnMount>[1]
const EDITOR_FOCUS_EVENT = 'multicode:focus-editor'

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
  const { repoRoot, status: gitStatus, refresh: refreshGitStatus } = useGitStatus(folderPath)

  const openFiles = editorState?.openFiles ?? []
  const activeFilePath = filePath ?? null
  const activeFile = openFiles.find((f) => f.path === activeFilePath)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<MonacoApi | null>(null)
  const gitDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  const [gitBaseContent, setGitBaseContent] = useState<{ path: string; content: string } | null>(null)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')
  const isMarkdown = activeFile?.language === 'markdown'
  const showPreview = isMarkdown && markdownMode === 'preview'

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
      await window.api.writefile(file.path, file.content)
      markFileClean(workspaceId, file.path)
      void refreshGitStatus()
    })
  }

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

    const command = await window.api.showContextMenu([
      { id: 'cut', label: 'Cut', enabled: hasSelection },
      { id: 'copy', label: 'Copy', enabled: hasSelection },
      { id: 'paste', label: 'Paste' },
      { type: 'separator' },
      { id: 'select-all', label: 'Select All' },
    ])

    if (command === 'cut') {
      editor.trigger('context-menu', 'editor.action.clipboardCutAction', null)
    } else if (command === 'copy') {
      editor.trigger('context-menu', 'editor.action.clipboardCopyAction', null)
    } else if (command === 'paste') {
      editor.trigger('context-menu', 'editor.action.clipboardPasteAction', null)
    } else if (command === 'select-all') {
      editor.trigger('context-menu', 'editor.action.selectAll', null)
    }
  }

  useEffect(() => {
    let cancelled = false

    if (!activeFilePath || !repoRoot) {
      setGitBaseContent(null)
      return
    }

    const loadBaseContent = async () => {
      const entry = getGitEntry(gitStatus, activeFilePath)
      if (entry?.status === 'new') {
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
  }, [activeFilePath, gitStatus?.updatedAt, gitStatus, repoRoot])

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
    const toDecoration = (change: GitLineChange): Monaco.editor.IModelDeltaDecoration => {
      const startLine = Math.min(Math.max(change.startLine, 1), lineCount)
      const endLine = Math.min(Math.max(change.endLine, startLine), lineCount)
      const className = change.kind === 'added'
        ? 'git-change-gutter git-change-added'
        : change.kind === 'modified'
          ? 'git-change-gutter git-change-modified'
          : 'git-change-gutter git-change-deleted'
      const color = change.kind === 'added'
        ? '#35d07f'
        : change.kind === 'modified'
          ? '#f0a340'
          : '#ff5a5f'
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

    decorations.set(getGitLineChanges(gitBaseContent.content, activeFile.content).map(toDecoration))
  }, [activeFile, gitBaseContent, showPreview])

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center bg-[#08090b] text-[#5a5a63] text-[13px] font-mono">
        Open a file from the Files pane
      </div>
    )
  }

  if (!activeFile) {
    return (
      <div className="h-full flex items-center justify-center bg-[#08090b] px-4 text-center text-[#5a5a63] text-[13px] font-mono">
        This file is no longer open.
      </div>
    )
  }

  const markdownModeToggle = isMarkdown ? (
    <button
      onClick={() => setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))}
      className="absolute right-3 top-3 z-10 h-6 rounded-md border border-[#303139] bg-[#111216]/95 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#9a9aa2] shadow-[0_8px_24px_rgba(0,0,0,0.32)] transition-colors hover:border-[#3a3b43] hover:bg-[#17181d] hover:text-[#ececee]"
      aria-label={showPreview ? 'Edit Markdown source' : 'Preview Markdown'}
      title={showPreview ? 'Edit Markdown source' : 'Preview Markdown'}
    >
      {showPreview ? 'Edit' : 'Preview'}
    </button>
  ) : null

  return (
    <div className="flex flex-col h-full bg-[#08090b]">
      <div className="relative flex-1 overflow-hidden">
        {markdownModeToggle}
        {showPreview ? (
          <div className="h-full overflow-y-auto bg-[#08090b] px-8 pb-8 pt-14">
            <div className="max-w-4xl mx-auto">
              {renderMarkdown(activeFile.content)}
            </div>
          </div>
        ) : (
          <div className="h-full" onContextMenu={(event) => void showEditorContextMenu(event)}>
            <MonacoEditor
              height="100%"
              language={activeFile.language}
              value={activeFile.content}
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
                  updateFileContent(workspaceId, activeFilePath, value)
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
