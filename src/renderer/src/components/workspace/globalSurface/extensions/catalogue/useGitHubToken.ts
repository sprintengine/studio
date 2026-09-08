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
const GITHUB_SETTINGS_TAB = 'github'

export function openGitHubSettings(): void {
  useWorkspaceStore.getState().openSettingsOverlay({ initialTab: GITHUB_SETTINGS_TAB })
}

/**
 * True once a token is known to be configured, false once it is known not to
 * be, null while neither is known.
 *
 * A failed call, and a build whose preload predates it, read as NOT configured
 * — the head line then offers the setting (linked-plugins review, 2026-09-06).
 * The other way round was chosen to avoid nagging somebody who already has a
 * token, and it got the trade backwards: offering Settings to a person who does
 * not need it costs them one glance, while hiding the only remedy from a person
 * whose scan really is short of a token leaves them with a partial listing and
 * no way to find out why.
 */
export function useGitHubTokenConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    if (typeof window.api.getGitHubTokenStatus !== 'function') {
      setConfigured(false)
      return
    }
    void window.api
      .getGitHubTokenStatus()
      .then((status) => {
        if (!cancelled) setConfigured(status.configured)
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return configured
}
