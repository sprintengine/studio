import type { JSX } from 'react'
type SpinnerProps = {
  /** Icon size in px. Defaults to 16 (icon-sm). */
  size?: number
  /** Accessible label. Omit when adjacent text already names the state. */
  label?: string
  className?: string
}

// The one "working right now" spinner: a faint track ring plus a 90° accent arc
// that rotates continuously. Shared by the LifecycleGlyph in-progress state, the
// a task's "working" indicator, and anywhere a live process shows.
// Reduced-motion freezes it to the at-rest arc (handled by `.lifecycle-spin` in
// index.css), so it never relies on motion alone to read as in-progress.
export function Spinner({ size = 16, label, className }: SpinnerProps): JSX.Element {
  const decorative = !label
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-label={label}
      aria-hidden={decorative || undefined}
      className={`lifecycle-spin shrink-0 text-[color:var(--accent-primary)] ${className ?? ''}`}
    >
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.22" />
      <path d="M8 3a5 5 0 0 1 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
