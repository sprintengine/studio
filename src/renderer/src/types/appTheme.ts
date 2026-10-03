// Single source of truth for the JavaScript side of the theme system.
//
// The CSS contract (the actual color values per theme) lives in
// `src/renderer/src/assets/index.css` under the `:root[data-theme="..."]`
// blocks. The catalogue was cut to eleven on 2026-09-06 (owner): a picker of
// nineteen read as a wall, and the themes that went were the ones nobody could
// tell apart from a neighbour. This file owns everything else: the id list, user-facing labels,
// the resolved-vs-user-preference relationship, type unions, normalizer, and
// the Select option list that the picker renders.
//
// Adding a new theme:
//   1. Add a row to APP_THEMES below.
//   2. Add the matching `:root[data-theme="<id>"]` block in index.css.
//   3. Only if it paints a light surface: add the literal id to LIGHT_SURFACES
//      in the boot script in `src/renderer/public/boot-theme.js` (it can't import bundled
//      code). LIGHT_SURFACE_THEMES below derives itself from the swatches.
// Nothing else needs to change.

export type AppTheme =
  | 'system'
  | 'dark'
  | 'light'
  | 'paper'
  | 'vellum'
  | 'herbarium'
  | 'herbarium-dark'
  | 'slate'
  | 'sage'
  | 'lantern'
  | 'tokyo-night'
  | 'rose-pine'

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
    id: 'herbarium-dark',
    label: 'Herbarium Dark',
    resolved: 'herbarium-dark',
    description: 'Dark slate, sage-green accent',
    swatches: {
      bgApp: '#181c14',
      bgSurface: '#1c2018',
      bgSurfaceRaised: '#242820',
      accent: '#d4dcc0',
      textStrong: '#e4e8d8',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    resolved: 'slate',
    description: 'Neutral editor grey',
    swatches: {
      bgApp: '#202020',
      bgSurface: '#242424',
      bgSurfaceRaised: '#2c2c30',
      accent: '#5c7cfc',
      textStrong: '#e8e8e8',
    },
  },
  {
    id: 'sage',
    label: 'Sage',
    resolved: 'sage',
    description: 'Muted gray-green, terracotta accent',
    swatches: {
      bgApp: '#20241c',
      bgSurface: '#282c20',
      bgSurfaceRaised: '#303428',
      accent: '#c85838',
      textStrong: '#e8e8d4',
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
]

const APP_THEME_IDS: readonly AppTheme[] = APP_THEMES.map((t) => t.id)

export type ColorScheme = 'light' | 'dark'

const APP_THEME_BY_ID: ReadonlyMap<AppTheme, AppThemeDescriptor> = new Map(APP_THEMES.map((t) => [t.id, t]))

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

// The themes that paint a light surface: today `light`, `paper`, `vellum`, and
// `herbarium`. Derived from the same swatch luminance as the scheme above so a
// theme can never be light by one measure and dark by the other; a theme with
// no swatch counts as dark, matching the app's dark-default :root.
//
// This is the app's half of the polarity bridge to the design-system bundle.
// The bundle's bare :root is its LIGHT tier and its dark tier keys off
// `[data-mode="dark"]` — the inverse of index.css, whose bare :root is Dark —
// so <html> carries `data-mode` alongside `data-theme`. applyThemeAttributes()
// in hooks/useAppTheme.ts writes both; the boot script (public/boot-theme.js) stamps the
// same pair before any CSS evaluates.
export const LIGHT_SURFACE_THEMES: readonly ResolvedAppTheme[] = APP_THEMES.flatMap((t) =>
  t.resolved && colorSchemeForResolvedTheme(t.resolved) === 'light' ? [t.resolved] : [],
)

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEME_IDS as readonly string[]).includes(value)
}

// Window chrome material — a second appearance axis, orthogonal to the theme.
// 'glass' frosts the window canvas (sidebar, title strip, aside column) with
// OS-native vibrancy under the active theme's tint; macOS-only.
// 'tinted' paints the same canvas opaque, with a static, heavily feathered
// wash in the colours of what sits on it — the foreground under the rail and
// the title band, the wordmark's own two inks behind it, and no control of its
// own — the premium ground for platforms with no vibrancy,
// and an option on macOS for anyone who would rather not have glass (owner
// ruling 2026-09-24). 'solid' is the plain opaque canvas.
const WINDOW_MATERIALS = ['solid', 'glass', 'tinted'] as const
export type WindowMaterial = (typeof WINDOW_MATERIALS)[number]

export function isWindowMaterial(value: unknown): value is WindowMaterial {
  return typeof value === 'string' && (WINDOW_MATERIALS as readonly string[]).includes(value)
}

// The material a stored preference paints on this platform. The stored default
// is 'glass' — "the premium material" — and where the OS has no vibrancy the
// premium material is tinted, so glass resolves to tinted off macOS. That is
// also how every existing Windows and Linux profile, which holds the untouched
// glass default, lands on tinted without a migration. An explicit solid or
// tinted is honoured everywhere.
export function effectiveWindowMaterial(material: WindowMaterial, platform: string | undefined): WindowMaterial {
  return material === 'glass' && platform !== 'darwin' ? 'tinted' : material
}

// How far the conversation column may grow. `full` is the pane's own width —
// the chat's shape before this setting existed, and so the default: a new
// setting that re-lays everyone's transcript is a change nobody asked for.
// The other two cap the transcript and the composer together at a reading
// measure and centre them, the scrollbar staying at the pane's edge.
const CHAT_WIDTHS = ['comfortable', 'wide', 'full'] as const
export type ChatWidth = (typeof CHAT_WIDTHS)[number]
export const DEFAULT_CHAT_WIDTH: ChatWidth = 'full'

export function isChatWidth(value: unknown): value is ChatWidth {
  return typeof value === 'string' && (CHAT_WIDTHS as readonly string[]).includes(value)
}

// The chat's text contrast, in percent of the theme's own inks: under 100 the
// inks fade toward the chat's background, over 100 they move away from it.
// Five-point steps, so the value the slider names is always one it can reach.
// The floor is measured, not picked: 85 is the lowest step at which body text
// still clears 4.5:1 against the chat surface in every theme (herbarium, the
// theme with the least contrast to give, is 4.9:1 there and 4.4:1 at 80). Dark
// and light alone would allow 75, but a floor that holds only in some themes
// is a setting that silently breaks when the theme changes.
export const CHAT_CONTRAST_MIN = 85
export const CHAT_CONTRAST_MAX = 200
export const CHAT_CONTRAST_STEP = 5
export const DEFAULT_CHAT_CONTRAST = 100

/** A stored contrast as one the slider can show: on the ramp, on a step. */
export function normalizeChatContrast(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHAT_CONTRAST
  const stepped = Math.round(value / CHAT_CONTRAST_STEP) * CHAT_CONTRAST_STEP
  return Math.min(CHAT_CONTRAST_MAX, Math.max(CHAT_CONTRAST_MIN, stepped))
}

export type AppearanceSettings = {
  theme: AppTheme
  windowMaterial: WindowMaterial
  chatContrast: number
  chatWidth: ChatWidth
  // Draw each spawned agent as a small character that moves while it works.
  // Off, an agent is a working mark while it runs and a lifecycle glyph after.
  agentCharacters: boolean
}
