import React, { useId } from 'react'

import { FOCUS_RING_PEER_CLASS } from './tokens'

// The kit's checkbox (MC-2117). Five surfaces had each styled the same
// `<input type="checkbox">` independently — 3px and 3.5px boxes, one on the
// browser's `accent-color`, one with a hand-rolled ring whose `ring-offset-color`
// was pinned to `--bg-surface-raised` and therefore wrong on any other surface,
// and one with no focus treatment at all. The most complete of them — the
// styled-peer box in the tracker write-back settings, which is what motivated
// `FOCUS_RING_PEER_CLASS` — is what this promotes. (That surface has since been
// retired with the native tracker layer; the primitive it produced outlived it.)
//
// The native input stays: it carries the semantics, the keyboard path, the
// indeterminate state and form participation. The visible box is decorative and
// hidden from assistive tech, and takes the shared focus treatment through the
// input's `:focus-visible` via `peer`. Nothing here re-implements a checkbox —
// it dresses one.

export type CheckboxProps = {
  checked: boolean
  onChange: (next: boolean) => void
  /** Visible label beside the box. Omit only when `ariaLabel` names the control. */
  label?: React.ReactNode
  /** Accessible name when there is no visible `label`. */
  ariaLabel?: string
  ariaDescribedBy?: string
  /** Mixed state — some but not all of the things this checkbox governs are on.
   *  Renders a dash and sets `indeterminate` on the input, which is a DOM
   *  property rather than an attribute and so cannot be expressed in JSX. */
  indeterminate?: boolean
  disabled?: boolean
  /** Stable id, so a `Field` or a sibling label can target the input. */
  id?: string
  /** Type step for the label. `meta` (12px) by default; `body` for form rows
   *  that sit among other 13px controls. */
  size?: 'meta' | 'body'
  className?: string
}

export function Checkbox({
  checked,
  onChange,
  label,
  ariaLabel,
  ariaDescribedBy,
  indeterminate = false,
  disabled = false,
  id,
  size = 'meta',
  className,
}: CheckboxProps): JSX.Element {
  const generated = useId()
  const inputId = id ?? generated
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  // `indeterminate` has no HTML attribute — it is settable only on the element.
  React.useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  const marked = checked || indeterminate

  return (
    <label
      htmlFor={inputId}
      className={[
        'flex select-none items-center gap-2',
        size === 'body' ? 'text-body' : 'text-meta',
        disabled
          ? 'cursor-not-allowed text-[color:var(--text-disabled)]'
          : 'cursor-pointer text-[color:var(--text-default)]',
        className ?? '',
      ].join(' ')}
    >
      <span className="relative inline-flex size-icon-sm shrink-0 items-center justify-center">
        <input
          ref={inputRef}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          onChange={(event) => onChange(event.target.checked)}
          // Transparent, but present and full-size: it is the tab stop, the hit
          // target and the semantics. Hiding it with `display:none` would take
          // the keyboard with it.
          className="peer absolute inset-0 h-full w-full cursor-[inherit] opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className={[
            'inline-flex size-icon-sm items-center justify-center rounded-[3px] border transition-colors',
            // The input is the tab stop; this box is what a person sees, so the
            // shared treatment lands here on the input's focus. An outline's gap
            // needs no `ring-offset-color`, so it is right on every surface.
            FOCUS_RING_PEER_CLASS,
            disabled ? 'opacity-45' : '',
            marked
              ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
              : 'border-[color:var(--border-default)] bg-[color:var(--bg-app)]',
          ].join(' ')}
        >
          {indeterminate ? (
            <svg viewBox="0 0 16 16" className="size-icon-xs" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="M4 8h8" strokeLinecap="round" />
            </svg>
          ) : checked ? (
            <svg viewBox="0 0 16 16" className="size-icon-xs" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="M3.5 8.5 L6.5 11.5 L12.5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </span>
      </span>
      {label}
    </label>
  )
}
