import React from 'react'
import { FOCUS_RING_CLASS } from './tokens'

type ButtonBase = React.ButtonHTMLAttributes<HTMLButtonElement>

const SHARED =
  'interactive inline-flex items-center justify-center gap-1.5 rounded-[5px] font-medium ' +
  'disabled:cursor-not-allowed disabled:opacity-45'

// xs is the dense-chrome size for inline row actions and popover triggers;
// sm/md carry the form-control sizes. Migrated hand-rolled buttons on the
// roster and tracker surfaces land here so their radius, focus ring, and hover
// all match the primitive rather than drifting per surface. Heights and label
// sizes come from the ramp (sem.size.control.*, sem.font.size.*) so a control
// and the label beside it keep their rhythm when the ramp moves.
type ButtonSize = 'xs' | 'sm' | 'md'

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-control-xs px-2 text-meta',
  sm: 'h-control-sm px-2 text-body',
  md: 'h-control-md px-3 text-body',
}

type SizedButtonProps = ButtonBase & { size?: ButtonSize }

export const PrimaryButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(
  function PrimaryButton({ className, size = 'sm', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          SHARED,
          SIZE[size],
          'bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]',
          'hover:bg-[color:var(--accent-primary-hover)]',
          FOCUS_RING_CLASS,
          className ?? '',
        ].join(' ')}
      />
    )
  },
)

export const GhostButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(
  function GhostButton({ className, size = 'sm', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          SHARED,
          SIZE[size],
          'bg-transparent text-[color:var(--text-muted)]',
          'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          FOCUS_RING_CLASS,
          className ?? '',
        ].join(' ')}
      />
    )
  },
)

// Bordered neutral button — the "outline" variant. Retired the hand-rolled
// lookalike (a GhostButton re-styled with a border className, or a raw <button>
// with border/rounded/hover chrome) that had accreted across the roster,
// tracker, and backlog surfaces; each had subtly different radius, hover, and
// focus. This is the one canonical secondary-action button.
export const OutlineButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(
  function OutlineButton({ className, size = 'sm', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          SHARED,
          SIZE[size],
          'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)]',
          'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          FOCUS_RING_CLASS,
          className ?? '',
        ].join(' ')}
      />
    )
  },
)

type IconButtonProps = ButtonBase & {
  /** Required: icon-only buttons must expose an accessible name. */
  'aria-label': string
  size?: 'sm' | 'md'
}

const ICON_SIZE: Record<'sm' | 'md', string> = {
  sm: 'size-control-xs text-body',
  md: 'size-control-sm text-heading',
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, size = 'sm', children, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          'interactive inline-flex items-center justify-center rounded-[5px]',
          ICON_SIZE[size],
          'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
          'disabled:cursor-not-allowed disabled:opacity-45',
          FOCUS_RING_CLASS,
          className ?? '',
        ].join(' ')}
      >
        {children}
      </button>
    )
  },
)

// Canonical close affordance. Use everywhere a panel, aside, drawer, or
// inspector needs a top-right X. Borderless on purpose — bordered/raised
// variants compete with the surface they sit on and add a second radius
// to the view, breaking the soul brief's ≤ 2 radii rule. The bordered
// SprintEngine variant was retired here; do not reintroduce it.
export function CloseIconButton({
  size = 'sm',
  ...rest
}: Omit<IconButtonProps, 'children'>) {
  return (
    <IconButton {...rest} size={size}>
      <svg
        className="icon-sm"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </IconButton>
  )
}
