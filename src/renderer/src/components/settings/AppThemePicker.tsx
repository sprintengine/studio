import React, { useCallback, useRef } from 'react'
import { APP_THEMES, colorSchemeForResolvedTheme, type AppTheme, type ThemeSwatches } from '../../types/appTheme'
import { CardButton, TruncatedText } from '../ui'

type AppThemePickerProps = {
  value: AppTheme
  onChange: (next: AppTheme) => void
}

// Visual theme picker (2026-09-06). A grid of cards, each
// one a round swatch — the theme's canvas graded into its surface, with its
// accent as the one dot — over the theme's name. Nothing else: the earlier
// card carried a description, a feature-glyph row and a mini chrome mock,
// and nineteen of them read as a wall. A sun or moon on the swatch's corner
// says light or dark, which is the one fact a person picks on.
//
// Accessibility:
//   * `role="radiogroup"` with `role="radio"` per card.
//   * Single tab stop into the group (the selected card, or first card if
//     none selected). Arrow keys move focus AND selection — theme switching
//     is non-destructive so live-preview-on-arrow is the right pattern.
//   * Home/End jump to first/last. Space and Enter activate the focused
//     card (redundant with arrow-selects-immediately but keeps the
//     standard radio contract).
function AppThemePicker({ value, onChange }: AppThemePickerProps) {
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
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {themes.map((theme, index) => {
        const isSelected = value === theme.id
        const scheme = theme.resolved ? colorSchemeForResolvedTheme(theme.resolved) : null
        return (
          <CardButton
            key={theme.id}
            ref={(node) => {
              buttonRefs.current[index] = node
            }}
            variant="bordered"
            // Selection is neutral: the kit tile's fill, strong edge and inset
            // selection ring, never the accent — an accent ring on an unfocused
            // card read as focus, and spent the one solid hue on a resting state.
            selected={isSelected}
            role="radio"
            aria-checked={isSelected}
            // The tile's own `selected` would also emit `aria-pressed`; a radio
            // states its state as `aria-checked`, and two would be read twice.
            aria-pressed={undefined}
            aria-label={scheme ? `${theme.label}, ${scheme}` : theme.label}
            tabIndex={index === fallbackTabIndex ? 0 : -1}
            onClick={() => onChange(theme.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className="items-center gap-2.5 px-3 pb-3 pt-4"
          >
            {theme.swatches ? <ThemeSwatch swatches={theme.swatches} scheme={scheme ?? 'dark'} /> : <SystemSwatch />}
            <TruncatedText
              as="span"
              text={theme.label}
              className={`w-full text-center text-body ${
                isSelected ? 'font-medium text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
              }`}
            />
          </CardButton>
        )
      })}
    </div>
  )
}

// The round swatch: the canvas as the outer ring, the surface as the disc
// inside it, the accent as one dot, and the scheme glyph on the corner. Solid
// fills, no gradient — the ramp reads as two concentric surfaces, which is
// what it is. The hex values are the theme's own (types/appTheme.ts): the
// picker paints every theme while the document wears one of them, so it
// cannot read the others off :root.
function ThemeSwatch({ swatches, scheme }: { swatches: ThemeSwatches; scheme: 'light' | 'dark' }) {
  return (
    <span aria-hidden="true" className="relative block size-14">
      <span
        className="flex size-full items-center justify-center rounded-full border border-[color:var(--border-subtle)]"
        style={{ backgroundColor: swatches.bgApp }}
      >
        <span className="block size-10 rounded-full" style={{ backgroundColor: swatches.bgSurface }} />
      </span>
      <span
        className="absolute bottom-2 right-2 block size-2.5 rounded-full"
        style={{ backgroundColor: swatches.accent }}
      />
      <span className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] text-[color:var(--text-muted)]">
        {scheme === 'light' ? <SunGlyph /> : <MoonGlyph />}
      </span>
    </span>
  )
}

// `Match system` has no palette of its own: a monitor in the same round frame.
function SystemSwatch() {
  return (
    <span
      aria-hidden="true"
      className="flex size-14 items-center justify-center rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="icon-lg"
      >
        <rect x="3" y="4.5" width="18" height="12.5" rx="1.5" />
        <path d="M8.5 20.5h7M12 17v3.5" />
      </svg>
    </span>
  )
}

function SunGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      className="icon-xs"
    >
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </svg>
  )
}

function MoonGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs">
      <path d="M6.6 2.2a5.9 5.9 0 0 0 7.3 7.4 6.5 6.5 0 1 1-7.3-7.4z" />
    </svg>
  )
}

export default AppThemePicker
