import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Tooltip, TruncatedText } from '../../ui'
import { formatRelativeTime } from '../../../utils/time'
import type {
  DesignArtifactEntry,
  DesignArtifactIndex,
  DesignArtifactsStatus,
} from './designArtifacts'

type Props = {
  index: DesignArtifactIndex
  status: DesignArtifactsStatus
  /** Workspace-root-relative path of the selected artifact (`activeDesignArtifactPath`). */
  selectedPath: string | null
  /**
   * Fired when the user picks a file. The consumer persists
   * `entry.relativePath` into `activeDesignArtifactPath` (and, for HTML pages,
   * may mirror it into `activeMockupPath` for compatibility).
   */
  onSelect: (entry: DesignArtifactEntry) => void
}

function PaneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
      {children}
    </div>
  )
}

function CenteredState({
  title,
  body,
  tone = 'neutral',
}: {
  title: string
  body: ReactNode
  tone?: 'neutral' | 'warn'
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span
        className={`text-[12px] font-semibold ${
          tone === 'warn' ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-strong)]'
        }`}
      >
        {title}
      </span>
      <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">{body}</span>
    </div>
  )
}

// Show the path line only when it disambiguates — a nested file whose name
// alone doesn't say where it lives. Top-level entries (mockups/app.html,
// product/ui-direction.md) read fine from the group + name.
function isNestedArtifact(entry: DesignArtifactEntry): boolean {
  return entry.relativePath.split('/').length > 2
}

export function DesignFilesPane({ index, status, selectedPath, onSelect }: Props) {
  const entries = index.entries
  const selectedIndex = entries.findIndex((entry) => entry.relativePath === selectedPath)
  const [focusIndex, setFocusIndex] = useState(0)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])

  // Keep the roving focus index in range as files appear and disappear.
  useEffect(() => {
    setFocusIndex((current) => (entries.length === 0 ? 0 : Math.min(current, entries.length - 1)))
  }, [entries.length])

  const activeIndex = selectedIndex >= 0 ? selectedIndex : focusIndex
  const selectedMissing = Boolean(selectedPath) && selectedIndex < 0 && entries.length > 0

  const focusRow = (next: number) => {
    const clamped = Math.max(0, Math.min(entries.length - 1, next))
    setFocusIndex(clamped)
    rowRefs.current[clamped]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(activeIndex + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusRow(activeIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        focusRow(0)
        break
      case 'End':
        event.preventDefault()
        focusRow(entries.length - 1)
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const entry = entries[activeIndex]
        if (entry) onSelect(entry)
        break
      }
      default:
        break
    }
  }

  let flatIndex = -1

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
          Design files
        </span>
        <span className="truncate text-[12px] text-[color:var(--text-muted)]">
          {status === 'ready' && index.count > 0
            ? `${index.count} file${index.count === 1 ? '' : 's'} on disk`
            : 'Real files from the workspace'}
        </span>
      </header>

      <PaneFrame>
        {status === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
            Indexing design files…
          </div>
        ) : status === 'unavailable' ? (
          <CenteredState
            tone="warn"
            title="Files unavailable"
            body="The workspace folder could not be read. Reopen the workspace or check the folder still exists."
          />
        ) : index.count === 0 ? (
          <CenteredState
            title="No design files yet"
            body={
              <>
                The designer writes screens into{' '}
                <span className="font-mono text-[color:var(--text-default)]">mockups/</span> and notes
                into{' '}
                <span className="font-mono text-[color:var(--text-default)]">
                  product/ui-direction.md
                </span>
                .
              </>
            }
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {selectedMissing ? (
              <div className="shrink-0 border-b border-[color:var(--border-subtle)] px-3 py-2 text-[11px] leading-4 text-[color:var(--tone-warn)]">
                The selected file is no longer available.
              </div>
            ) : null}
            <div
              role="listbox"
              aria-label="Design files"
              onKeyDown={onKeyDown}
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {index.groups.map((group) => (
                <div key={group.id} role="group" aria-label={group.label} className="pb-1">
                  <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-[color:var(--text-muted)]">
                    {group.label}
                  </div>
                  {group.entries.map((entry) => {
                    flatIndex += 1
                    const rowIndex = flatIndex
                    const isSelected = entry.relativePath === selectedPath
                    const modifiedTime = formatRelativeTime(entry.modifiedAt)
                    const nested = isNestedArtifact(entry)
                    return (
                      <div
                        key={entry.relativePath}
                        ref={(element) => {
                          rowRefs.current[rowIndex] = element
                        }}
                        role="option"
                        aria-selected={isSelected}
                        tabIndex={rowIndex === activeIndex ? 0 : -1}
                        onClick={() => onSelect(entry)}
                        onFocus={() => setFocusIndex(rowIndex)}
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
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <TruncatedText
                            as="span"
                            text={entry.name}
                            className={`font-mono text-[12px] ${
                              isSelected
                                ? 'text-[color:var(--text-strong)]'
                                : 'text-[color:var(--text-default)]'
                            }`}
                          />
                          {nested ? (
                            <TruncatedText
                              as="span"
                              text={entry.relativePath}
                              className="font-mono text-[11px] text-[color:var(--text-subtle)]"
                            />
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-baseline gap-2">
                          <span className="text-[11px] text-[color:var(--text-muted)]">
                            {entry.typeLabel}
                          </span>
                          {modifiedTime ? (
                            <Tooltip content={entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}>
                              <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">
                                {modifiedTime}
                              </span>
                            </Tooltip>
                          ) : null}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </PaneFrame>
    </div>
  )
}
