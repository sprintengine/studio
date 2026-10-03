// The view's public styling contract (phase 9 spec, 5.3): a small set of
// `--se-*` custom properties, not Studio's internal token names, so a rename
// inside Studio does not break a page that themes the view. The defaults are
// the values of the design system's semantic tokens for each mode
// (design-system/foundations/tokens.tokens.json) at this package's release.

export const SE_TOKENS = [
  'bg',
  'surface',
  'well',
  'border',
  'text',
  'text-muted',
  'link',
  'accent',
  'danger',
  'font-body',
  'font-mono',
  'font-size',
  'radius',
] as const

export type SeToken = (typeof SE_TOKENS)[number]

export type ConversationViewTheme = {
  mode?: 'light' | 'dark' | 'system'
  /** Values for any of the public tokens; the rest keep the mode's defaults. */
  tokens?: Partial<Record<SeToken, string>>
}

const FONTS = {
  'font-body': 'Inter, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  'font-mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  'font-size': '13px',
  radius: '7px',
}

export const SE_DEFAULTS: Record<'light' | 'dark', Record<SeToken, string>> = {
  light: {
    bg: '#eaeef2',
    surface: '#ffffff',
    well: 'rgba(32, 36, 40, 0.05)',
    border: 'rgba(32, 36, 40, 0.10)',
    text: '#202428',
    'text-muted': '#646c78',
    link: '#2f6a4a',
    accent: '#2f6a4a',
    danger: '#d92d2d',
    ...FONTS,
  },
  dark: {
    bg: '#08080c',
    surface: '#0c0c10',
    well: 'rgba(252, 252, 252, 0.06)',
    border: 'rgba(252, 252, 252, 0.06)',
    text: '#ececec',
    'text-muted': '#9c9ca4',
    link: '#3f9468',
    accent: '#3f9468',
    danger: '#fc787c',
    ...FONTS,
  },
}

/** A token's value is a CSS value, never a way out of the declaration it is set in. */
export function safeTokenValue(value: string): string | null {
  return /[;{}<>]|\/\*/u.test(value) || value.length > 200 ? null : value
}

/** The custom properties for a mode and a page's overrides, as a style object. */
export function themeStyle(
  mode: 'light' | 'dark',
  tokens: ConversationViewTheme['tokens'] = {},
): Record<string, string> {
  const style: Record<string, string> = {}
  for (const name of SE_TOKENS) {
    const override = tokens[name]
    const value = (override !== undefined ? safeTokenValue(override) : null) ?? SE_DEFAULTS[mode][name]
    style[`--se-${name}`] = value
  }
  return style
}

/**
 * The view's stylesheet, scoped to `.se-conversation`. In a shadow root it is
 * the only CSS the view sees; with `isolation="none"` it sits in
 * `@layer sprintengine`, so a page's own rules win where it wants them to.
 */
export const CONVERSATION_VIEW_CSS = `
.se-conversation { box-sizing: border-box; background: var(--se-bg); color: var(--se-text); font-family: var(--se-font-body); font-size: var(--se-font-size); line-height: 1.55; padding: 16px; }
.se-conversation *, .se-conversation *::before, .se-conversation *::after { box-sizing: inherit; }
.se-conversation .se-row { margin: 0 0 16px; }
.se-conversation .se-user { margin-left: auto; max-width: 80%; width: fit-content; background: var(--se-well); border-radius: var(--se-radius); padding: 8px 12px; white-space: pre-wrap; }
.se-conversation .se-byline { color: var(--se-text-muted); font-size: 0.92em; margin-bottom: 4px; }
.se-conversation .se-prose p { margin: 0 0 8px; }
.se-conversation .se-prose ul, .se-conversation .se-prose ol { margin: 0 0 8px; padding-left: 20px; }
.se-conversation .se-prose code, .se-conversation .se-steps code { font-family: var(--se-font-mono); font-size: 0.92em; background: var(--se-well); border-radius: 4px; padding: 0 4px; }
.se-conversation pre { font-family: var(--se-font-mono); font-size: 0.92em; background: var(--se-well); border: 1px solid var(--se-border); border-radius: var(--se-radius); padding: 8px 12px; overflow-x: auto; margin: 0 0 8px; white-space: pre; }
.se-conversation pre code { background: none; padding: 0; }
.se-conversation a { color: var(--se-link); }
.se-conversation .se-steps { list-style: none; margin: 4px 0 8px; padding: 0; color: var(--se-text-muted); font-size: 0.92em; }
.se-conversation .se-steps li { padding: 2px 0; }
.se-conversation .se-step-failed { color: var(--se-danger); }
.se-conversation .se-note { color: var(--se-text-muted); font-size: 0.92em; border-left: 2px solid var(--se-border); padding-left: 8px; }
.se-conversation .se-failed { color: var(--se-danger); }
.se-conversation .se-earlier { font: inherit; color: var(--se-link); background: none; border: 1px solid var(--se-border); border-radius: var(--se-radius); padding: 4px 10px; cursor: pointer; margin-bottom: 16px; }
.se-conversation .se-earlier:focus-visible { outline: 2px solid var(--se-accent); outline-offset: 2px; }
`
