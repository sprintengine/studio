import type { ITheme, Terminal } from '@xterm/xterm'

// xterm.js does not read CSS variables, so we resolve the theme-relevant
// tokens off `:root` at terminal-mount time and re-resolve whenever the
// `<html data-theme>` attribute changes. Each Terminal instance subscribes
// individually; the MutationObserver shared singleton broadcasts to every
// subscriber so all live terminals re-tint in lockstep.

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value || fallback
}

// xterm's default 16-color ANSI palette is tuned for dark backgrounds: its
// `white`/`brightWhite` (and the bright variants agents use for bold text)
// sit near #fff and vanish on a light surface. Themes with a light terminal
// background get this palette instead — darkened hues that hold WCAG-AA
// contrast on near-white. Derived from the GitHub light terminal palette.
const LIGHT_TERMINAL_ANSI: ITheme = {
  black: '#24292e',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#24292e',
  selectionBackground: 'rgba(56, 92, 252, 0.20)',
}

// xterm nudges any glyph whose fg/bg contrast falls below this ratio toward
// legibility, per cell. It is the only lever that also covers 256-color and
// truecolor output — syntax highlighting and dimmed tool-call / diff text the
// agent CLIs emit — which bypass the 16-color ANSI palette above and otherwise
// render as near-invisible pale ink on a light surface. Enforced (AAA 7:1)
// only on light terminal backgrounds; dark surfaces keep xterm's default (1 =
// off) so their already-legible, deliberately tuned output is untouched.
const LIGHT_TERMINAL_MIN_CONTRAST = 7
const DEFAULT_MIN_CONTRAST = 1

// Perceived luminance (Rec. 601). Returns false for any value we can't parse
// as a hex color, so unknown backgrounds keep the dark-tuned default palette.
function isLightBackground(color: string): boolean {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return false
  let hex = match[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
}

export function getTerminalTheme(): ITheme {
  // Terminals read from dedicated --terminal-* tokens so they can sit deeper
  // than the panel chrome. Fall back to the surface scale tokens for any theme
  // that hasn't declared terminal-specific values, preserving compatibility.
  const background = readVar('--terminal-bg', readVar('--bg-app', '#08090b'))
  const base: ITheme = {
    background,
    foreground: readVar('--terminal-fg', readVar('--text-strong', '#ececee')),
    cursor: readVar('--terminal-cursor', readVar('--accent-primary', '#5c7cff')),
  }
  // A light terminal surface needs the light ANSI palette or colored/bold agent
  // output washes out; dark surfaces keep xterm's default palette untouched.
  return isLightBackground(background) ? { ...base, ...LIGHT_TERMINAL_ANSI } : base
}

// Companion to getTerminalTheme: the contrast floor for the current surface.
// Set alongside the theme so 256-color / truecolor output stays legible on
// light backgrounds (see LIGHT_TERMINAL_MIN_CONTRAST).
export function getTerminalMinimumContrastRatio(): number {
  const background = readVar('--terminal-bg', readVar('--bg-app', '#08090b'))
  return isLightBackground(background) ? LIGHT_TERMINAL_MIN_CONTRAST : DEFAULT_MIN_CONTRAST
}

type Subscriber = () => void
const subscribers = new Set<Subscriber>()
let observer: MutationObserver | null = null

function ensureObserver(): void {
  if (observer || typeof window === 'undefined') return
  observer = new MutationObserver((mutations) => {
    if (!mutations.some((m) => m.attributeName === 'data-theme')) return
    for (const fn of subscribers) {
      try {
        fn()
      } catch {
        // Subscriber threw; keep notifying the rest.
      }
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

// Apply the current theme to `term`, then subscribe so the terminal re-tints
// on every `<html data-theme>` change. Returns a dispose function that
// removes the subscription. Call dispose alongside the existing terminal
// teardown.
export function bindTerminalTheme(term: Terminal): () => void {
  term.options.theme = getTerminalTheme()
  term.options.minimumContrastRatio = getTerminalMinimumContrastRatio()
  ensureObserver()
  const onChange: Subscriber = () => {
    term.options.theme = getTerminalTheme()
    term.options.minimumContrastRatio = getTerminalMinimumContrastRatio()
  }
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}
