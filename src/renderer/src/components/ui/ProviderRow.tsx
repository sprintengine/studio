import React from 'react'

import { Badge, type MarkBadge } from './Badge'
import { Switch } from './Switch'
import { FOCUS_RING_CLASS, STATUS_TONE_COLOR_VAR, type StatusTone } from './tokens'

// ProviderRow — the one two-line anatomy for a *provider*: something the app
// talks to that can be present-or-absent, healthy-or-not, and configured
// per-instance. Agent CLIs (installed list and registry canvas) are the first
// consumers; source-control providers, MCP servers, and capability modules
// carry the same shape.
//
// Anatomy, top to bottom / left to right:
//
//   [22px brand mark + corner health dot]  Name  v1.2.3        [actions] ⌄ [switch]
//                                          one state line
//
// Four rules the props enforce rather than suggest:
//
//  1. **Health and enablement are different axes.** `health` drives the dot;
//     `enabled` drives the switch. A provider can be switched on and
//     unhealthy, or off and perfectly installed. Nothing derives one from the
//     other, and a host with no real enablement state passes no switch at all
//     rather than rendering a dead one.
//  2. **The dot never carries a state alone.** It is `aria-hidden`, because
//     `stateLine` is mandatory and names the state in words — which is also
//     what makes the row survive greyscale and colour-blindness.
//  3. **No version placeholder.** `version` absent means nothing is rendered
//     there. A row that says "unknown" where a version goes has spent a
//     high-signal slot on the absence of information.
//  4. **One status idiom per list.** `health` and `badge` are both optional,
//     and a list picks ONE. A dot on every row in a list where every row is
//     healthy says nothing while looking like it says something (owner,
//     2026-09-10: "it didn't tell me which CLIs were needing an update"); a
//     badge marks the few rows that want the person, and is the number that
//     says how much.
//
// The row draws no border. Rows separate by 12px vertical padding and the
// standard hover fill — a box per row in a list of five reads as five panels.

export type ProviderRowProps = {
  /** Brand mark, sized by the row to a 22px box. Callers pass `CliIcon` (agent
   *  CLIs) or `PluginIcon` (registry entries) — the row never picks the mark, so
   *  a provider whose identity is a logo and one whose identity is a glyph read
   *  at the same weight. */
  icon: React.ReactNode
  /** Health of the provider itself: reachable, degraded, unreachable, unknown.
   *  Never enablement, and never derived from it.
   *
   *  Omitted (or null) renders NO dot, which is the right call for a list whose
   *  state line already says the state in words for every row and whose rows are
   *  overwhelmingly one tone — nine green dots down a column is decoration, and
   *  it crowds out the badge that does have something to say. */
  health?: StatusTone | null
  /** The kit's corner count, docked on the mark's top-right. Omitted, or a
   *  count of 0, renders nothing. */
  badge?: MarkBadge | null
  /**
   * The provider is not present on this machine. Drops the mark and the name a
   * contrast step, the way the sidebar recedes a conversation that is not the
   * active one, so a scan down the list lands on what IS here. It is not a
   * disabled state and never the only carrier of the fact: the state line still
   * says "Not installed — no `muse` on PATH", and every control on the row keeps
   * working (an Install button on a recessed row is the whole point).
   */
  recessed?: boolean
  name: string
  /** Rendered mono when known. Absent (or empty) renders nothing — never a
   *  placeholder. Real `--version` output is not always a semver (`grok 0.2.114
   *  (0c785038798) [stable]`, a whole sentence from GNU bash), so the slot caps
   *  and truncates rather than letting the version starve the name. */
  version?: string | null
  /** One line of state, in words: "Ready — /usr/local/bin/claude", "Not
   *  installed", "Unavailable — startup timed out after 15s". State, never a
   *  caption: it says what is true now, not what the provider is for.
   *  Identifiers inside it should be mono (`ProviderStateId`). */
  stateLine: React.ReactNode
  /** Enablement. Supply both to render the trailing switch; omit both when the
   *  host has no real enablement state to write to. */
  enabled?: boolean
  onEnabledChange?: (next: boolean) => void
  /** Disclosure. Supply both (plus `children`) to render the chevron and the
   *  in-place expansion. The row keeps its position — the detail opens under
   *  it, it never navigates. */
  expanded?: boolean
  onExpandedChange?: (next: boolean) => void
  /** Row-scoped actions (an Install button, a Get button) placed before the
   *  chevron. Keep to one: the row is not a toolbar. */
  actions?: React.ReactNode
  /** Tier 1 selection, for lists whose row drives a detail pane beside them:
   *  a neutral `--bg-selected` fill, no border and no accent, per the selection
   *  tiers in `design-system/patterns/selection.html`. */
  selected?: boolean
  /** How a row in such a list BECOMES selected. Supplying it makes the mark and
   *  text a single button — the `ConnectorRow` pattern — so the detail pane
   *  opens by keyboard as well as by mouse, and the row's own action button
   *  stays a separate tab stop rather than being swallowed by it. Ignored when
   *  the row is disclosable: a row cannot both expand in place and drive a pane
   *  beside it. */
  onSelect?: () => void
  /** The per-instance detail revealed by the chevron. */
  children?: React.ReactNode
  /**
   * Where the row sits. `page` (default) is a row loose on a surface: its own
   * radius under the hover fill, a 10px inset. `card` is a row inside the list
   * card (`SettingCard as="ul"`, ruled 2026-09-15): square corners because the
   * card clips, the card's 16px inset, and the fill reaching the card's edge —
   * an inset rounded fill inside a bordered card reads as a card in a card.
   */
  surface?: 'page' | 'card'
  /** `li` when the row is a child of a list card's `<ul>`. */
  as?: 'div' | 'li'
  className?: string
}

