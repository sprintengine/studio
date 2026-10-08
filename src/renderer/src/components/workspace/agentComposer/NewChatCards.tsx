import { CardButton } from '../../ui'
import type { ExtensionIdea } from './extensionIdeas'
import type { SuggestionEntry } from './suggestionBank'

// The tiles under New chat's box: a suggested task that starts at a press, and
// an idea that fills the box in extension mode.

export function SuggestionCard({
  entry,
  disabled,
  onLaunch,
}: {
  entry: SuggestionEntry
  disabled: boolean
  onLaunch: () => void
}) {
  return (
    // The kit's tile: a block button whose content is a composition rather than
    // a label. `bordered` keeps the hairline at rest, so hover moves the ground
    // and nothing else — a grid that reflows under the pointer is the defect
    // the tile spec rules out. The inset stays with the caller, because a
    // tile's padding is a composition decision — and so does the radius:
    // `radius.composer-companion`, so the tiles read as one set with the
    // composer above them rather than as ramp cards parked beside it.
    <CardButton
      variant="bordered"
      onClick={onLaunch}
      disabled={disabled}
      className="rounded-[var(--sem-radius-composer-companion)] px-3 py-2.5"
    >
      <div className="text-body font-medium text-[color:var(--text-strong)]">{entry.title}</div>
      <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{entry.description}</p>
      <span className="mt-1.5 inline-block self-start rounded border border-[color:var(--border-default)] px-1.5 text-micro text-[color:var(--text-subtle)]">
        {entry.outcome}
      </span>
    </CardButton>
  )
}

export function ExtensionIdeaCard({ idea, onPick }: { idea: ExtensionIdea; onPick: () => void }) {
  return (
    // The suggestion tile's shape; the surface it adds leads, because the cards
    // together are a map of what an extension can be.
    <CardButton
      variant="bordered"
      onClick={onPick}
      className="rounded-[var(--sem-radius-composer-companion)] px-3 py-2.5"
    >
      <span className="text-micro text-[color:var(--text-subtle)]">{idea.surface}</span>
      <div className="mt-0.5 text-body font-medium text-[color:var(--text-strong)]">{idea.title}</div>
      <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">{idea.description}</p>
    </CardButton>
  )
}
