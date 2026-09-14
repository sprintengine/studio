import React from 'react'

/**
 * Terminal-shaped placeholder shown while retained scrollback is being
 * restored on a cold workspace switch. It mimics dense monospace output —
 * short prompt-sized blocks followed by varied line widths — on the terminal
 * ground so the reveal of real content is visually continuous.
 *
 * Intentionally static (no shimmer): a cold workspace switch can mount several
 * terminals at once, and an animation per block adds compositor cost at the
 * exact moment the mount is busiest. The quiet ghost-lines read as "content is
 * coming" without that cost.
 *
 * The skeleton is decorative (`aria-hidden`); the terminal element underneath
 * remains the focus/interaction target. A single concise `role="status"` label
 * announces the restore for screen readers instead of repeating per row.
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

function GhostLine({ widthClass }: { widthClass: string }) {
  return (
    <div className={`h-[10px] ${widthClass} rounded-sm bg-[color:var(--skeleton-shimmer-high)]`} />
  )
}

export function TerminalReplaySkeleton() {
  return (
    // The sticky layer (10): xterm's own helper layers are numbered inside the
    // terminal box and `.xterm` opens no stacking context, so the placeholder
    // has to name a layer to stay over them rather than rely on tree order.
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden bg-[color:var(--terminal-bg,var(--bg-app))] p-2">
      <span role="status" className="sr-only">
        Restoring terminal history…
      </span>
      <div aria-hidden="true" className="flex flex-col gap-2">
        {REPLAY_SKELETON_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="flex items-center gap-2">
            <GhostLine widthClass={row.prompt} />
            {row.lines.map((line, lineIndex) => (
              <GhostLine key={lineIndex} widthClass={line} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
