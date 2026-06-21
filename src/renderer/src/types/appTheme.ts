// Single source of truth for the JavaScript side of the theme system.
//
// The CSS contract (the actual color values per theme) lives in
// `src/renderer/src/assets/index.css` under the four `:root[data-theme="..."]`
// blocks. This file owns everything else: the id list, user-facing labels,
// the resolved-vs-user-preference relationship, type unions, normalizer, and
// the Select option list that the picker renders.
//
// Adding a new theme:
//   1. Add a row to APP_THEMES below.
//   2. Add the matching `:root[data-theme="<id>"]` block in index.css.
//   3. Add the literal id string to the boot script in
//      `src/renderer/index.html` (it can't import bundled code).
// Nothing else needs to change.

type SelectItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
}

export type AppTheme =
  | 'system'
  | 'dark'
  | 'light'
  | 'paper'
  | 'vellum'
  | 'herbarium'
  | 'verdigris'
  | 'slate'
  | 'conifer'
  | 'caramel'
  | 'lantern'
  | 'aubergine'
  | 'tokyo-night'
  | 'rose-pine'
  | 'ayu-mirage'
  | 'gruvbox'

// The concrete themes that <html data-theme="…"> can actually carry. `system`
// is a user preference that resolves to one of these at mount time.
export type ResolvedAppTheme = Exclude<AppTheme, 'system'>

// Swatch tuple for the visual picker thumbnail. Mirrors the five most
// representative tokens of each theme — surface ramp + accent + foreground.
// Hard-coded here (rather than read from CSS at runtime) because the picker
// renders these as inline style backgrounds while the user is on any
// other theme; we can't read another theme's --bg-app off the live :root.
// This module is outside the design-tokens lint scope so the hex literals
// below don't trip the no-inline-hex guard.
export type ThemeSwatches = {
  bgApp: string
  bgSurface: string
  bgSurfaceRaised: string
  accent: string
  textStrong: string
}

type AppThemeDescriptor = {
  id: AppTheme
  label: string
  // null for the `system` row (the user preference that defers to OS); the
  // resolved theme id otherwise. Used by the picker, the normalizer, and
  // useAppTheme's resolveTheme() helper.
  resolved: ResolvedAppTheme | null
  // One-line description shown in the visual picker beneath the swatches.
  description?: string
  // Feature flags surfaced as glyphs in the visual picker. Anti-dither is
  // not a flag because every theme is anti-dither baseline — the multiples-
  // of-4 channel discipline is applied across the catalogue, not a sticker
  // on individual themes.
  lowBlueLight?: boolean
  // Swatch tuple for the visual preview. Omitted on the `system` row, which
  // renders an OS-monitor glyph instead of a color preview.
  swatches?: ThemeSwatches
}

