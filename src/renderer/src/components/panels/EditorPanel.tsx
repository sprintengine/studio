import React, { useEffect, useRef, useState } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { renderMarkdown } from '../../utils/markdown'

interface Props {
  workspaceId: string
}

export default function EditorPanel({ workspaceId }: Props) {
  const editorState = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.editorState
  )
  const setActiveFile     = useWorkspaceStore((s) => s.setActiveFile)
  const closeFile         = useWorkspaceStore((s) => s.closeFile)
  const updateFileContent = useWorkspaceStore((s) => s.updateFileContent)
  const markFileClean     = useWorkspaceStore((s) => s.markFileClean)

  const openFiles = editorState?.openFiles ?? []
  const activeFilePath = editorState?.activeFilePath ?? null
  const activeFile = openFiles.find((f) => f.path === activeFilePath)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')

  useEffect(() => {
    if (activeFile?.language === 'markdown') {
      setMarkdownMode('preview')
    }
  }, [activeFilePath, activeFile?.language])

  const cycleOpenFiles = (step: 1 | -1) => {
    const state = useWorkspaceStore.getState()
    const workspace = state.workspaces.find((w) => w.id === workspaceId)
    const files = workspace?.editorState?.openFiles ?? []
    const currentPath = workspace?.editorState?.activeFilePath ?? null
    if (files.length < 2 || !currentPath) return

    const currentIndex = files.findIndex((file) => file.path === currentPath)
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + step + files.length) % files.length

    state.setActiveFile(workspaceId, files[nextIndex].path)
  }

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      const state = useWorkspaceStore.getState()
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      const file = ws?.editorState?.openFiles.find((f) => f.path === ws.editorState.activeFilePath)
      if (!file) return
      await window.api.writefile(file.path, file.content)
      markFileClean(workspaceId, file.path)
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab, () => cycleOpenFiles(1))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => cycleOpenFiles(-1))
  }

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

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#08090b] text-[#5a5a63] text-[13px] font-mono">
        Open a file from the Files pane
      </div>
    )
  }

  const isMarkdown = activeFile?.language === 'markdown'
  const showPreview = isMarkdown && markdownMode === 'preview'

  return (
    <div className="flex flex-col h-full bg-[#08090b]">
      <div className="flex items-center gap-0 h-9 border-b border-[#1f2025] overflow-x-auto shrink-0 bg-[#111216]">
        {openFiles.map((f) => {
          const active = f.path === activeFilePath
          return (
            <div
              key={f.path}
              onClick={() => setActiveFile(workspaceId, f.path)}
              className={`group inline-flex items-center gap-2 h-9 px-3 text-[12px] cursor-pointer whitespace-nowrap border-r border-[#1f2025] transition-colors ${
                active
                  ? 'bg-[#08090b] text-[#ececee]'
                  : 'text-[#5a5a63] hover:text-[#d7d7dc] hover:bg-[#17181d]'
              }`}
            >
              <span className="font-mono">{f.name}{f.isDirty ? ' •' : ''}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeFile(workspaceId, f.path) }}
                className="opacity-0 group-hover:opacity-100 text-[#5a5a63] hover:text-[#d7d7dc] leading-none"
                aria-label={`Close ${f.name}`}
              >
                ×
              </button>
            </div>
          )
        })}

        <div className="ml-auto mr-2 flex items-center gap-1.5 shrink-0">
          {isMarkdown && (
            <button
              onClick={() => setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))}
              className="h-7 px-2.5 rounded-md text-[10px] uppercase tracking-[0.08em] text-[#5a5a63] hover:text-[#d7d7dc] hover:bg-[#17181d] transition-colors"
            >
              {showPreview ? 'Edit' : 'Preview'}
            </button>
          )}
        </div>
      </div>

      {activeFile && (
        <div className="flex-1 overflow-hidden">
          {showPreview ? (
            <div className="h-full overflow-y-auto px-8 py-8 bg-[#08090b]">
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
                  lineNumbers: 'on',
                  wordWrap: 'off',
                  tabSize: 2,
                  automaticLayout: true,
                  contextmenu: false,
                  padding: { top: 12 },
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
      )}
    </div>
  )
}
