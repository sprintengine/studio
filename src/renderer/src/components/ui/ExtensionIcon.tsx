// The mark every extension wears: a neutral chip carrying the thing's own
// artwork, or its monogram when it has none. One implementation for the
// Extensions door, the connector rows, the composer's picker and the workspace's
// Skills and MCPs aside — a server that reads as GitHub in the door must read as
// GitHub everywhere else, and a skill's letter chip must be the same letter chip.
//
// It lives in `ui/` rather than beside the Settings MCP catalog (its first home,
// as `McpBrandIcon`) because the aside renders from a view model with no access
// to the Settings component graph.

import React, { useState, type JSX } from 'react'

import { glyphGraphemeCount } from '../../../../shared/skills'
import { iconHasOwnPlate } from './iconPlate'
import { mcpMonogram } from './mcpMonogram'

export function ExtensionIcon({
  slug,
  name,
  icon,
  iconPlated,
  mark,
  glyph,
  size = 36,
}: {
  /** Simple Icons slug for a brand mark fetched from the CDN, when one is known. */
  slug?: string | null
  name: string
  /** The entry's own icon — a data URI from the bundled catalog, or an https URL. */
  icon?: string
  /**
   * True when the caller KNOWS `icon` brings its own ground — a GitHub owner's
   * avatar, a marketplace entry's logo — and so must fill the slot rather than
   * sit inset in the neutral chip. `iconHasOwnPlate` can only answer that for
   * artwork it can decode; for an https URL it answers "chip", the safe wrong
   * answer, and this is how a caller who does know says otherwise.
   */
  iconPlated?: boolean
  /**
   * A glyph the entry gives itself — an emoji, or a character or two of text.
   * It is drawn rather than fetched, like `mark`, but it is the publisher's
   * own string rather than one we ship, so it ranks below `mark` and above
   * every picture: a plugin that says it is 🦀 has answered the question.
   */
  glyph?: string
  /**
   * A mark we ship ourselves, drawn rather than fetched — SprintEngine's own
   * extensions wear the frond. It outranks every other source: an id we
   * recognise is a stronger answer than any URL, and it needs no network.
   */
  mark?: React.ReactNode
  size?: number
}): JSX.Element {
  // The picture that failed, not a flag that one did: a flag set for one URL
  // sticks to the next URL this same instance is handed, and a row whose
  // plugin changed under it would wear the monogram for a picture that never
  // failed. Remembering the URL forgets the failure exactly when the picture
  // changes, and no sooner — the one that failed is not fetched again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  // Per-entry icon (data URI or https URL) wins. When it brings its own plate
  // — an app icon — it wears no chip: a white plate behind a framed thing is a
  // second frame (owner ruling 2026-09-01). Everything else keeps the chip
  // because it needs a ground: a flat brand mark (the catalogue's near-black
  // GitHub would vanish bare on dark), a shipped `mark` whose ink is fixed for
  // a light plate, the Simple Icons CDN glyph (no tint segment — a baked tint
  // is invisible on the opposite theme), the publisher's own `glyph`, and the
  // monogram, which is a letter.
  if (icon && !glyph && failedSrc !== icon && (iconPlated || iconHasOwnPlate(icon))) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(icon)}
        className="pointer-events-none shrink-0 select-none rounded-lg object-contain"
      />
    )
  }
  const candidate = icon || (slug ? `https://cdn.simpleicons.org/${slug}` : null)
  const src = candidate && failedSrc !== candidate ? candidate : null
  // `overflow-hidden` is the last guard on the glyph: the validator caps it at
  // two graphemes and the size below fits two, but a string that is wider than
  // its count promised still ends at the chip's edge and not across the name.
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center overflow-hidden rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)]"
    >
      {mark ? (
        <span
          style={{ width: Math.round(size * 0.72), height: Math.round(size * 0.72) }}
          className="grid place-items-center [&>svg]:h-full [&>svg]:w-full"
        >
          {mark}
        </span>
      ) : glyph ? (
        // Its own line-height, and larger than the monogram when it is ONE
        // thing: an emoji is artwork wearing a text box, and at the monogram's
        // size it reads as a small stain in a large chip rather than as the
        // plugin's mark. Two things — `AI`, a pair of emoji — are as wide as
        // the monogram's two letters and take its size, or they spill the chip.
        <span
          style={{ fontSize: Math.round(size * (glyphGraphemeCount(glyph) > 1 ? 0.42 : 0.58)) }}
          className="select-none whitespace-nowrap leading-none text-[color:var(--icon-chip-ink)]"
        >
          {glyph}
        </span>
      ) : src ? (
        <img
          src={src}
          alt=""
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="pointer-events-none select-none"
        />
      ) : (
        <span
          style={{ fontSize: Math.round(size * 0.42) }}
          className="font-mono font-semibold text-[color:var(--icon-chip-ink)]"
        >
          {mcpMonogram(name)}
        </span>
      )}
    </span>
  )
}
