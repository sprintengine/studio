import React from 'react'

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
// Three rules the props enforce rather than suggest:
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
   *  Never enablement, and never derived from it. */
  health: StatusTone
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
  /** The per-instance detail revealed by the chevron. */
  children?: React.ReactNode
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
  name,
  version,
  stateLine,
  enabled,
  onEnabledChange,
  expanded = false,
  onExpandedChange,
  actions,
  selected = false,
  children,
  className,
}: ProviderRowProps) {
  const detailId = `${React.useId()}-detail`
  const disclosable = Boolean(onExpandedChange && children)
  const switchable = typeof enabled === 'boolean' && Boolean(onEnabledChange)
  const open = disclosable && expanded

  const toggleExpanded = React.useCallback(() => {
    onExpandedChange?.(!expanded)
  }, [expanded, onExpandedChange])

  return (
    <div className={className ?? ''}>
      {/* Mouse users get the whole row as the hit target; the chevron is the
          only focusable control for it, so there is exactly one tab stop and
          one aria-expanded per row rather than a row-button wrapping a
          button. */}
      <div
        {...(disclosable ? { onClick: toggleExpanded } : {})}
        className={[
          // 12px vertical padding, no border. The radius only shows under the
          // hover fill, so it matches the fill rather than drawing a box.
          'group flex items-start gap-3 rounded-[var(--radius-sm)] px-2.5 py-3',
          'transition-colors duration-[var(--motion-fast)] hover:bg-[color:var(--bg-hover)]',
          selected ? 'bg-[color:var(--bg-selected)]' : '',
          disclosable ? 'cursor-pointer' : '',
        ].join(' ')}
      >
        <span className="relative mt-px grid size-icon-lg shrink-0 place-items-center">
          {icon}
          {/* The 6px health dot, docked on the mark's corner. aria-hidden: the
              state line carries the meaning, so the colour is never the only
              thing saying it. */}
          <span
            aria-hidden="true"
            className={[
              'absolute -left-0.5 -top-0.5 size-1.5 rounded-full',
              DOT_KEYLINE_HOVER,
              selected ? DOT_KEYLINE_SELECTED : DOT_KEYLINE_RESTING,
            ].join(' ')}
            style={{ backgroundColor: STATUS_TONE_COLOR_VAR[health] }}
          />
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
            <span className="min-w-0 truncate text-body font-semibold text-[color:var(--text-strong)]">
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
                aria-controls={detailId}
                aria-label={`${name} details`}
                className={`interactive rounded-[var(--radius-xs)] p-0.5 text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
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
          the detail starts on the same left edge as the name above it. */}
      {open ? (
        <div id={detailId} className="pb-3 pl-11 pr-2.5">
          {children}
        </div>
      ) : null}
    </div>
  )
}
