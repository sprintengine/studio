import React from 'react'

import { FOCUS_RING_CLASS } from '../../ui/tokens'
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
          <button
            key={kind}
            type="button"
            onClick={() => onPick(kind)}
            className={[
              'interactive flex min-h-control-md items-center gap-2.5 rounded-[7px] border border-[color:var(--border-default)]',
              'bg-[color:var(--bg-surface)] px-3 py-2.5 text-meta text-[color:var(--text-default)]',
              'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
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
          </button>
        ))}
      </div>
    </div>
  )
}
