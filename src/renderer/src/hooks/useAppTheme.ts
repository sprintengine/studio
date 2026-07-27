import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  colorSchemeForResolvedTheme,
  type AppTheme,
  type ColorScheme,
  type ResolvedAppTheme,
  type WindowMaterial,
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

function applyWindowMaterial(material: WindowMaterial): void {
  if (typeof document === 'undefined') return
  // Glass is macOS-only; collapse to solid elsewhere so a synced/copied
  // profile can never leave a translucent canvas over a non-vibrant window.
  const active = material === 'glass' && window.api?.platform === 'darwin'
  if (active) {
    document.documentElement.setAttribute('data-window-material', 'glass')
    // The boot script's opaque pre-paint on <html> would sit in front of the
    // window vibrancy; clear it so the frost shows (body carries the tint).
    document.documentElement.style.backgroundColor = ''
  } else {
    document.documentElement.removeAttribute('data-window-material')
  }
  // Mirror to main: persists for pre-boot application on the next launch and
  // re-applies vibrancy to live windows. Best-effort outside Electron.
  void window.api?.setWindowMaterial?.(active ? 'glass' : 'solid')
}

// Drives the <html data-theme="…"> attribute from the persisted preference.
// Mount once near the root of the React tree. The boot-time script in
// index.html applies the same logic synchronously to avoid a flash of the
// wrong theme before React mounts.
export function useAppTheme(): void {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const windowMaterial = useWorkspaceStore((s) => s.appSettings.appearance.windowMaterial)

  useEffect(() => {
    applyWindowMaterial(windowMaterial)
  }, [windowMaterial])

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

// The concrete resolved theme id of the active preference, reactive to both an
// explicit theme change and — under `system` — an OS light/dark switch (the
// store value stays `'system'`, so the media query is the only signal). Surfaces
// that key off the specific theme rather than just its light/dark scheme (e.g.
// per-theme backdrop plates) read this. Mirrors useResolvedColorScheme but
// returns the full id instead of collapsing to a scheme.
export function useResolvedTheme(): ResolvedAppTheme {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const [resolved, setResolved] = useState<ResolvedAppTheme>(() => resolveTheme(theme))

  useEffect(() => {
    setResolved(resolveTheme(theme))

    if (theme !== 'system') return undefined
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined
    }
    const media = window.matchMedia(LIGHT_MEDIA_QUERY)
    const onChange = (): void => setResolved(resolveTheme('system'))
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // Safari < 14 fallback.
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [theme])

  return resolved
}

// Monaco ships only a light (`vs`) and dark (`vs-dark`) built-in base theme, so
// map the active app theme's surface onto the matching one. Without this an
// editor renders its hard-coded dark canvas inside a light app — the mismatch
// users see as a "dark panel" spawned from a light window (and the reverse).
export function useMonacoBaseTheme(): 'vs' | 'vs-dark' {
  return useResolvedColorScheme() === 'light' ? 'vs' : 'vs-dark'
}
