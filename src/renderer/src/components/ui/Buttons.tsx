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

/**
 * The two inks a borderless control can carry. `danger` is the ONLY way to get
 * a destructive ghost — recolouring one through `className` puts two
 * `text-[color:var(--…)]` utilities of equal specificity on the element, and
 * which of them paints is then a question of stylesheet order rather than of
 * what the caller wrote. The Git panel spelled that override at six call sites
 * before MC-2113; making it a prop is what stops the seventh.
 */
export type ButtonTone = 'neutral' | 'danger'

const GHOST_TONE: Record<ButtonTone, string> = {
  neutral:
    'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]',
  danger:
    'text-[color:var(--tone-error)] hover:bg-[color:var(--tone-error-soft)] hover:text-[color:var(--tone-error)] ' +
    'disabled:hover:bg-transparent disabled:hover:text-[color:var(--tone-error)]',
}

// Every variant below pins its RESTING appearance back under `disabled:hover:`.
// That is not belt-and-braces: CSS `:hover` still matches a disabled button
// (unlike `pointer-events: none`, which would also swallow the tooltip that
// explains why the control is off), so without it each hover step fires under
// the pointer while the button refuses the click. The retired `ModalButton`
// primary carried this guard privately; folding every dialog footer onto these
// primitives (MC-2113) is only faithful if the primitives carry it too.
//
// One declaration per utility, never a reset plus a repaint: a shared
// `disabled:hover:bg-transparent` followed by a per-variant recolour would put
// two rules for one property at equal specificity, and which of them paints
// would be a matter of stylesheet order. `:disabled:hover` outranks a plain
// `:hover` on its own, so the guard needs no help winning.
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
          'disabled:hover:bg-[color:var(--accent-primary)]',
          FOCUS_RING_CLASS,
          className ?? '',
        ].join(' ')}
      />
    )
  },
)

// The destructive counterpart to PrimaryButton: one solid tone, spent on the
// action a person cannot undo. It exists here rather than inside `ui/Modal` —
// where the `ModalButton` danger variant used to spell it — because a dialog is
// not the only place a destructive confirm appears, and a variant declared
// inside one host is how the product grew five primaries (MC-2113).
export const DangerButton = React.forwardRef<HTMLButtonElement, SizedButtonProps>(
  function DangerButton({ className, size = 'sm', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          SHARED,
          SIZE[size],
          // No hover step: the system ships no `--tone-error-hover`, and a
          // hand-tuned one here would be the nineteen-theme drift this kit
          // exists to stop. Carrying the same rest state the retired
          // `ModalButton` danger variant had is a faithful move, not a
          // regression — a token is the fix, not a literal.
          'bg-[color:var(--tone-error)] text-[color:var(--tone-error-ink)]',
          FOCUS_RING_CLASS,
          className ?? '',
        ].join(' ')}
      />
    )
  },
)

export const GhostButton = React.forwardRef<HTMLButtonElement, SizedButtonProps & { tone?: ButtonTone }>(
  function GhostButton({ className, size = 'sm', tone = 'neutral', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          SHARED,
          SIZE[size],
          'bg-transparent',
          GHOST_TONE[tone],
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
// Tone here is INK ONLY — the border and the ground stay neutral in both. A
// destructive secondary action is still a secondary action: `DangerButton`'s
// solid fill is the terminal confirm, and giving this one a red edge as well
// would spend the danger tone twice on the weaker of the two.
const OUTLINE_TONE: Record<ButtonTone, string> = {
  neutral:
    'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)] ' +
    'disabled:hover:text-[color:var(--text-default)]',
  danger:
    'text-[color:var(--text-default)] hover:text-[color:var(--tone-error)] ' +
    'disabled:hover:text-[color:var(--text-default)]',
}

export const OutlineButton = React.forwardRef<HTMLButtonElement, SizedButtonProps & { tone?: ButtonTone }>(
  function OutlineButton({ className, size = 'sm', tone = 'neutral', type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          SHARED,
          SIZE[size],
          'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]',
          OUTLINE_TONE[tone],
          'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)]',
          'disabled:hover:border-[color:var(--border-default)] disabled:hover:bg-[color:var(--bg-surface)]',
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
  /** Same contract as `GhostButton`'s: a destructive icon action is a prop. */
  tone?: ButtonTone
}

const ICON_SIZE: Record<'sm' | 'md', string> = {
  sm: 'size-control-xs text-body',
  md: 'size-control-sm text-heading',
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, size = 'sm', tone = 'neutral', children, type, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        {...rest}
        className={[
          'interactive inline-flex items-center justify-center rounded-[5px]',
          ICON_SIZE[size],
          GHOST_TONE[tone],
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
