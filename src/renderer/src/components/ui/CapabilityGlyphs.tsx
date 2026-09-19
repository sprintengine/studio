import React, { type JSX } from 'react'

type GlyphProps = {
  className?: string
}

/** The Skills category mark shared by Extensions and capability inventory rows. */
export function SkillsGlyph({
  className = 'icon-xs shrink-0 text-[color:var(--text-muted)]',
}: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3 3h10v10H3zM3 6h10M6 6v7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The agent-CLI mark — a prompt in a terminal frame. Shared by the Extensions
 *  drawer's Agent CLIs row and the surface's own Agent CLIs rail row; it was a
 *  private copy inside the surface until the drawer needed it eagerly
 *  (Extensions drawer ruling, 2026-09-05), and one concept keeps one glyph. */
export function CliGlyph({ className = 'icon-xs shrink-0 text-[color:var(--text-muted)]' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 3.5h11v9h-11zM4.8 6.6l2 1.7-2 1.7M8.6 10.3h2.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The MCP plug mark shared by Extensions and capability inventory rows. */
export function McpGlyph({ className = 'icon-xs shrink-0 text-[color:var(--text-muted)]' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M5.5 2v3M10.5 2v3M4 5h8v3.5a4 4 0 0 1-8 0zM8 12.5V14"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
