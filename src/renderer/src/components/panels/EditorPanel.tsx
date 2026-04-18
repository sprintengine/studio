import React, { useCallback, useRef } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useWorkspaceStore } from '../../store/workspaceStore'

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
  const appendStream      = useWorkspaceStore((s) => s.appendStream)

  const openFiles = editorState?.openFiles ?? []
  const activeFilePath = editorState?.activeFilePath ?? null
  const activeFile = openFiles.find((f) => f.path === activeFilePath)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.addCommand(2097 /* KeyMod.CtrlCmd | KeyCode.KeyS */, async () => {
      const state = useWorkspaceStore.getState()
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      const file = ws?.editorState?.openFiles.find((f) => f.path === ws.editorState.activeFilePath)
      if (!file) return
      await window.api.writefile(file.path, file.content)
      markFileClean(workspaceId, file.path)
    })
  }

  const handleSendToAgent = useCallback(() => {
    if (!editorRef.current) return
    const selection = editorRef.current.getModel()?.getValueInRange(
      editorRef.current.getSelection()!
    )
    if (!selection?.trim()) return
    appendStream(workspaceId, 'agent-1', `\`\`\`\n${selection}\n\`\`\``)
  }, [workspaceId, appendStream])

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0f1012] text-zinc-600 text-[13px] font-mono">
        Open a file from the Files pane
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#0f1012]">
      {/* File tabs */}
      <div className="flex items-center gap-0 h-9 border-b border-[#23262d] overflow-x-auto shrink-0 bg-[#15171b]">
        {openFiles.map((f) => {
          const active = f.path === activeFilePath
          return (
            <div
              key={f.path}
              onClick={() => setActiveFile(workspaceId, f.path)}
              className={`group inline-flex items-center gap-2 h-9 px-3 text-[12px] cursor-pointer whitespace-nowrap border-r border-[#23262d] transition-colors ${
                active
                  ? 'bg-[#0f1012] text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-[#17191d]'
              }`}
            >
              <span className="font-mono">{f.name}{f.isDirty ? ' •' : ''}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeFile(workspaceId, f.path) }}
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-300 leading-none"
                aria-label={`Close ${f.name}`}
              >
                ×
              </button>
            </div>
          )
        })}

        <button
          onClick={handleSendToAgent}
          className="ml-auto mr-2 h-7 px-2.5 rounded-md text-[10px] uppercase tracking-[0.08em] text-zinc-500 hover:text-[#a9c8ff] hover:bg-[#17191d] transition-colors shrink-0"
          title="Send selection to first agent"
        >
          → agent
        </button>
      </div>

      {activeFile && (
        <div className="flex-1 overflow-hidden">
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
  )
}
