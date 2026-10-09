import React from 'react'

import { TERMINAL_CHROME_ATTRIBUTE } from '../../utils/keyboard'
import { ChevronDownIcon } from '../AppIcons'
import { FloatingButton } from '../ui'

/**
 * "Jump to latest", floated over the bottom-right of a terminal while its
 * viewport is scrolled up away from the newest output.
 *
 * The same control the conversation shows over its transcript, and the same
 * primitive: a solid pill, because a see-through one over moving terminal text
 * lets the text run through its label. Shown and hidden by the pane from the
 * factory's `onScrolledAwayChange`, which also keeps it off the alternate
 * screen, where a full-screen program draws its own interface.
 */
export function TerminalJumpToLatest({ visible, onJump }: { visible: boolean; onJump: () => void }) {
  if (!visible) return null
  return (
    <div
      // In-canvas floating chrome, like the find bar: above the drag-target
      // overlay the panes draw, and clear of xterm's scrollbar on the right.
      className="absolute bottom-3 right-5 z-[var(--z-float)]"
      // The pane's NATIVE mousedown/contextmenu/copy/paste listeners would
      // otherwise read a press here as a press on the terminal — focusing it
      // before the click lands, or treating a right-click as copy or paste.
      // See the find bar for why a React `stopPropagation()` cannot stop them.
      {...{ [TERMINAL_CHROME_ATTRIBUTE]: '' }}
    >
      <FloatingButton size="xs" onClick={onJump} className="whitespace-nowrap">
        <ChevronDownIcon className="icon-xs shrink-0" />
        Jump to latest
      </FloatingButton>
    </div>
  )
}
