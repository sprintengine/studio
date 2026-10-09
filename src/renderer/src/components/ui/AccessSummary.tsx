import type { JSX } from 'react'

import { WarningIcon } from '../AppIcons'
import { FOCUS_RING_CLASS } from './tokens'
import { Tooltip } from './Tooltip'

// What a module asks to reach, said at three depths
// (design-system/components/access-summary):
//
// - `AccessGlyphs` — on a list row: one warning glyph per scope that needs
//   care, and nothing else. A row of warning sentences is a row nobody reads;
//   a count of triangles is read at a glance, and the titles are one hover or
//   one Tab away. The full list is never ONLY here: the row's details and its
//   trust review carry it too.
// - `AccessCareList` — in the details and the trust review: each scope that
//   needs care as a short title and a why of six words or fewer, and, where the
//   reader may want the raw identifier, the scope id in mono beneath.
// - `AccessChips` — the standard scopes, as a wrapped set of quiet pills. They
//   are disclosed, not flagged: a pill per scope so they can be counted, with
//   no glyph and no tone.
//
// The words come from `capabilityAccess` (src/shared/modules/permissions.ts);
// this file only draws them.

export type AccessItem = {
  /** The scope identifier, `conversation:operate`. */
  id: string
  /** Short title, `Runs chats with your agents`. */
  title: string
  /** Six words or fewer; scopes that need care only. */
  why?: string
}

const WARN_INK = 'text-[color:var(--tone-warn)]'

/**
 * One warning glyph per scope that needs care, listing their titles on hover
 * and on keyboard focus. Renders nothing when there are none: a row with no
 * sensitive access carries no mark at all ("healthy renders no mark").
 */
export function AccessGlyphs({
  items,
  subject,
}: {
  items: readonly AccessItem[]
  subject: string
}): JSX.Element | null {
  if (items.length === 0) return null
  const names = items.map((item) => item.title)
  return (
    <Tooltip
      multiline
      placement="bottom"
      content={
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5">
              <WarningIcon className={`icon-xs shrink-0 ${WARN_INK}`} />
              <span>{item.title}</span>
            </li>
          ))}
        </ul>
      }
    >
      <span
        // A tab stop of its own so the titles reach the keyboard: the tooltip
        // opens on focus-visible as well as hover. Named in full, so a screen
        // reader hears the list without opening anything.
        tabIndex={0}
        role="img"
        aria-label={`${subject} needs care: ${names.join(', ')}`}
        className={[
          'relative inline-flex shrink-0 cursor-help items-center gap-0.5 rounded-xs px-1 py-0.5',
          'hover:bg-[color:var(--tone-warn-soft)]',
          WARN_INK,
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        {items.map((item) => (
          <WarningIcon key={item.id} className="icon-xs" />
        ))}
      </span>
    </Tooltip>
  )
}

/**
 * The scopes that need care, each a title over its why. `showIds` adds the raw
 * scope beneath in mono, for the details surface where someone may want to
 * search for it; the trust review leaves it out.
 */
export function AccessCareList({
  items,
  showIds = false,
  ariaLabel,
}: {
  items: readonly AccessItem[]
  showIds?: boolean
  ariaLabel: string
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul aria-label={ariaLabel} className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="grid grid-cols-[auto_1fr] gap-x-2">
          {/* mt-0.5 centres the 13px glyph on the 20px first line. */}
          <WarningIcon className={`icon-xs mt-0.5 ${WARN_INK}`} />
          <span className="text-body leading-5 text-[color:var(--text-default)]">{item.title}</span>
          {item.why ? (
            <span className="col-start-2 text-meta leading-4 text-[color:var(--text-muted)]">{item.why}</span>
          ) : null}
          {showIds ? (
            <span className="col-start-2 font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">
              {item.id}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** The standard scopes as a wrapped set of quiet pills. */
export function AccessChips({
  items,
  ariaLabel,
}: {
  items: readonly AccessItem[]
  ariaLabel: string
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {items.map((item) => (
        <li
          key={item.id}
          className="inline-flex min-h-icon-lg items-center rounded-full bg-[color:var(--bg-well)] px-2 text-meta text-[color:var(--text-default)]"
        >
          {item.title}
        </li>
      ))}
    </ul>
  )
}
