import { useEffect, useSyncExternalStore } from 'react'
import {
  ensureProjectLogo,
  getProjectLogoDataUrl,
  subscribeProjectLogos,
} from '../utils/projectLogos'

/**
 * The project's own logo for an icon slot (MC-2135), or null when the repo has
 * none — which is every caller's cue to keep rendering the workspace-type
 * glyph. Detection runs once per folder per session and is shared across every
 * surface that asks.
 */
export function useProjectLogo(folderPath: string | null | undefined): string | null {
  useEffect(() => {
    ensureProjectLogo(folderPath, (path) => window.api.detectProjectLogo(path))
  }, [folderPath])

  return useSyncExternalStore(
    subscribeProjectLogos,
    () => getProjectLogoDataUrl(folderPath),
    () => null,
  )
}
