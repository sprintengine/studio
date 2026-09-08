import React from 'react'

import { CardButton } from '../../ui/CardButton'
import type { PaneKindDefinition, PaneLaunchKind } from './paneKinds'

// The pane with no tabs: one compact card per kind, and nothing else. The cards
// are the explanation (principles: the UI does not explain the UI). The same
// letters that work in the "+" menu open kinds here while a card has focus.

type WorkspacePaneLauncherProps = {
  kinds: readonly PaneKindDefinition[]
  onPick: (kind: PaneLaunchKind) => void
}

export function WorkspacePaneLauncher({ kinds, onPick }: WorkspacePaneLauncherProps) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
    const letter = event.key.toUpperCase()
    const match = kinds.find((definition) => definition.letter === letter)
    if (!match) return
    event.preventDefault()
    onPick(match.kind)
  }

  return (
    <div
      className="flex h-full items-center justify-center p-6"
      onKeyDown={onKeyDown}
    >
      <div
        role="group"
        aria-label="Open in the pane"
        className="grid w-full max-w-[320px] grid-cols-2 gap-2"
      >
        {kinds.map(({ kind, label, letter, Glyph }) => (
          // The kit's tile. `bordered` keeps the hairline at rest, so hover
          // moves the ground and nothing else — a grid of doors that reflowed
          // under the pointer is the defect the tile spec rules out by name. A
          // tile is a column, so its one row of content is a row inside it.
          <CardButton
            key={kind}
            variant="bordered"
            onClick={() => onPick(kind)}
            className="min-h-control-md px-3 py-2.5 text-meta text-[color:var(--text-default)]"
          >
            <span className="flex flex-1 items-center gap-2.5">
              {/* icon.size.lg, the step whose token documentation names empty-state
                  glyphs as its use — this launcher IS the pane's empty state, and a
                  toolbar-sized mark on it read as a row of settings rather than as
                  six doors. The card is padded rather than height-clamped so the
                  bigger glyph gets its air instead of touching the border. */}
              <Glyph className="icon-lg shrink-0 text-[color:var(--text-subtle)]" />
              <span className="flex-1 text-left">{label}</span>
              <span aria-hidden="true" className="font-mono text-micro text-[color:var(--text-disabled)]">
                {letter}
              </span>
            </span>
          </CardButton>
        ))}
      </div>
    </div>
  )
}
