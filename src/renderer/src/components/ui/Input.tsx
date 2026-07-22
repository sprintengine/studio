import React from 'react'
import { FOCUS_RING_CLASS } from './tokens'

type InputProps = React.InputHTMLAttributes<HTMLInputElement>

// Canonical single-line text input. Token-only chrome deliberately matched to
// the Select trigger (same height, radius, border, and focus ring) so an input
// and a select sitting in the same form read as one control family. Retired the
// per-surface hand-rolled input classes (h-8 rounded-md bg-app with a focus
// border swap) that had drifted from the primitives around them. Pass
// `className` for per-field needs such as `font-mono` on identifier/URL fields.
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, type, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type ?? 'text'}
        {...rest}
        className={[
          'h-7 w-full rounded-[5px] border border-[color:var(--border-default)]',
          'bg-[color:var(--bg-surface-raised)] px-2 text-[12px] text-[color:var(--text-default)]',
          'transition-colors placeholder:text-[color:var(--text-disabled)]',
          'hover:border-[color:var(--border-strong)]',
          FOCUS_RING_CLASS,
          'disabled:cursor-not-allowed disabled:opacity-45',
          className ?? '',
        ].join(' ')}
      />
    )
  },
)
