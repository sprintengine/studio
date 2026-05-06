import React, { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddFileTab } from '../../utils/modelRegistry'
import { renderMarkdown } from '../../utils/markdown'

type Props = {
  workspaceId: string
  result: MemoryPreviewResult
  onClose: () => void
}

type EditablePreviewResult = Extract<
  MemoryPreviewResult,
  { ok: true; previewKind: 'markdown' | 'text' | 'image' }
>

function canOpenInEditor(result: MemoryPreviewResult): result is EditablePreviewResult {
  return result.ok && (
    result.previewKind === 'markdown'
    || result.previewKind === 'text'
    || result.previewKind === 'image'
  )
}

export default function MemoryPreviewModal({ workspaceId, result, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const openFile = useWorkspaceStore((s) => s.openFile)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onClose])

  const openInEditor = async () => {
    if (!canOpenInEditor(result)) return
    const content = result.previewKind === 'image'
      ? ''
      : result.content
    openFile(workspaceId, result.node.path, result.node.name, content)
    focusOrAddFileTab(workspaceId, result.node.path, result.node.name)
    onClose()
  }

  const title = result.ok ? result.node.name : 'Preview unavailable'
  const path = result.ok ? result.node.relativePath : null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/62 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-preview-title"
        tabIndex={-1}
        className="flex max-h-[86vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] shadow-[0_26px_90px_rgba(0,0,0,0.58)] outline-none"
      >
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[#1f2025] px-4">
          <div className="min-w-0">
            <div id="memory-preview-title" className="truncate text-sm font-semibold text-[#ececee]">
              {title}
            </div>
            {path ? (
              <div className="mt-0.5 truncate font-mono text-[11px] text-[#6f7078]">
                {path}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canOpenInEditor(result) ? (
              <button
                type="button"
                onClick={() => void openInEditor()}
                className="rounded-md border border-[#303139] bg-[#15161a] px-3 py-1.5 text-[12px] font-semibold text-[#d7d7dc] transition-colors hover:bg-[#1d1e24] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#6ee7d8]/45"
              >
                Open in editor
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[#8a8a92] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#6ee7d8]/45"
              aria-label="Close memory preview"
              title="Close"
            >
              x
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {!result.ok ? (
            <div className="border-l-2 border-[#ff787c] pl-3 text-[13px] leading-6 text-[#ffb3bf]">
              {result.message}
            </div>
          ) : result.previewKind === 'markdown' ? (
            <article className="mx-auto max-w-[760px]">
              {renderMarkdown(result.content)}
            </article>
          ) : result.previewKind === 'text' ? (
            <pre className="m-0 overflow-x-auto rounded-md border border-[#24252b] bg-[#08090b] p-4 font-mono text-[12px] leading-5 text-[#d7d7dc]">
              {result.content}
            </pre>
          ) : result.previewKind === 'image' ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <img
                src={result.dataUrl}
                alt={result.node.name}
                className="max-h-[68vh] max-w-full object-contain"
                draggable={false}
              />
            </div>
          ) : result.previewKind === 'unsupported' ? (
            <div className="space-y-3 text-[13px] leading-6 text-[#9a9aa2]">
              <div className="text-[#d7d7dc]">{result.message}</div>
              <div className="grid max-w-lg grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 font-mono text-[12px]">
                <span className="text-[#5a5a63]">Path</span>
                <span className="truncate text-[#d7d7dc]">{result.node.relativePath}</span>
                <span className="text-[#5a5a63]">Type</span>
                <span className="text-[#d7d7dc]">{result.node.extension || 'none'}</span>
                <span className="text-[#5a5a63]">Size</span>
                <span className="text-[#d7d7dc]">{result.node.sizeBytes.toLocaleString()} bytes</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
