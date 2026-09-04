import { useWorkspaceStore } from '../../../../store/workspaceStore'

// Open a URL in the workspace pane's browser (browser-pane epic): the active
// browser tab if one is showing, else the first browser tab, else a new one.
// A link click must not mint a tab per click. Returns false when the pane
// could not take it (no such workspace, tab cap reached) so the caller can
// fall back to the system browser.
export function openUrlInPane(workspaceId: string, rawUrl: string): boolean {
  const url = rewriteUnroutableHost(rawUrl)
  const store = useWorkspaceStore.getState()
  const pane = store.workspaces.find((w) => w.id === workspaceId)?.paneState
  const browserTabs = pane?.tabs.filter((tab) => tab.kind === 'browser') ?? []
  const target = browserTabs.find((tab) => tab.id === pane?.activeTabId) ?? browserTabs[0]
  if (target) {
    store.setActivePaneTab(workspaceId, target.id)
    void window.api.browserNavigate(target.id, url)
    return true
  }
  return store.openPaneTab(workspaceId, { kind: 'browser', url }) !== null
}

// Chromium refuses to navigate to 0.0.0.0 (the wildcard bind a server prints
// is not an address a client can use); the same server answers on localhost.
export function rewriteUnroutableHost(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === '0.0.0.0') {
      parsed.hostname = 'localhost'
      return parsed.toString()
    }
    return url
  } catch {
    return url
  }
}
