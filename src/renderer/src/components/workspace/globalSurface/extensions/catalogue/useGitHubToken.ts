// Whether this machine has a GitHub token, and the one click that adds one.
//
// A catalogue head line has to say when a scan was partial for want of a token
// (linked-plugins ruling, 2026-09-06): without one GitHub allows 60 API
// requests an hour, so a scan of a marketplace with 238 linked plugins follows
// twenty repositories and states the rest as not yet read. Saying that is only
// half an answer — the other half is that the setting is one click away, which
// is what `openGitHubSettings` is.
//
// `null` while the answer is not in yet, and the head line stays silent then:
// "add a GitHub token" shown to somebody who already has one is advice that
// would not help, and this resolves in a tick.

import { useEffect, useState } from 'react'

import { useWorkspaceStore } from '../../../../../store/workspaceStore'

/** The Settings tab the GitHub token lives on — labelled "Version control". */
export const GITHUB_SETTINGS_TAB = 'github'

export function openGitHubSettings(): void {
  useWorkspaceStore.getState().openSettingsOverlay({ initialTab: GITHUB_SETTINGS_TAB })
}

/**
 * True once a token is known to be configured, false once it is known not to
 * be, null while neither is known. A build whose preload predates the call, or
 * a call that throws, reads as "configured": the head line's job is to offer a
 * fix for a shortfall it can explain, and inventing a missing token from a
 * failed status call would put a setting under somebody who already set it.
 */
export function useGitHubTokenConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    if (typeof window.api.getGitHubTokenStatus !== 'function') {
      setConfigured(true)
      return
    }
    void window.api
      .getGitHubTokenStatus()
      .then((status) => {
        if (!cancelled) setConfigured(status.configured)
      })
      .catch(() => {
        if (!cancelled) setConfigured(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return configured
}
