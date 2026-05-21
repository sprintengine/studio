import { useEffect } from 'react'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { AppTheme, ResolvedAppTheme } from '../types/appTheme'

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
