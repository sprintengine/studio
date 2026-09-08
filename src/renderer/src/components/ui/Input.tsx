import React from 'react'
import { FOCUS_RING_CLASS } from './tokens'

// The product's one text-field vocabulary: `Input` for a single line,
// `Textarea` for many. This primitive had ZERO board-surface consumers before
// MC-2114. In its place the product grew NINE hand-rolled ones — the automation
// editor's `CONTROL_BASE` (duplicated verbatim in `TriggerFields` under comments
// in both files admitting the two were hand-synced), five separate inline
// strings inside one panel file, two different module constants both named
// `INPUT_CLASS`, two different ones both named `ROW_INPUT_CLASS` (so "the" row
// input was a coin flip between a `--bg-surface` field and a `--bg-app` well),
// and a runner settings box, which declared no focus indicator at
// all. Heights landed on 26/28/32/34/36/40/44px, mostly off the 26/30/34 ramp.
//
// Chrome is deliberately matched to the `Select` trigger (same height, radius,
// border, ground, and focus ring) so an input and a select sitting in the same
// form read as one control family.

/**
 * The ramp steps a text field takes, named as the buttons name theirs
 * (`ui/Buttons` SIZE) so a field and the button beside it are the same height
 * for the same reason. `xs` (26px) is absent: it is the dense-chrome step for
 * inline row actions, and 26px cannot hold a text cursor plus its inset without
 * the ink touching the border.
 */
export type InputSize = 'sm' | 'md'

/**
 * The two grounds a field is drawn on, and there is no third.
 *
 * `default` is the field material — `--bg-field`, which is `--bg-surface-raised`
 * on an opaque window and translucent under glass, so a field sitting in the
 * chrome is made of the same stuff as the bar around it. A field READS as
 * raised: it is the thing you put something into.
 *
 * `well` is the recessed step for a control inside a settings row, where the
 * body is already `--bg-surface` and a raised field would have nothing to lift
 * away from. This is the recipe that used to live twice, under one name, in two
 * settings modules with two different grounds.
 */
export type InputVariant = 'default' | 'well'

const SIZE: Record<InputSize, string> = {
  sm: 'h-control-sm px-2',
  md: 'h-control-md px-3',
}

// The multiline sibling has no ramp height — its height comes from `rows` and
// its content — so a size step spends itself on the inset instead, at the same
// two values the single-line steps use horizontally.
const TEXTAREA_SIZE: Record<InputSize, string> = {
  sm: 'px-2 py-1.5',
  md: 'px-3 py-2',
}

const GROUND: Record<InputVariant, string> = {
  default: 'bg-[color:var(--bg-field)]',
  well: 'bg-[color:var(--bg-app)]',
}

// Everything both members share: the shape, the edge, the ink, the placeholder
// tier, the hover edge lift, the one focus indicator, and the disabled state.
// Focus is the ring and only the ring — a focus-scoped border recolour is the
// second idiom `scripts/lint-design-system-conformance.mjs` rejects outright.
const CHROME = [
  'rounded-sm border border-[color:var(--border-default)]',
  'text-body text-[color:var(--text-default)] transition-colors',
  'placeholder:text-[color:var(--text-disabled)]',
  'hover:border-[color:var(--border-strong)]',
  // The validity edge rides `aria-invalid`, not a caller className: an
  // attribute variant out-specifies both the resting border and the hover
  // lift, so an invalid field's red edge is deterministic instead of a
  // stylesheet-order coin flip — and the state is announced, not just drawn.
  'aria-invalid:border-[color:var(--tone-error)] aria-invalid:hover:border-[color:var(--tone-error)]',
  FOCUS_RING_CLASS,
  'disabled:cursor-not-allowed disabled:opacity-45',
].join(' ')

/**
 * The third member, and the one that is a class string rather than a component:
 * a title edited IN PLACE. It is quiet at rest — no box at all — and reveals the
 * field chrome on hover or focus, so the head of a page reads as a heading
 * rather than as a form field wearing one, and the name is still one click away.
 *
 * A string, not a component, because the only thing these sites share is the
 * chrome: the automation editor's name is `text-title font-semibold`, the New
 * sprint dialog's run name is `font-mono text-heading font-medium`, and the type
 * step IS the surface's decision. It deliberately spells no `text-*` of its own
 * so the caller's is the only one — Tailwind resolves two font-size utilities by
 * stylesheet order, not by the order they appear in a class string.
 *
 * The negative inline margin is load-bearing: it pulls the revealed box back out
 * by its own padding so the glyphs do not shift when the chrome appears.
 *
 * Written out in full, per the literal rule in ./tokens.
 */
export const INLINE_TITLE_EDIT_CLASS =
  '-mx-1.5 w-full rounded-sm border border-transparent bg-transparent px-1.5 py-0.5 transition-colors ' +
  'hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-field)] focus-visible:focus-ring'

type SharedProps = {
  size?: InputSize
  variant?: InputVariant
  /**
   * Whether the field fills its track. Default true — the common case, and what
   * every retired constant spelled. Pass `false` when the field is sized to its
   * content (a settings row's `w-60`, a narrow numeric control) and give the
   * measure in `className`: Tailwind resolves two width utilities by stylesheet
   * order rather than by the order they appear in the string, so a caller's
   * `w-60` cannot be relied on to beat a `w-full` the primitive already wrote.
   */
  fullWidth?: boolean
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & SharedProps

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input(
    { className, type, size = 'sm', variant = 'default', fullWidth = true, ...rest },
    ref,
  ) {
    return (
      <input
        ref={ref}
        type={type ?? 'text'}
        {...rest}
        className={[
          fullWidth ? 'w-full' : '',
          SIZE[size],
          GROUND[variant],
          CHROME,
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    )
  },
)

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> &
  SharedProps & {
    /** `y` (default) draws the native drag handle; `none` for a field that
     *  manages its own height. See the note on the component. */
    resize?: 'y' | 'none'
  }

/**
 * The multiline member of the same vocabulary. Callers own the height — `rows`
 * for a floor, `min-h-[…]`/`max-h-[…]` in `className` for a bounded editor —
 * and everything else is the field chrome above, so a textarea and the input
 * above it in the same form are the same field at two lengths.
 *
 * `resize` is a prop rather than something a caller writes into `className` for
 * the same reason `fullWidth` is: two `resize-*` utilities on one element are
 * resolved by stylesheet order, not by the order they appear in a class string,
 * so an auto-growing composer passing `resize-none` over the primitive's
 * `resize-y` would keep its drag handle on whichever build put that rule last.
 * `y` is the default because a field whose content the author cannot see is a
 * worse failure than a form that reflows.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { className, size = 'sm', variant = 'default', fullWidth = true, resize = 'y', ...rest },
    ref,
  ) {
    return (
      <textarea
        ref={ref}
        {...rest}
        className={[
          fullWidth ? 'w-full' : '',
          resize === 'y' ? 'resize-y' : 'resize-none',
          'leading-5',
          TEXTAREA_SIZE[size],
          GROUND[variant],
          CHROME,
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    )
  },
)
