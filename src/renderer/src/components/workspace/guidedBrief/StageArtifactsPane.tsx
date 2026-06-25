import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { TruncatedText } from '../../ui'
import type { DesignArtifactEntry } from './designArtifacts'

// Per-file lifecycle for a text stage's expected artifacts. Truthful only:
// `missing` when the file doesn't exist or is empty, `in-progress` once real
// content is on disk while the stage is still working, `ready` when the
// stage's readiness contract is met.
export type StageArtifactState = 'missing' | 'in-progress' | 'ready'

export type StageArtifactFile = {
  entry: DesignArtifactEntry
  state: StageArtifactState
}

const STATE_LABEL: Record<StageArtifactState, string> = {
  missing: 'Not written yet',
  'in-progress': 'In progress',
  ready: 'Ready for review',
}

/**
 * The artifact index for strategist/architect stages: the small, fixed set of
 * files the specialist is expected to write, each with a truthful state.
 * Mirrors DesignFilesPane's frame, row treatment, and roving-focus listbox so
 * the studio shell reads as one system across all stages.
 */
export function StageArtifactsPane({
  files,
  selectedPath,
  onSelect,
}: {
  files: StageArtifactFile[]
  selectedPath: string | null
  onSelect: (entry: DesignArtifactEntry) => void
}) {
  const [focusIndex, setFocusIndex] = useState(0)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const selectedIndex = files.findIndex((file) => file.entry.relativePath === selectedPath)
  const activeIndex = selectedIndex >= 0 ? selectedIndex : focusIndex

  useEffect(() => {
    setFocusIndex((current) => (files.length === 0 ? 0 : Math.min(current, files.length - 1)))
  }, [files.length])

  const focusRow = (next: number) => {
    const clamped = Math.max(0, Math.min(files.length - 1, next))
    setFocusIndex(clamped)
    rowRefs.current[clamped]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (files.length === 0) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(activeIndex + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusRow(activeIndex - 1)
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const file = files[activeIndex]
        if (file) onSelect(file.entry)
        break
      }
      default:
        break
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
          Artifacts
        </span>
        <span className="truncate text-[12px] text-[color:var(--text-muted)]">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <div
          role="listbox"
          aria-label="Stage artifacts"
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {files.map((file, index) => {
            const isSelected = file.entry.relativePath === selectedPath
            return (
              <div
                key={file.entry.relativePath}
                ref={(element) => {
                  rowRefs.current[index] = element
                }}
                role="option"
                aria-selected={isSelected}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => onSelect(file.entry)}
                onFocus={() => setFocusIndex(index)}
                className={`
                  flex min-h-[32px] cursor-pointer items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-3 outline-none
                  transition-colors
                  focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--accent-primary)]
                  ${
                    isSelected
                      ? 'border-[color:var(--accent-primary)] bg-[color:var(--bg-selected)]'
                      : 'border-transparent hover:bg-[color:var(--bg-surface-raised)]'
                  }
                `}
              >
                <TruncatedText
                  as="span"
                  text={file.entry.name}
                  className={`min-w-0 flex-1 font-mono text-[12px] ${
                    isSelected
                      ? 'text-[color:var(--text-strong)]'
                      : 'text-[color:var(--text-default)]'
                  }`}
                />
                <span
                  className={`shrink-0 text-[11px] ${
                    file.state === 'missing'
                      ? 'text-[color:var(--text-subtle)]'
                      : 'text-[color:var(--text-muted)]'
                  }`}
                >
                  {STATE_LABEL[file.state]}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
