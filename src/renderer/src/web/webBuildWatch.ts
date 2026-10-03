import { WEB_BUILD_META } from '../../../shared/web-client'
import { showToast, useToastStore } from '../store/toastStore'
import { isWindowVisible } from '../utils/windowActivity'
import { WEB_TUNNEL_REOPENED_EVENT, watchWebReconnectTriggers } from './webReconnect'
import { webPageUrl } from './webLocation'

// A tab loaded from a bundle the server no longer serves (phase 9 spec, 3.5
// and 14.11). The page is served by the server it talks to, so the two match
// at load; after the server is upgraded, or its web client rebuilt, the tab
// keeps working inside the protocol window, but its next lazily loaded chunk
// may be gone. So the tab asks which bundle is served whenever it comes back
// (its tunnel reopened, the page visible or online again) and every few
// minutes while it is seen, and offers a reload once per new bundle: the
// app-update toast's form in a browser, where the update is a reload away.

const POLL_MS = 10 * 60 * 1000
const TOAST_ID = 'web-build-changed'

export function ownWebBuildId(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${WEB_BUILD_META}"]`)?.content || null
}

export async function servedWebBuildId(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(webPageUrl('api/session'), { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { build?: unknown }
    return typeof body.build === 'string' ? body.build : null
  } catch {
    return null
  }
}

/** Decides, per answer, whether to offer a reload: only for a build that differs and was not offered yet. */
export function createWebBuildSkewCheck(own: string | null): (served: string | null) => boolean {
  const offered = new Set<string>()
  return (served) => {
    if (!own || !served || served === own || offered.has(served)) return false
    offered.add(served)
    return true
  }
}

export function startWebBuildWatch(): () => void {
  const shouldOffer = createWebBuildSkewCheck(ownWebBuildId())
  let checking = false
  const check = async () => {
    if (checking) return
    checking = true
    try {
      if (!shouldOffer(await servedWebBuildId())) return
      showToast({
        id: TOAST_ID,
        tone: 'good',
        title: 'Studio was updated',
        description: 'Reload this tab to use the new version. Until then it keeps working as it is.',
        autoDismissMs: false,
        actions: [
          { id: 'later', label: 'Later', run: () => useToastStore.getState().dismissToast(TOAST_ID) },
          { id: 'reload', label: 'Reload', primary: true, run: () => window.location.reload() },
        ],
      })
    } finally {
      checking = false
    }
  }
  const onReopened = () => void check()
  window.addEventListener(WEB_TUNNEL_REOPENED_EVENT, onReopened)
  const stopTriggers = watchWebReconnectTriggers(onReopened)
  const timer = setInterval(() => {
    if (isWindowVisible()) void check()
  }, POLL_MS)
  return () => {
    window.removeEventListener(WEB_TUNNEL_REOPENED_EVENT, onReopened)
    stopTriggers()
    clearInterval(timer)
  }
}
