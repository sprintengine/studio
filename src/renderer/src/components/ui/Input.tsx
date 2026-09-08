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
export type InputSize = 'none' | 'xs' | 'sm' | 'content' | 'md'

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
/**
 * `quiet` — transparent ground, a `border.subtle` hairline, and NO hover lift.
 * For a field that sits INSIDE an already-grounded floating surface: a filter
 * box at the head of a popover, a search inside a menu. There the `bg.field`
 * ground reads as a second panel nested in the first, which is the card-in-a-card
 * the hairline principle rejects, and the hover border lift is a second edge
 * moving inside a surface that already has one.
 *
 * `seamless` — no box AT ALL: no border, no ground, no radius, and no focus
 * indicator of its own. The visible box is the WRAPPER, which draws the border
 * and takes the ring through `FOCUS_RING_WITHIN_INPUT_CLASS` (or its textarea
 * twin). The kit already shipped the wrapper half of this pattern — those two
 * focus constants exist for nothing else — and had no field to put inside it, so
 * every composed control (a glyph + field + menu row, a chat composer) wrote the
 * four cancelling utilities by hand. Pair it with a wrapper that carries one of
 * those constants; a `seamless` field alone has no focus indicator, which is a
 * defect rather than a style.
 *
 * `composer` — `seamless` for the multiline case, plus `field-sizing-content`:
 * the box grows with what is typed between the caller's `min-h-`/`max-h-`
 * bounds. It is a variant of its own rather than a flag on `seamless` because a
 * single-line field that content-sized would grow sideways, and the two must not
 * be reachable by the same name. The chat composer is its one surface: the
 * wrapping `COMPOSER_SURFACE_CLASS` draws the border, the ground and the
 * elevation, and takes the ring through `FOCUS_RING_WITHIN_TEXTAREA_CLASS`,
 * while `ref`, `rows`, `onPaste`, `onContextMenu` and `onKeyDown` pass straight
 * through to the element.
 *
 * `inline` — the title edited IN PLACE: quiet at rest, revealing the field
 * chrome on hover or focus, so the head of a page reads as a heading rather than
 * as a form field wearing one. This is `INLINE_TITLE_EDIT_CLASS` promoted to a
 * variant. The class string stays exported — several sites consume it on their
 * own element for the reason documented on it — but a caller who only wants the
 * chrome should take the variant, so the primitive is what draws it.
 */
export type InputVariant = 'default' | 'well' | 'quiet' | 'seamless' | 'composer' | 'inline'

/**
 * `xs` (26px) exists now, and the comment this replaces said it could not: "26px
 * cannot hold a text cursor plus its inset". That was true of a field with the
 * `sm` step's 8px inset and 13px body type. It is the wrong reading for the case
 * that actually asked — a dense numeric or mono box in a toolbar of 26px icon
 * buttons (a viewport width, a browser address bar), where the type is
 * `font.size.meta` and a 30px field is the tallest thing in the row. The step is
 * on the ramp (`size.control.xs`), so this is a ramp step being used, not a
 * height being invented; what it is NOT is a licence to shrink a labelled form
 * field, which stays at `sm`.
 *
 * `content` gives the height back to the caller's inset — for the quiet field
 * inside a popover, whose surface has already set the rhythm. `none` spends
 * nothing at all: the `seamless` and `inline` variants take it, because their
 * host owns the box.
 */
const SIZE: Record<InputSize, string> = {
  none: '',
  xs: 'h-control-xs px-2 text-meta',
  sm: 'h-control-sm px-2 text-body',
  content: 'px-2 py-1 text-body',
  md: 'h-control-md px-3 text-body',
}

// The multiline sibling has no ramp height — its height comes from `rows` and
// its content — so a size step spends itself on the inset instead, at the same
// two values the single-line steps use horizontally.
const TEXTAREA_SIZE: Record<InputSize, string> = {
  none: '',
  xs: 'px-2 py-1 text-meta',
  sm: 'px-2 py-1.5 text-body',
  content: 'px-2 py-1 text-body',
  md: 'px-3 py-2 text-body',
}

