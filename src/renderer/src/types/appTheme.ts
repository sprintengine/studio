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

import type { SelectItem } from '../components/ui'

export type AppTheme = 'system' | 'dark' | 'light' | 'slate' | 'conifer' | 'caramel'

// The concrete themes that <html data-theme="…"> can actually carry. `system`
// is a user preference that resolves to one of these at mount time.
export type ResolvedAppTheme = Exclude<AppTheme, 'system'>

type AppThemeDescriptor = {
  id: AppTheme
  label: string
  // null for the `system` row (the user preference that defers to OS); the
  // resolved theme id otherwise. Used by the picker, the normalizer, and
  // useAppTheme's resolveTheme() helper.
  resolved: ResolvedAppTheme | null
}

export const APP_THEMES: readonly AppThemeDescriptor[] = [
  { id: 'system', label: 'Match system', resolved: null },
  { id: 'dark', label: 'Dark (default)', resolved: 'dark' },
  { id: 'light', label: 'Light', resolved: 'light' },
  { id: 'slate', label: 'Slate', resolved: 'slate' },
  { id: 'conifer', label: 'Dark Conifer', resolved: 'conifer' },
  { id: 'caramel', label: 'Caramel', resolved: 'caramel' },
]

export const APP_THEME_IDS: readonly AppTheme[] = APP_THEMES.map((t) => t.id)

export const APP_THEME_SELECT_ITEMS: SelectItem<AppTheme>[] = APP_THEMES.map(
  (t) => ({ value: t.id, label: t.label }),
)

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEME_IDS as readonly string[]).includes(value)
}

export type AppearanceSettings = {
  theme: AppTheme
}
