import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  colorSchemeForResolvedTheme,
  type AppTheme,
  type ColorScheme,
  type ResolvedAppTheme,
} from '../types/appTheme'

export type { ResolvedAppTheme }

const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)'

function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(LIGHT_MEDIA_QUERY).matches
}

export function resolveTheme(theme: AppTheme): ResolvedAppTheme {
  if (theme === 'system') return prefersLight() ? 'light' : 'dark'
  return theme
}

function applyTheme(resolved: ResolvedAppTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
  // Mirror the resolved light/dark scheme to main so newly-spawned agent CLIs
  // launch matching the app surface (e.g. Claude Code's --settings theme).
  // Best-effort: the API is absent in non-Electron/test contexts.
  void window.api?.setColorScheme?.(colorSchemeForResolvedTheme(resolved))
}

// Drives the <html data-theme="…"> attribute from the persisted preference.
// Mount once near the root of the React tree. The boot-time script in
// index.html applies the same logic synchronously to avoid a flash of the
// wrong theme before React mounts.
export function useAppTheme(): void {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)

  useEffect(() => {
    applyTheme(resolveTheme(theme))

    if (theme !== 'system') return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }
    const media = window.matchMedia(LIGHT_MEDIA_QUERY)
    const onChange = (): void => applyTheme(resolveTheme('system'))
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Safari < 14 fallback.
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [theme])
}

// Resolved light/dark surface of the active theme, reactive to both an explicit
// theme change and — under `system` — an OS light/dark switch (the store value
// stays `'system'`, so the media query is the only signal). Editor surfaces that
// must pick a matching base theme read this instead of the raw preference.
export function useResolvedColorScheme(): ColorScheme {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    colorSchemeForResolvedTheme(resolveTheme(theme))
  )

  useEffect(() => {
    setScheme(colorSchemeForResolvedTheme(resolveTheme(theme)))

    if (theme !== 'system') return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }
    const media = window.matchMedia(LIGHT_MEDIA_QUERY)
    const onChange = (): void => setScheme(colorSchemeForResolvedTheme(resolveTheme('system')))
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Safari < 14 fallback.
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [theme])

  return scheme
}

// Monaco ships only a light (`vs`) and dark (`vs-dark`) built-in base theme, so
// map the active app theme's surface onto the matching one. Without this an
// editor renders its hard-coded dark canvas inside a light app — the mismatch
// users see as a "dark panel" spawned from a light window (and the reverse).
export function useMonacoBaseTheme(): 'vs' | 'vs-dark' {
  return useResolvedColorScheme() === 'light' ? 'vs' : 'vs-dark'
}