// Everything both members share: the shape, the edge, the ink, the placeholder
// tier, the hover edge lift, the one focus indicator, and the disabled state.
// Focus is the ring and only the ring — a focus-scoped border recolour is the
// second idiom `scripts/lint-design-system-conformance.mjs` rejects outright.
const CHROME = [
  'transition-colors',
  'placeholder:text-[color:var(--text-disabled)]',
  'disabled:cursor-not-allowed disabled:opacity-45',
].join(' ')

// The BOXED chrome: the shape, the edge, the ink, the hover lift, the validity
// edge and the one focus indicator. Three of the five variants take it; the two
// that do not are the ones whose box belongs to something else.
//
// Focus is the ring and only the ring — a focus-scoped border recolour is the
// second idiom `scripts/lint-design-system-conformance.mjs` rejects outright.
//
// Each property is declared exactly ONCE per variant below rather than as a
// shared default plus a per-variant repaint: a shared `border-…` followed by
// `quiet`'s `border-subtle` would be two utilities of equal specificity, and
// which of them painted would be stylesheet order.
const BOXED = [
  'rounded-sm border',
  'text-[color:var(--text-default)]',
  // The validity edge rides `aria-invalid`, not a caller className: an
  // attribute variant out-specifies both the resting border and the hover
  // lift, so an invalid field's red edge is deterministic instead of a
  // stylesheet-order coin flip — and the state is announced, not just drawn.
  'aria-invalid:border-[color:var(--tone-error)] aria-invalid:hover:border-[color:var(--tone-error)]',
  FOCUS_RING_CLASS,
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

/** The five grounds-and-edges, one entry per variant. See `InputVariant`. */
const VARIANT: Record<InputVariant, string> = {
  default: `${BOXED} border-[color:var(--border-default)] hover:border-[color:var(--border-strong)] bg-[color:var(--bg-field)]`,
  well: `${BOXED} border-[color:var(--border-default)] hover:border-[color:var(--border-strong)] bg-[color:var(--bg-app)]`,
  // No hover lift: a second edge moving inside an already-bordered surface reads
  // as the surface itself changing.
  quiet: `${BOXED} border-[color:var(--border-subtle)] hover:border-[color:var(--border-subtle)] bg-transparent`,
  // No border, no radius, no ring, and `outline-none` UNPREFIXED — the UA
  // outline is replaced by the wrapper's, in every focus state rather than only
  // in the keyboard one, because the wrapper is the box a person sees.
  seamless: 'bg-transparent text-[color:var(--text-strong)] outline-none',
  composer: 'bg-transparent text-[color:var(--text-strong)] outline-none field-sizing-content',
  inline: INLINE_TITLE_EDIT_CLASS,
}

/**
 * The variants whose HOST owns the box, so the size ramp has nothing to spend.
 * Naming them here rather than defaulting `size` per variant keeps one rule:
 * a `seamless` field never carries a height, whatever a caller passes.
 */
const HOSTED = new Set<InputVariant>(['seamless', 'composer', 'inline'])

/**
 * `inline` already carries `w-full` inside `INLINE_TITLE_EDIT_CLASS` — a title
 * edited in place always fills its heading — so the width prop must not add a
 * second one. Two `w-*` utilities on one element are resolved by stylesheet
 * order like any other pair, and here they happen to agree, which is exactly the
 * kind of duplicate that survives until the day one of them changes.
 */
function widthClass(variant: InputVariant, fullWidth: boolean): string {
  if (variant === 'inline') return ''
  return fullWidth ? 'w-full' : ''
}

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
          widthClass(variant, fullWidth),
          SIZE[HOSTED.has(variant) ? 'none' : size],
          VARIANT[variant],
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
          widthClass(variant, fullWidth),
          resize === 'y' ? 'resize-y' : 'resize-none',
          'leading-5',
          TEXTAREA_SIZE[HOSTED.has(variant) ? 'none' : size],
          VARIANT[variant],
          CHROME,
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      />
    )
  },
)
