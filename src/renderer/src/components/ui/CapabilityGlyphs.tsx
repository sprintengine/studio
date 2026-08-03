import React from 'react'

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

/** The MCP plug mark shared by Extensions and capability inventory rows. */
export function McpGlyph({
  className = 'icon-xs shrink-0 text-[color:var(--text-muted)]',
}: GlyphProps): JSX.Element {
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
