import React, { useCallback, useRef } from 'react'
import { APP_THEMES, type AppTheme, type ThemeSwatches } from '../../types/appTheme'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { Tooltip } from '../ui'

const ANTI_DITHER_TOOLTIP = 'Anti-temporal dithering'
const LOW_BLUE_TOOLTIP = 'Low blue light'

type AppThemePickerProps = {
  value: AppTheme
  onChange: (next: AppTheme) => void
}

// Visual theme picker — replaces the legacy Select dropdown. Cards lay out
// in a responsive grid (1 column narrow, 2 medium, 3 wide). Each card
// renders a miniature preview of the theme's surface ramp + accent + text,
// the theme name + description, optional feature glyphs (low-blue-light),
// and a selected-state indicator. Anti-dither is not surfaced as a glyph —
// every theme is anti-dither baseline.
//
// Accessibility:
//   * `role="radiogroup"` with `role="radio"` per card.
//   * Single tab stop into the group (the selected card, or first card if
//     none selected). Arrow keys move focus AND selection — theme switching
//     is non-destructive so live-preview-on-arrow is the right pattern.
//   * Home/End jump to first/last. Space and Enter activate the focused
//     card (redundant with arrow-selects-immediately but keeps the
//     standard radio contract).
export function AppThemePicker({ value, onChange }: AppThemePickerProps) {
  const themes = APP_THEMES
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const selectedIndex = themes.findIndex((t) => t.id === value)
  const fallbackTabIndex = selectedIndex === -1 ? 0 : selectedIndex

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      let nextIndex: number | null = null
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (currentIndex + 1) % themes.length
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (currentIndex - 1 + themes.length) % themes.length
          break
        case 'Home':
          nextIndex = 0
          break
        case 'End':
          nextIndex = themes.length - 1
          break
        case ' ':
        case 'Enter':
          event.preventDefault()
          onChange(themes[currentIndex].id)
          return
        default:
          return
      }
      event.preventDefault()
      onChange(themes[nextIndex].id)
      // Move keyboard focus to the newly-selected card so a screen reader
      // announces it and subsequent arrow keys keep navigating.
      requestAnimationFrame(() => {
        buttonRefs.current[nextIndex!]?.focus()
      })
    },
    [themes, onChange],
  )

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {themes.map((theme, index) => {
        const isSelected = value === theme.id
        // Full feature inventory in the aria-label so screen-reader users
        // hear "Lantern, low blue light, anti-temporal-dither" without
        // needing to interact with each glyph individually.
        const featureLabel = [
          theme.label,
          'anti-temporal-dither',
          theme.lowBlueLight ? 'low blue light' : null,
        ]
          .filter(Boolean)
          .join(', ')
        return (
          <button
            key={theme.id}
            ref={(node) => {
              buttonRefs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={featureLabel}
            tabIndex={index === fallbackTabIndex ? 0 : -1}
            onClick={() => onChange(theme.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={[
              'interactive group flex flex-col gap-2.5 rounded-md border p-3 text-left',
              'bg-[color:var(--bg-surface)] hover:bg-[color:var(--bg-hover)]',
              isSelected
                ? 'border-[color:var(--accent-primary)] ring-1 ring-[color:var(--accent-primary)]'
                : 'border-[color:var(--border-default)]',
              FOCUS_RING_CLASS,
            ].join(' ')}
          >
            {theme.swatches ? (
              <ThemePreview swatches={theme.swatches} />
            ) : (
              <SystemPreview />
            )}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                    {theme.label}
                  </span>
                  <ThemeGlyphs lowBlueLight={theme.lowBlueLight} />
                </div>
                {theme.description ? (
                  <p className="mt-0.5 truncate text-[11px] leading-4 text-[color:var(--text-muted)]">
                    {theme.description}
                  </p>
                ) : null}
              </div>
              {isSelected ? <SelectedCheckmark /> : null}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function ThemePreview({ swatches }: { swatches: ThemeSwatches }) {
  return (
    <div
      aria-hidden="true"
      className="relative h-16 w-full overflow-hidden rounded-[5px]"
      style={{ backgroundColor: swatches.bgApp }}
    >
      {/* Inner "panel" — bg-surface inside bg-app, mimicking real chrome. */}
      <div
        className="absolute inset-1.5 overflow-hidden rounded-[3px]"
        style={{ backgroundColor: swatches.bgSurface }}
      >
        {/* Strong text line. */}
        <div
          className="absolute left-2 top-2 h-[3px] w-10 rounded-full"
          style={{ backgroundColor: swatches.textStrong, opacity: 0.92 }}
        />
        {/* Muted text line — same hex at lower opacity to mimic --text-muted. */}
        <div
          className="absolute left-2 top-[14px] h-[2px] w-6 rounded-full"
          style={{ backgroundColor: swatches.textStrong, opacity: 0.45 }}
        />
        {/* Accent button-like element. */}
        <div
          className="absolute bottom-1.5 right-1.5 h-3 w-8 rounded-sm"
          style={{ backgroundColor: swatches.accent }}
        />
        {/* Raised-surface chip (a smaller secondary surface). */}
        <div
          className="absolute bottom-1.5 left-1.5 h-3 w-3 rounded-sm"
          style={{ backgroundColor: swatches.bgSurfaceRaised, opacity: 0.95 }}
        />
      </div>
    </div>
  )
}

function SystemPreview() {
  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-full items-center justify-center rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="icon-lg text-[color:var(--text-muted)]"
      >
        <rect x="3" y="4" width="18" height="13" rx="1.5" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    </div>
  )
}

// Feature glyph row. Anti-temporal-dither is shown on every theme because
// it's a baseline property of the whole catalogue; the low-blue-light moon
// is shown only when the theme opts in. Each glyph is wrapped in the
// Tooltip primitive so hover gives the user the longer explanation.
// Glyphs themselves are `aria-hidden` — the parent button's `aria-label`
// already announces the features for screen-reader users, so we don't
// double-announce them here.
function ThemeGlyphs({ lowBlueLight }: { lowBlueLight?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <Tooltip content={ANTI_DITHER_TOOLTIP}>
        <span className="inline-flex" tabIndex={-1} aria-hidden="true">
          <AntiDitherGlyph />
        </span>
      </Tooltip>
      {lowBlueLight ? (
        <Tooltip content={LOW_BLUE_TOOLTIP}>
          <span className="inline-flex" tabIndex={-1} aria-hidden="true">
            <LowBlueLightGlyph />
          </span>
        </Tooltip>
      ) : null}
    </span>
  )
}

// Eye-in-circle glyph — "safe for eyes." Outer ring = protection; inner
// almond + pupil = vision. Reads as "eye safety / no flicker."
function AntiDitherGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon-xs shrink-0 text-[color:var(--text-muted)]"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M3.6 8s1.6-2.6 4.4-2.6S12.4 8 12.4 8s-1.6 2.6-4.4 2.6S3.6 8 3.6 8z" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

// Crescent moon — low blue light / night-shift family.
function LowBlueLightGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className="icon-xs shrink-0 text-[color:var(--text-muted)]"
    >
      <path d="M6.6 2.2a5.9 5.9 0 0 0 7.3 7.4 6.5 6.5 0 1 1-7.3-7.4z" />
    </svg>
  )
}

function SelectedCheckmark() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon-sm shrink-0 text-[color:var(--accent-primary)]"
    >
      <path d="M3.5 8.5l3 3 6-6.5" />
    </svg>
  )
}

export default AppThemePicker
