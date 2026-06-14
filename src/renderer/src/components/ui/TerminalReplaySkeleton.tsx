import React from 'react'
import { Skeleton } from './Skeleton'

/**
 * Terminal-shaped placeholder shown while retained scrollback is being
 * restored on a cold workspace switch. It mimics dense monospace output —
 * short prompt-sized blocks followed by varied line widths — on the terminal
 * ground so the reveal of real content is visually continuous.
 *
 * The skeleton is decorative (`aria-hidden`); the terminal element underneath
 * remains the focus/interaction target. A single concise `role="status"` label
 * announces the restore for screen readers instead of repeating per row.
 * Shimmer respects reduced-motion automatically through `.skeleton-shimmer`.
 */

// Prompt-block width + a sequence of line-fragment widths per row. Widths are
// fixed (not random) so the placeholder is stable across re-renders.
const REPLAY_SKELETON_ROWS: ReadonlyArray<{ prompt: string; lines: string[] }> = [
  { prompt: 'w-8', lines: ['w-[38%]'] },
  { prompt: 'w-6', lines: ['w-[22%]', 'w-[31%]'] },
  { prompt: 'w-10', lines: ['w-[64%]'] },
  { prompt: 'w-5', lines: ['w-[18%]', 'w-[44%]'] },
  { prompt: 'w-8', lines: ['w-[52%]'] },
  { prompt: 'w-6', lines: ['w-[27%]', 'w-[24%]'] },
  { prompt: 'w-9', lines: ['w-[71%]'] },
  { prompt: 'w-5', lines: ['w-[33%]'] },
  { prompt: 'w-8', lines: ['w-[48%]', 'w-[19%]'] },
  { prompt: 'w-7', lines: ['w-[58%]'] },
  { prompt: 'w-6', lines: ['w-[29%]'] },
  { prompt: 'w-10', lines: ['w-[42%]', 'w-[26%]'] },
]

export function TerminalReplaySkeleton() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden bg-[color:var(--terminal-bg,var(--bg-app))] p-2 pb-4">
      <span role="status" className="sr-only">
        Restoring terminal history…
      </span>
      <div aria-hidden="true" className="flex flex-col gap-[7px]">
        {REPLAY_SKELETON_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="flex items-center gap-2">
            <Skeleton className={`h-[10px] ${row.prompt} rounded-sm bg-[color:var(--skeleton-shimmer-high)]`} />
            {row.lines.map((line, lineIndex) => (
              <Skeleton
                key={lineIndex}
                className={`h-[10px] ${line} rounded-sm bg-[color:var(--skeleton-shimmer-high)]`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
