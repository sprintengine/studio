import { Fragment, useRef } from 'react'
import type { CreationMode, ModeCardModel } from './types'
import { CREATION_RAIL_GROUP_BREAK_INDEX } from './modeModels'

// The creation hub's left rail: what you can create, one row per type, in the
// Settings-overlay rail idiom (vertical tablist, roving focus, quiet rows with
// an accent-soft active fill). Selecting a row swaps the hub's config pane —
// it never creates anything by itself.
export function CreationRail({
  models,
  mode,
  onSelect,
}: {
  models: ModeCardModel[]
  mode: CreationMode
  onSelect: (mode: CreationMode) => void
}) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keyToIndex: Record<string, number> = {
      ArrowDown: (index + 1) % models.length,
      ArrowRight: (index + 1) % models.length,
      ArrowUp: (index - 1 + models.length) % models.length,
      ArrowLeft: (index - 1 + models.length) % models.length,
      Home: 0,
      End: models.length - 1,
    }
    const nextIndex = keyToIndex[event.key]
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = models[nextIndex]
    onSelect(next.id)
    window.requestAnimationFrame(() => tabRefs.current[next.id]?.focus())
  }

  return (
    <nav
      aria-label="What to create"
      className="w-[188px] shrink-0 overflow-y-auto border-r border-[color:var(--border-subtle)] px-2 py-3"
    >
      <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5">
        {models.map((model, index) => {
          const active = mode === model.id
          const Icon = model.icon
          return (
            <Fragment key={model.id}>
              {index === CREATION_RAIL_GROUP_BREAK_INDEX ? (
                <div aria-hidden="true" className="h-3 shrink-0" />
              ) : null}
              <button
                ref={(node) => {
                  tabRefs.current[model.id] = node
                }}
                type="button"
                role="tab"
                id={`creation-tab-${model.id}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(model.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                className={`interactive flex w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left text-body leading-5 focus-visible:focus-ring ${
                  active
                    ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    active ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-subtle)]'
                  }`}
                />
                <span className="min-w-0 truncate">{model.label}</span>
              </button>
            </Fragment>
          )
        })}
      </div>
    </nav>
  )
}