/** Mono span for an identifier inside a state line — a path, an account, a
 *  binary name. Sized one step under the state line so the identifier reads as
 *  data without out-shouting the words around it. */
export function ProviderStateId({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-micro text-[color:var(--text-default)]">{children}</span>
}

// The dot's keyline: a 2px ring in whatever fill sits behind the row, so the dot
// reads as its own object on top of the brand mark instead of a stain on it. A
// static surface-coloured ring would halo once the row takes its hover or
// selected fill, so all three states are named.
// design-tokens-allow: zero-blur 2px ring, not a glow — the no-glow-shadow rule targets non-zero blur radii on CTAs.
const DOT_KEYLINE_RESTING = 'shadow-[0_0_0_2px_var(--bg-surface)]'
// design-tokens-allow: same zero-blur keyline, on the list card's raised ground.
const DOT_KEYLINE_RESTING_CARD = 'shadow-[0_0_0_2px_var(--bg-surface-raised)]'
// design-tokens-allow: same zero-blur keyline, tracking the selected fill.
const DOT_KEYLINE_SELECTED = 'shadow-[0_0_0_2px_var(--bg-selected)]'
// design-tokens-allow: same zero-blur keyline, tracking the hover fill.
const DOT_KEYLINE_HOVER = 'group-hover:shadow-[0_0_0_2px_var(--bg-hover)]'

function DisclosureChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      // Rotation, not two glyphs: the flip is the same mark turning, so the
      // eye tracks one object rather than reading a substitution. Duration and
      // easing come from the shared motion scale; the rotation is the only
      // thing here that moves, so it is the only thing the reduced-motion
      // guard has to switch off — the state still reads from the angle.
      className={`size-icon-xs transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease)] motion-reduce:transition-none ${
        expanded ? 'rotate-180' : ''
      }`}
    >
      <path
        d="M4.5 6.5L8 10L11.5 6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ProviderRow({
  icon,
  health,
  badge,
  recessed = false,
  name,
  version,
  stateLine,
  enabled,
  onEnabledChange,
  expanded = false,
  onExpandedChange,
  actions,
  selected = false,
  onSelect,
  children,
  surface = 'page',
  as: Host = 'div',
  className,
}: ProviderRowProps) {
  const detailId = `${React.useId()}-detail`
  const inCard = surface === 'card'
  const disclosable = Boolean(onExpandedChange && children)
  const selectable = Boolean(onSelect) && !disclosable
  const switchable = typeof enabled === 'boolean' && Boolean(onEnabledChange)
  const open = disclosable && expanded

  const toggleExpanded = React.useCallback(() => {
    onExpandedChange?.(!expanded)
  }, [expanded, onExpandedChange])

  // The mark and the text: one unit, because whichever way a row is driven they
  // are driven together — the chevron's click target, the selection button's
  // face, or neither.
  const face = (
    <>
      <span
        className={[
          'relative mt-px grid size-icon-lg shrink-0 place-items-center',
          // A brand mark is an image, so its contrast step is opacity rather
          // than an ink token — the same move the sidebar makes on a row whose
          // folder is gone. It takes the whole slot, marks included, and that
          // is fine: a provider that is not here has nothing waiting on it, so
          // recessed and badged is not a state either axis can produce.
          recessed ? 'opacity-60' : '',
        ].join(' ')}
      >
        {icon}
        {/* The 6px health dot, docked on the mark's corner. aria-hidden: the
            state line carries the meaning, so the colour is never the only
            thing saying it. Absent `health`, the row draws none — see rule 4. */}
        {health ? (
          <span
            aria-hidden="true"
            className={[
              'absolute -left-0.5 -top-0.5 size-1.5 rounded-full',
              // Tracks the fill the face will actually take. A face that no
              // longer paints a hover fill must not ring its dot in the hover
              // colour either, or the keyline halos on a surface-coloured row.
              disclosable || selectable ? DOT_KEYLINE_HOVER : '',
              selected ? DOT_KEYLINE_SELECTED : inCard ? DOT_KEYLINE_RESTING_CARD : DOT_KEYLINE_RESTING,
            ].join(' ')}
            style={{ backgroundColor: STATUS_TONE_COLOR_VAR[health] }}
          />
        ) : null}
        {/* The corner count, on the opposite corner from the dot so a surface
            that somehow wants both still reads as two marks rather than one
            smudge. Its ring is `--bg-surface`, the ground these lists sit on —
            the primitive assumes the app ground, which is a different colour
            here (the app rail overrides it the same way for its canvas). */}
        {badge && badge.count > 0 ? (
          <Badge
            corner
            tone={badge.tone ?? 'accent'}
            count={badge.count}
            max={99}
            ariaLabel={badge.label}
            className={inCard ? 'border-[color:var(--bg-surface-raised)]' : 'border-[color:var(--bg-surface)]'}
          />
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {/* Name and version are a baseline PAIR — neither grows, so they
              stay adjacent instead of the version drifting to the far edge on
              a row with no trailing controls. Both may truncate; flex shrink
              is proportional to content, so a `--version` that prints a whole
              sentence (GNU bash) absorbs nearly all of it and the name
              survives. The 45% cap is the backstop for the pathological case
              an uncapped slot got wrong: a one-letter name beside a full
              sentence of version output. */}
          <span
            className={`min-w-0 truncate text-body font-semibold ${
              recessed ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-strong)]'
            }`}
          >
            {name}
          </span>
          {version ? (
            <span
              title={version}
              className="min-w-0 max-w-[45%] truncate font-mono text-micro tabular-nums text-[color:var(--text-subtle)]"
            >
              {version}
            </span>
          ) : null}
        </span>
        <span className="mt-px block text-meta leading-[var(--text-line-default)] text-[color:var(--text-muted)]">
          {stateLine}
        </span>
      </span>
    </>
  )

  return (
    <Host className={className ?? ''}>
      {/* Mouse users get the whole row as the hit target; the chevron is the
          only focusable control for it, so there is exactly one tab stop and
          one aria-expanded per row rather than a row-button wrapping a
          button. A selectable row spends that one tab stop on its face button
          instead, and its trailing action keeps its own. The face announces
          `aria-pressed`, not `aria-expanded`: selection is a toggled state of
          the row, and "expanded" belongs to the chevron's disclosure only —
          a reader hearing "expanded" on a face with no pane is being lied to. */}
      <div
        {...(disclosable ? { onClick: toggleExpanded } : {})}
        className={[
          // 12px vertical padding, no border. Loose on a page the radius only
          // shows under the hover fill, so it matches the fill rather than
          // drawing a box; in a card there is no radius at all — the card
          // clips, and the fill runs edge to edge like every other card row.
          'group flex items-start gap-3 py-3',
          inCard ? 'px-4' : 'rounded-[var(--radius-sm)] px-2.5',
          // The crossfade is a raw utility rather than `.interactive` because
          // `.interactive` also carries the 0.97 press scale, which belongs to
          // a button and not to a full-width row. That means the shared
          // reduced-motion guard does not reach it, so the row names its own.
          'transition-colors duration-[var(--motion-fast)] motion-reduce:transition-none',
          // Hover fill only where the face is actually actionable. In this
          // system a row that lights up says "you can act on me" — a marketplace
          // row whose only control is its Get button, or an onboarding row with
          // nothing behind a chevron, must not make that promise.
          disclosable || selectable ? 'cursor-pointer hover:bg-[color:var(--bg-hover)]' : '',
          selected ? 'bg-[color:var(--bg-selected)]' : '',
        ].join(' ')}
      >
        {selectable ? (
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`Show details for ${name}`}
            className={`flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-xs)] text-left ${FOCUS_RING_CLASS}`}
          >
            {face}
          </button>
        ) : (
          face
        )}

        {actions || disclosable || switchable ? (
          <span
            className="mt-0.5 flex shrink-0 items-center gap-2.5"
            // The trailing cluster owns its own clicks: a switch flip or an
            // Install press must not also toggle the row's disclosure.
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
            {disclosable ? (
              <button
                type="button"
                onClick={toggleExpanded}
                aria-expanded={open}
                // Only while open: the panel is deliberately unmounted when
                // closed (the per-instance forms behind it probe on mount), and
                // aria-controls pointing at an id that is not in the document
                // is a broken reference rather than a harmless one.
                aria-controls={open ? detailId : undefined}
                aria-label={`${name} details`}
                // The glyph stays 13px and the button pads out to the
                // hit-target floor around it, per foundations/principles.md
                // ("a small glyph pads out to it with a transparent hit area
                // rather than shrinking its target"). Drawn size and target
                // size are different numbers.
                className={`interactive grid size-[var(--hit-target-min)] place-items-center rounded-[var(--radius-xs)] text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
              >
                <DisclosureChevron expanded={open} />
              </button>
            ) : null}
            {switchable ? (
              <Switch
                checked={enabled as boolean}
                onChange={onEnabledChange as (next: boolean) => void}
                ariaLabel={`${name} enabled`}
              />
            ) : null}
          </span>
        ) : null}
      </div>

      {/* Kept mounted only while open: the per-instance forms behind this
          disclosure run probes and IPC reads on mount, so a hidden-but-mounted
          expansion would have every row probing at once.

          pl-11 = the row's own 10px inset + the 22px mark + the 12px gap, so
          the detail starts on the same left edge as the name above it. In a
          card the inset is 16px, so the same sum is 50px.
          design-tokens-allow: alignment — the detail's left edge is the name's (inset + 22px mark + 12px gap), structure not rhythm */}
      {open ? (
        <div id={detailId} className={inCard ? 'pb-3 pl-[50px] pr-4' : 'pb-3 pl-11 pr-2.5'}>
          {children}
        </div>
      ) : null}
    </Host>
  )
}
