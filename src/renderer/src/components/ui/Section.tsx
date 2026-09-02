import React, { useId } from 'react'

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
  /**
   * Where the section's padding comes from.
   *
   *  - `true` (default) — the section pads its own body.
   *  - `false` — the body brings its own padding. The header keeps the standard
   *    12px inset, because a body that pads itself almost always pads itself to
   *    the same 12px (a list of `InboxRow`s does), and the heading has to line
   *    up with the rows under it.
   *  - `'flush'` — neither. For a body whose rows run to the container's own
   *    edge, where the header's inset is what puts the heading 12px out of line
   *    with everything it names.
   */
  inset?: boolean | 'flush'
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
  // A `<section>` is a region landmark only once it has a name; without
  // `aria-labelledby` the heading sits inside an anonymous landmark and a
  // reader's regions list shows "region, region, region". The heading always
  // gets an id, so the landmark is always named when there is a title.
  const fallbackHeadingId = useId()
  const resolvedHeadingId = title ? (headingId ?? fallbackHeadingId) : headingId
  return (
    <section
      aria-labelledby={title ? resolvedHeadingId : undefined}
      className={`flex flex-col ${className ?? ''}`}
    >
      {title ? (
        <div
          className={`flex items-baseline justify-between gap-2 pt-3 pb-1.5 ${
            inset === 'flush' ? '' : 'px-3'
          }`}
        >
          <div className="flex items-baseline gap-1.5 min-w-0">
            <Heading
              id={resolvedHeadingId}
              className="truncate text-meta font-semibold text-[color:var(--text-strong)]"
            >
              {title}
            </Heading>
            {count !== undefined ? (
              <span className="tabular-nums text-meta text-[color:var(--text-muted)]">
                {count}
              </span>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={inset === true ? 'px-3 pb-3' : ''}>{children}</div>
    </section>
  )
}
