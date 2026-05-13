import React from 'react'

type SectionProps = {
  /** Sentence case. The heading is rendered as a normal weighted label, not
   *  uppercase tracking chrome. */
  title?: string
  /** Optional canonical count rendered next to the title. */
  count?: number | string
  /** Optional trailing controls. Keep to one item. */
  action?: React.ReactNode
  headingId?: string
  /** Render the heading as a different level for nested sections. */
  level?: 2 | 3 | 4
  /** Removes default padding when the content brings its own. */
  inset?: boolean
  className?: string
  children: React.ReactNode
}

export function Section({
  title,
  count,
  action,
  headingId,
  level = 3,
  inset = true,
  className,
  children,
}: SectionProps) {
  const Heading: keyof React.JSX.IntrinsicElements = (`h${level}` as keyof React.JSX.IntrinsicElements)
  return (
    <section className={`flex flex-col ${className ?? ''}`}>
      {title ? (
        <div className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-1.5">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <Heading
              id={headingId}
              className="truncate text-[12px] font-semibold text-[color:var(--text-strong)]"
            >
              {title}
            </Heading>
            {count !== undefined ? (
              <span className="tabular-nums text-[12px] text-[color:var(--text-muted)]">
                {count}
              </span>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={inset ? 'px-3 pb-3' : ''}>{children}</div>
    </section>
  )
}
