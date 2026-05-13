import React from 'react'

export type DefinitionItem = {
  /** Sentence case term. */
  term: React.ReactNode
  description: React.ReactNode
  /** Optional id for screen-reader / aria-describedby reference. */
  id?: string
}

type DefinitionListProps = {
  items: DefinitionItem[]
  /** Two-column variant for wide inspector layouts; otherwise stack. */
  layout?: 'stack' | 'two-column'
  className?: string
}

export function DefinitionList({ items, layout = 'two-column', className }: DefinitionListProps) {
  if (layout === 'stack') {
    return (
      <dl className={`flex flex-col gap-2 ${className ?? ''}`}>
        {items.map((item, index) => (
          <div key={item.id ?? index} className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-[color:var(--text-muted)]">{item.term}</dt>
            <dd
              id={item.id}
              className="text-[12px] text-[color:var(--text-strong)] leading-[1.4]"
            >
              {item.description}
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  return (
    <dl
      className={`grid gap-x-3 gap-y-1.5 ${className ?? ''}`}
      style={{ gridTemplateColumns: 'max-content 1fr' }}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id ?? index}>
          <dt className="text-[11px] text-[color:var(--text-muted)] leading-[1.4]">{item.term}</dt>
          <dd
            id={item.id}
            className="text-[12px] text-[color:var(--text-strong)] leading-[1.4] min-w-0"
          >
            {item.description}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}
