// The quiet "Default" mark a picker row wears when its option is the catalog's
// (or the CLI's) own default — a fact about the option, not a status, so it is
// a neutral bordered micro chip and never a tone. One drawing, shared by the
// reasoning selector and the permission-preset menu (remote-sessions-ux /
// selector-menus-premium), so the two menus cannot disagree about what
// "default" looks like. `rounded-xs` is `radius.chip`, the token step the
// selector used to spell by hand as `rounded-[3px]`.
//
// Hookless and barrel-free on purpose: `agentSpawnShared` imports it directly
// and must stay clear of the kit's whole component graph.
import type { ReactNode } from 'react'

const MICRO_CHIP_TONES = {
  // A fact about the option: hairline, subtle ink.
  neutral: 'border-[color:var(--border-default)] text-[color:var(--text-subtle)]',
} as const

/** The one micro chip: `radius.chip`, hairline, micro type. Every bordered micro mark renders through it. */
function MicroChip({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: keyof typeof MICRO_CHIP_TONES
  className?: string
  children: ReactNode
}) {
  return (
    <span className={`shrink-0 rounded-xs border px-1 text-micro ${MICRO_CHIP_TONES[tone]} ${className ?? ''}`}>
      {children}
    </span>
  )
}

export function DefaultChip({ className }: { className?: string }) {
  return <MicroChip className={className}>Default</MicroChip>
}
