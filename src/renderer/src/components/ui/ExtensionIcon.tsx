// The mark every extension wears: a neutral chip carrying the thing's own
// artwork, or its monogram when it has none. One implementation for the
// Extensions door, the connector rows, the composer's picker and the workspace's
// Skills and MCPs aside — a server that reads as GitHub in the door must read as
// GitHub everywhere else, and a skill's letter chip must be the same letter chip.
//
// It lives in `ui/` rather than beside the Settings MCP catalog (its first home,
// as `McpBrandIcon`) because the aside renders from a view model with no access
// to the Settings component graph.

import React, { useState } from 'react'

import { mcpMonogram } from './mcpMonogram'

export function ExtensionIcon({
  slug,
  name,
  icon,
  mark,
  size = 36,
}: {
  /** Simple Icons slug for a brand mark fetched from the CDN, when one is known. */
  slug?: string | null
  name: string
  /** The entry's own icon — a data URI from the bundled catalog, or an https URL. */
  icon?: string
  /**
   * A mark we ship ourselves, drawn rather than fetched — SprintEngine's own
   * extensions wear the frond. It outranks every other source: an id we
   * recognise is a stronger answer than any URL, and it needs no network.
   */
  mark?: React.ReactNode
  size?: number
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  // Per-entry icon (data URI or https URL) wins; else the brand-color Simple
  // Icons glyph (no tint segment — a baked tint is invisible on the opposite
  // theme); else the monogram. All three sit on the same neutral chip so brand
  // colors stay readable on every theme.
  const src = failed ? null : icon || (slug ? `https://cdn.simpleicons.org/${slug}` : null)
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)]"
    >
      {mark ? (
        <span
          style={{ width: Math.round(size * 0.72), height: Math.round(size * 0.72) }}
          className="grid place-items-center [&>svg]:h-full [&>svg]:w-full"
        >
          {mark}
        </span>
      ) : src ? (
        <img
          src={src}
          alt=""
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
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
