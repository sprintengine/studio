// A source's badge: one or two letters in a hairline square. Sources have no
// icons of their own — a repository is not a brand — so the monogram is the
// mark that makes the rail scannable without inventing artwork for anybody.

import React from 'react'

export function SourceMonogram({
  monogram,
  size = 'sm',
}: {
  monogram: string
  size?: 'sm' | 'lg'
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] font-mono font-semibold text-[color:var(--text-muted)] ${
        size === 'lg' ? 'h-9 w-9 text-body' : 'h-[22px] w-[22px] text-meta'
      }`}
    >
      {monogram}
    </span>
  )
}
