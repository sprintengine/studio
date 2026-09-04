import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  BROWSER_WEBPREFERENCES,
  type BrowserConfig,
  type BrowserHostKey,
  type BrowserTabState,
} from '../../../../../../shared/browser'
import {
  DEFAULT_BROWSER_DEVICE_PRESET_ID,
  fitViewportScale,
  presetViewport,
  type BrowserViewport,
} from '../../../../../../shared/browser-devices'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import type { EmbeddedWebviewElement } from '../../../../types/webview'
import { showToast } from '../../../../store/toastStore'
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar'
import { BrowserEmptyState } from './BrowserEmptyState'
import { BrowserErrorPage } from './BrowserErrorPage'
import { BrowserToolbar, type BrowserToolbarHandle } from './BrowserToolbar'
import { BrowserViewMenu } from './BrowserViewMenu'

// The browser tab (browser-pane epic): a `<webview>` guest the renderer mounts
// and main drives. The element is created once per tab and never re-keyed —
// its `src` is the tab's remembered URL at mount, and every later navigation
// goes through main (`browserNavigate`), which is also where the state shown
// here comes from (`onBrowserState`). Registration hands main the guest's
// WebContents id on `dom-ready`; main refuses anything that is not a guest of
// this window.
//
// Device emulation is sizing only (epic decision 7): with a viewport set, the
// guest is laid out at that CSS size and CSS-scaled to fit the tab body on a
// `bg.app` canvas behind a 1px frame.

const NO_RECENT_URLS: readonly string[] = []
const FILL: BrowserViewport = { mode: 'fill' }
// Breathing room around a framed viewport, so the frame reads as a device
// on a canvas rather than a page cut off at the edges.
const CANVAS_INSET_PX = 12

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

// The zoom chords, shared by the guest (via host-key) and the chrome.
function zoomDirectionFor(key: string, primary: boolean): 1 | -1 | 0 | null {
  if (!primary) return null
  if (key === '=' || key === '+') return 1
  if (key === '-') return -1
  if (key === '0') return 0
  return null
}

type BrowserTabProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
}

