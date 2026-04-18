import React, { useCallback, useRef } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useEditorStore } from '../../store/editorStore'
import { useWorkspaceStore } from '../../store/workspaceStore'

// Optional: workspaceId lets "Send to Agent" target the right workspace
interface Props {
  workspaceId?: string
}

export default function EditorPanel({ workspaceId }: Props) {
  const { openFiles, activeFilePath, setActiveFile, closeFile, updateContent } = useEditorStore()
  const appendStream = useWorkspaceStore((s) => s.appendStream)
  const activeFile = openFiles.find((f) => f.path === activeFilePath)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor

    // Ctrl+S → mark file clean (save in-memory; real write requires IPC)
    editor.addCommand(2097 /* KeyMod.CtrlCmd | KeyCode.KeyS */, async () => {
      const store = useEditorStore.getState()
      const file = store.openFiles.find((f) => f.path === store.activeFilePath)
      if (!file) return
      await window.api.writefile(file.path, file.content)
      store.markClean(file.path)
    })
  }

  const handleSendToAgent = useCallback(() => {
    if (!editorRef.current || !workspaceId) return
    const selection = editorRef.current.getModel()?.getValueInRange(
      editorRef.current.getSelection()!
    )
    if (!selection?.trim()) return
    // Send to agent-1 by default; a future command palette can let the user pick
    appendStream(workspaceId, 'agent-1', `\`\`\`\n${selection}\n\`\`\``)
  }, [workspaceId, appendStream])

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-zinc-950 text-zinc-600 text-sm">
        Open a file from the Explorer
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* File tabs */}
      <div className="flex items-center gap-0 border-b border-zinc-800 overflow-x-auto shrink-0 bg-zinc-900">
        {openFiles.map((f) => (
          <div
            key={f.path}
            onClick={() => setActiveFile(f.path)}
            className={`group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap border-r border-zinc-800 transition-colors ${
              f.path === activeFilePath
                ? 'bg-zinc-950 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            <span>{f.name}{f.isDirty ? ' •' : ''}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeFile(f.path) }}
              className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-300 leading-none"
            >
              ×
            </button>
          </div>
        ))}

        {workspaceId && (
          <button
            onClick={handleSendToAgent}
            className="ml-auto mr-2 px-2 py-1 rounded text-[10px] text-zinc-600 hover:text-indigo-400 hover:bg-zinc-800 transition-colors shrink-0"
            title="Send selection to Agent 1"
          >
            → Agent
          </button>
        )}
      </div>

      {/* Monaco */}
      {activeFile && (
        <div className="flex-1 overflow-hidden">
          <MonacoEditor
            height="100%"
            language={activeFile.language}
            value={activeFile.content}
            theme="vs-dark"
            options={{
              fontSize: 13,
              fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'gutter',
              lineNumbers: 'on',
              wordWrap: 'off',
              tabSize: 2,
              automaticLayout: true,
            }}
            onChange={(value) => {
              if (value !== undefined && activeFilePath) {
                updateContent(activeFilePath, value)
              }
            }}
            onMount={handleMount}
          />
        </div>
      )}
    </div>
  )
}
