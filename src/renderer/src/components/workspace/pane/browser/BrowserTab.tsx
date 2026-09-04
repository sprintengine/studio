import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  BROWSER_WEBPREFERENCES,
  type BrowserConfig,
  type BrowserHostKey,
  type BrowserTabState,
} from '../../../../../../shared/browser'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import type { EmbeddedWebviewElement } from '../../../../types/webview'
import { showToast } from '../../../../store/toastStore'
import { BrowserEmptyState } from './BrowserEmptyState'
import { BrowserErrorPage } from './BrowserErrorPage'
import { BrowserToolbar, type BrowserToolbarHandle } from './BrowserToolbar'

// The browser tab (browser-pane epic): a `<webview>` guest the renderer mounts
// and main drives. The element is created once per tab and never re-keyed —
// its `src` is the tab's remembered URL at mount, and every later navigation
// goes through main (`browserNavigate`), which is also where the state shown
// here comes from (`onBrowserState`). Registration hands main the guest's
// WebContents id on `dom-ready`; main refuses anything that is not a guest of
// this window.

const NO_RECENT_URLS: readonly string[] = []

let configPromise: Promise<BrowserConfig> | null = null
function browserConfig(): Promise<BrowserConfig> {
  configPromise ??= window.api.browserConfig()
  return configPromise
}

// Replays a chord the guest swallowed as a keydown on this window, so the
// app's own bindings (Primary+W, the palette, the pane toggle) act as if the
// person had typed it into the chrome.
function replayHostKey(key: BrowserHostKey): void {
  const code = key.key.length === 1 ? keyToCode(key.key) : key.key
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: key.key,
      code,
      metaKey: key.meta,
      ctrlKey: key.ctrl,
      altKey: key.alt,
      shiftKey: key.shift,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function keyToCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (key === '=' || key === '+') return 'Equal'
  if (key === '-') return 'Minus'
  return key
}

type BrowserTabProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
}

export function BrowserTab({ workspaceId, tab, active }: BrowserTabProps) {
  const webviewRef = useRef<EmbeddedWebviewElement | null>(null)
  const toolbarRef = useRef<BrowserToolbarHandle | null>(null)
  const [config, setConfig] = useState<BrowserConfig | null>(null)
  const [state, setState] = useState<BrowserTabState | null>(null)
  // The URL the guest starts on. Read once: a later change to the tab record
  // (main reporting a navigation) must not re-navigate the guest.
  const initialSrcRef = useRef(tab.url && tab.url !== 'about:blank' ? tab.url : 'about:blank')
  const registeredRef = useRef(false)
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const notePaneRecentUrl = useWorkspaceStore((s) => s.notePaneRecentUrl)
  // A stable empty list: a selector minting `[]` per call is a new snapshot
  // every render, which zustand's useSyncExternalStore turns into an update
  // loop (React #185).
  const recentUrls = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.paneState?.recentUrls ?? NO_RECENT_URLS,
  )

  useEffect(() => {
    let cancelled = false
    void browserConfig().then((next) => {
      if (!cancelled) setConfig(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Register the guest with main once it exists, and let go when the tab
  // unmounts (the tab closing, or the workspace being torn down).
  useEffect(() => {
    const element = webviewRef.current
    if (!element || !config) return
    const tabId = tab.id
    const register = () => {
      if (registeredRef.current) return
      let webContentsId: number
      try {
        webContentsId = element.getWebContentsId()
      } catch {
        return
      }
      registeredRef.current = true
      void window.api.browserRegister({ tabId, workspaceId, webContentsId }).then((result) => {
        if (result.ok) setState(result.state)
        else {
          registeredRef.current = false
          showToast({ tone: 'error', title: 'The browser tab could not start', description: result.reason })
        }
      })
    }
    element.addEventListener('dom-ready', register)
    element.addEventListener('did-attach', register)
    return () => {
      element.removeEventListener('dom-ready', register)
      element.removeEventListener('did-attach', register)
      if (registeredRef.current) {
        registeredRef.current = false
        void window.api.browserUnregister(tabId)
      }
    }
  }, [config, tab.id, workspaceId])

  // Main's view of the tab, and the record the strip reads (title, URL,
  // favicon) — written only when something changed, so a loading flicker does
  // not churn the persisted workspace.
  useEffect(() => {
    return window.api.onBrowserState((next) => {
      if (next.tabId !== tab.id) return
      setState(next)
      const url = next.url === 'about:blank' ? undefined : next.url
      const title = next.title || undefined
      const faviconUrl = next.faviconUrl ?? undefined
      if (url !== tab.url || title !== tab.title || faviconUrl !== tab.faviconUrl) {
        updatePaneTab(workspaceId, tab.id, { url, title, faviconUrl })
      }
      if (url && !next.loading && !next.error) notePaneRecentUrl(workspaceId, url)
    })
  }, [notePaneRecentUrl, tab.faviconUrl, tab.id, tab.title, tab.url, updatePaneTab, workspaceId])

  // Chords typed into the guest: Primary+L lands in the address field; the
  // app-level ones replay on this window.
  useEffect(() => {
    const offFocus = window.api.onBrowserFocusUrl((payload) => {
      if (payload.tabId === tab.id) toolbarRef.current?.focusAddress()
    })
    const offKey = window.api.onBrowserHostKey((payload) => {
      if (payload.tabId === tab.id) replayHostKey(payload.key)
    })
    return () => {
      offFocus()
      offKey()
    }
  }, [tab.id])

  const navigate = useCallback(
    (url: string) => {
      void window.api.browserNavigate(tab.id, url)
    },
    [tab.id],
  )

  const showEmpty = !state?.error && (!state?.url || state.url === 'about:blank')

  return (
    <div className="flex h-full w-full flex-col bg-[color:var(--bg-app)]">
      <BrowserToolbar
        ref={toolbarRef}
        state={state}
        onNavigate={navigate}
        onBack={() => void window.api.browserBack(tab.id)}
        onForward={() => void window.api.browserForward(tab.id)}
        onReload={() => void window.api.browserReload(tab.id)}
        onStop={() => void window.api.browserStop(tab.id)}
        onOpenExternal={() => {
          void window.api.browserOpenExternal(tab.id).then((result) => {
            if (!result.ok) showToast({ tone: 'warn', title: result.message })
          })
        }}
      />
      <div className="relative min-h-0 flex-1">
        {config ? (
          <webview
            ref={webviewRef as React.Ref<EmbeddedWebviewElement>}
            src={initialSrcRef.current}
            partition={config.partition}
            webpreferences={BROWSER_WEBPREFERENCES}
            allowpopups="true"
            // Hidden under the empty state or the error page while either
            // shows, but never `visibility:hidden`: macOS blanks a hidden
            // guest for good.
            className="absolute inset-0 h-full w-full"
            style={{ display: 'flex' }}
            aria-label={`Web page for ${tab.title ?? 'this tab'}`}
            tabIndex={active ? 0 : -1}
          />
        ) : null}
        {showEmpty ? (
          <div className="absolute inset-0">
            <BrowserEmptyState workspaceId={workspaceId} recentUrls={recentUrls} onOpen={navigate} />
          </div>
        ) : null}
        {state?.error ? (
          <div className="absolute inset-0">
            <BrowserErrorPage error={state.error} onReload={() => void window.api.browserReload(tab.id)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
