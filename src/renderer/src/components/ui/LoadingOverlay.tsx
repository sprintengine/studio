import React from 'react'
import { StatusDot } from './StatusDot'

export type LoadingOverlayProps = {
  /** Sentence-case message describing the work in progress. */
  label: string
  /** Optional class for the outer wrapper, when the panel needs absolute positioning. */
  className?: string
}

/**
 * Centered loading state, used when a panel has no content to skeleton-render
 * and instead needs to communicate "we're working on it." Pairs a pulsed
 * good-tone dot with one short sentence of context.
 */
export function LoadingOverlay({ label, className }: LoadingOverlayProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex h-full w-full items-center justify-center ${className ?? ''}`}
    >
      <div className="flex items-center gap-3 text-[12px] text-[color:var(--text-muted)]">
        <StatusDot tone="good" pulse size={8} />
        <span>{label}</span>
      </div>
    </div>
  )
}