export function BrowserTab({ workspaceId, tab, active }: BrowserTabProps) {
  const webviewRef = useRef<EmbeddedWebviewElement | null>(null)
  const toolbarRef = useRef<BrowserToolbarHandle | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [config, setConfig] = useState<BrowserConfig | null>(null)
  const [state, setState] = useState<BrowserTabState | null>(null)
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
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
  const viewport: BrowserViewport = tab.viewport ?? FILL
  const isPrimary = (event: { metaKey: boolean; ctrlKey: boolean }) =>
    window.api.platform === 'darwin' ? event.metaKey : event.ctrlKey

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
    // A (re)attach is a new WebContents: forget the old registration so main
    // adopts the new guest instead of driving a dead one.
    const reattach = () => {
      registeredRef.current = false
      register()
    }
    element.addEventListener('dom-ready', register)
    element.addEventListener('did-attach', reattach)
    return () => {
      element.removeEventListener('dom-ready', register)
      element.removeEventListener('did-attach', reattach)
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

  // Chords typed into the guest: Primary+L lands in the address field, the
  // zoom chords zoom this tab, the app-level ones replay on this window.
  useEffect(() => {
    const offFocus = window.api.onBrowserFocusUrl((payload) => {
      if (payload.tabId === tab.id) toolbarRef.current?.focusAddress()
    })
    const offKey = window.api.onBrowserHostKey((payload) => {
      if (payload.tabId !== tab.id) return
      const zoom = zoomDirectionFor(payload.key.key, window.api.platform === 'darwin' ? payload.key.meta : payload.key.ctrl)
      if (zoom !== null) {
        void window.api.browserZoomStep(tab.id, zoom)
        return
      }
      replayHostKey(payload.key)
    })
    return () => {
      offFocus()
      offKey()
    }
  }, [tab.id])

  // The canvas the framed viewport fits into.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || viewport.mode === 'fill') return
    const measure = () => {
      const rect = canvas.getBoundingClientRect()
      setCanvasSize({
        width: Math.max(0, rect.width - CANVAS_INSET_PX * 2),
        height: Math.max(0, rect.height - CANVAS_INSET_PX * 2),
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [viewport.mode])

  const navigate = useCallback(
    (url: string) => {
      void window.api.browserNavigate(tab.id, url)
    },
    [tab.id],
  )

  const setViewport = useCallback(
    (next: BrowserViewport) => {
      updatePaneTab(workspaceId, tab.id, { viewport: next.mode === 'fill' ? undefined : next })
    },
    [tab.id, updatePaneTab, workspaceId],
  )

  const showEmpty = !state?.error && (!state?.url || state.url === 'about:blank')
  const framed = viewport.mode !== 'fill'
  const scale = framed ? fitViewportScale(viewport, canvasSize) : 1
  // The guest sits in ONE frame element in both modes; only the frame's
  // geometry changes. Moving a <webview> to another parent detaches and
  // re-attaches the guest, which reloads it from its initial `src` and gives
  // it a new WebContents main no longer knows.
  const frameStyle: React.CSSProperties = framed
    ? {
        width: Math.round(viewport.width * scale),
        height: Math.round(viewport.height * scale),
        left: CANVAS_INSET_PX + Math.max(0, (canvasSize.width - viewport.width * scale) / 2),
        top: CANVAS_INSET_PX + Math.max(0, (canvasSize.height - viewport.height * scale) / 2),
      }
    : { inset: 0 }
  const guestStyle: React.CSSProperties = framed
    ? {
        position: 'absolute',
        top: 0,
        left: 0,
        width: viewport.width,
        height: viewport.height,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        display: 'flex',
      }
    : { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'flex' }

  return (
    <div
      className="flex h-full w-full flex-col bg-[color:var(--bg-app)]"
      onKeyDown={(event) => {
        const zoom = zoomDirectionFor(event.key, isPrimary(event))
        if (zoom === null) return
        event.preventDefault()
        void window.api.browserZoomStep(tab.id, zoom)
      }}
    >
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
        trailing={
          <BrowserViewMenu
            state={state}
            deviceToolbarOn={viewport.mode !== 'fill'}
            onHardReload={() => void window.api.browserReload(tab.id, true)}
            onOpenDevTools={() => void window.api.browserOpenDevTools(tab.id)}
            onOpenWindow={() => void window.api.browserOpenWindow(tab.id)}
            onToggleDeviceToolbar={() =>
              setViewport(viewport.mode === 'fill' ? presetViewport(DEFAULT_BROWSER_DEVICE_PRESET_ID) : FILL)
            }
            onColorScheme={(scheme) => void window.api.browserSetColorScheme(tab.id, scheme)}
            onZoom={(direction) => void window.api.browserZoomStep(tab.id, direction)}
            onClearCookies={() => {
              void window.api.browserClearCookies().then((result) => {
                if (!result.ok) {
                  showToast({ tone: 'error', title: 'Cookies were not cleared', description: result.message })
                  return
                }
                showToast({ tone: 'good', title: 'Cookies cleared' })
                void window.api.browserReload(tab.id)
              })
            }}
            onClearCache={() => {
              void window.api.browserClearCache().then((result) => {
                if (!result.ok) {
                  showToast({ tone: 'error', title: 'The cache was not cleared', description: result.message })
                  return
                }
                showToast({ tone: 'good', title: 'Cache cleared' })
                void window.api.browserReload(tab.id, true)
              })
            }}
          />
        }
      />
      {viewport.mode !== 'fill' ? (
        <BrowserDeviceToolbar viewport={viewport} onChange={setViewport} onClose={() => setViewport(FILL)} />
      ) : null}
      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className={`absolute overflow-hidden ${
            framed ? 'border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]' : ''
          }`}
          style={frameStyle}
        >
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
              style={guestStyle}
              aria-label={`Web page for ${tab.title ?? 'this tab'}`}
              tabIndex={active ? 0 : -1}
            />
          ) : null}
        </div>
        {framed ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-2 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]"
          >
            {viewport.width} × {viewport.height}
          </span>
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