export const APP_THEMES: readonly AppThemeDescriptor[] = [
  {
    id: 'system',
    label: 'Match system',
    resolved: null,
    description: 'Follows your OS preference',
  },
  {
    id: 'dark',
    label: 'Dark',
    resolved: 'dark',
    description: 'Calm neutral ink, green accent',
    swatches: {
      bgApp: '#08080c',
      bgSurface: '#0c0c10',
      bgSurfaceRaised: '#101418',
      accent: '#3f9468',
      textStrong: '#ececec',
    },
  },
  {
    id: 'light',
    label: 'Light',
    resolved: 'light',
    description: 'Cool-neutral white, green accent',
    swatches: {
      bgApp: '#eaeef2',
      bgSurface: '#ffffff',
      bgSurfaceRaised: '#ffffff',
      accent: '#2f6a4a',
      textStrong: '#202428',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    resolved: 'paper',
    description: 'Warm cream and sage, green accent',
    swatches: {
      bgApp: '#f4f1e8',
      bgSurface: '#fbf9f2',
      bgSurfaceRaised: '#fdfcf7',
      accent: '#2f6a4a',
      textStrong: '#191613',
    },
  },
  {
    id: 'vellum',
    label: 'Vellum',
    resolved: 'vellum',
    description: 'Warm vintage parchment',
    swatches: {
      bgApp: '#e8e0d0',
      bgSurface: '#f4ece0',
      bgSurfaceRaised: '#fcf4e8',
      accent: '#b04428',
      textStrong: '#2c2418',
    },
  },
  {
    id: 'verdigris',
    label: 'Verdigris',
    resolved: 'verdigris',
    description: 'Dark forest-green parchment',
    swatches: {
      bgApp: '#0c100c',
      bgSurface: '#101810',
      bgSurfaceRaised: '#142018',
      accent: '#c05038',
      textStrong: '#e0e8d4',
    },
  },
  {
    id: 'herbarium',
    label: 'Herbarium',
    resolved: 'herbarium',
    description: 'Sage-green parchment, warm cards',
    swatches: {
      bgApp: '#d4dcc0',
      bgSurface: '#f4ece0',
      bgSurfaceRaised: '#fcf4e8',
      accent: '#b04428',
      textStrong: '#242818',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    resolved: 'slate',
    description: 'VS Code / Cursor IDE grey',
    swatches: {
      bgApp: '#202020',
      bgSurface: '#242424',
      bgSurfaceRaised: '#2c2c30',
      accent: '#5c7cfc',
      textStrong: '#e8e8e8',
    },
  },
  {
    id: 'conifer',
    label: 'Dark Conifer',
    resolved: 'conifer',
    description: 'Muted sage forest',
    swatches: {
      bgApp: '#141814',
      bgSurface: '#1c201c',
      bgSurfaceRaised: '#20241c',
      accent: '#c8a458',
      textStrong: '#b4c0b0',
    },
  },
  {
    id: 'caramel',
    label: 'Caramel',
    resolved: 'caramel',
    description: 'Vintage workshop warm',
    swatches: {
      bgApp: '#181408',
      bgSurface: '#241c10',
      bgSurfaceRaised: '#302414',
      accent: '#5c7cfc',
      textStrong: '#f4ecd8',
    },
  },
  {
    id: 'lantern',
    label: 'Lantern',
    resolved: 'lantern',
    description: 'Late-night warm amber',
    lowBlueLight: true,
    swatches: {
      bgApp: '#181408',
      bgSurface: '#1c1810',
      bgSurfaceRaised: '#242018',
      accent: '#e8a850',
      textStrong: '#f4e8c8',
    },
  },
  {
    id: 'aubergine',
    label: 'Aubergine',
    resolved: 'aubergine',
    description: 'Discord-style purple-grey',
    swatches: {
      bgApp: '#14141c',
      bgSurface: '#1c1c24',
      bgSurfaceRaised: '#242430',
      accent: '#8c7cfc',
      textStrong: '#d0c8e0',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    resolved: 'tokyo-night',
    description: 'Muted blue night coding',
    swatches: {
      bgApp: '#181824',
      bgSurface: '#1c1c28',
      bgSurfaceRaised: '#24283c',
      accent: '#7cb4fc',
      textStrong: '#c0c8dc',
    },
  },
  {
    id: 'rose-pine',
    label: 'Rose Pine',
    resolved: 'rose-pine',
    description: 'Soft mauve and rose',
    swatches: {
      bgApp: '#181420',
      bgSurface: '#1c1828',
      bgSurfaceRaised: '#241c34',
      accent: '#d488a0',
      textStrong: '#e0d4dc',
    },
  },
  {
    id: 'ayu-mirage',
    label: 'Ayu Mirage',
    resolved: 'ayu-mirage',
    description: 'Muted dark with golden accents',
    swatches: {
      bgApp: '#1c2030',
      bgSurface: '#202434',
      bgSurfaceRaised: '#242838',
      accent: '#fccc6c',
      textStrong: '#ccd0d8',
    },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox Dark',
    resolved: 'gruvbox',
    description: 'Retro warm sepia',
    swatches: {
      bgApp: '#1c1c18',
      bgSurface: '#282824',
      bgSurfaceRaised: '#3c3834',
      accent: '#fcb04c',
      textStrong: '#ecdcb4',
    },
  },
]

export const APP_THEME_IDS: readonly AppTheme[] = APP_THEMES.map((t) => t.id)

export type ColorScheme = 'light' | 'dark'

const APP_THEME_BY_ID: ReadonlyMap<AppTheme, AppThemeDescriptor> = new Map(
  APP_THEMES.map((t) => [t.id, t]),
)

// Perceived luminance (Rec. 601) of a #rrggbb hex; ~0–1.
function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

// Light/dark surface of a resolved theme, derived from its swatch canvas so it
// never drifts as themes are added: a theme whose `bgApp` reads as a light
// surface is a light theme. Used to tell the main process which scheme to launch
// agent CLIs in. Defaults to 'dark' for any theme missing a swatch.
export function colorSchemeForResolvedTheme(resolved: ResolvedAppTheme): ColorScheme {
  const bgApp = APP_THEME_BY_ID.get(resolved)?.swatches?.bgApp
  if (!bgApp) return 'dark'
  return hexLuminance(bgApp) > 0.5 ? 'light' : 'dark'
}

export const APP_THEME_SELECT_ITEMS: SelectItem<AppTheme>[] = APP_THEMES.map(
  (t) => ({ value: t.id, label: t.label }),
)

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEME_IDS as readonly string[]).includes(value)
}

export type AppearanceSettings = {
  theme: AppTheme
}
