import React from 'react'

export type SkeletonProps = {
  /** Tailwind utilities for size, shape, and surface (e.g. `h-3 w-20 rounded`). */
  className?: string
  /**
   * Inline style hatch for one-off width / height when a Tailwind class is
   * unavailable (e.g. percentages with arbitrary values). Prefer `className`.
   */
  style?: React.CSSProperties
}

/**
 * Hairline shimmer block. Animation comes from the shared `.skeleton-shimmer`
 * keyframe in `index.css`; the surface colour is supplied per caller because
 * the right neutral depends on whether the parent is the panel ground or a
 * raised card.
 */
export function Skeleton({ className, style }: SkeletonProps) {
  return <div aria-hidden="true" className={`skeleton-shimmer ${className ?? ''}`} style={style} />
}
