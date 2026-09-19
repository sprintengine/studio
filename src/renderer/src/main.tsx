// First, before any other module can pull the canvas editor in behind it: the
// editor reads both window globals as its chunk evaluates. See canvasAssetPath.ts.
import './canvasAssetPath'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './assets/index.css'
import { ConfirmDialogProvider } from './components/ui'
import AuxWindowApp from './components/auxWindows/AuxWindowApp'
import WorkspaceManager from './components/workspace/WorkspaceManager'
import { loadThirdPartyRendererModules } from './modules'
import { reportBuildStamp } from './utils/buildStamp'
import { bindElectronClipboardPasteBridge } from './utils/clipboardPasteBridge'
import { logPerfEvent, perfDiagnosticsEnabled } from './utils/perfDiagnostics'
import { markStartup, markStartupAt } from './utils/startupTimeline'
import { setTerminalRepaintPauseReporter } from './utils/terminalRepaintPause'

// Boot measurement. `timeOrigin` is this document's navigation start,
// so the pair below brackets everything that happens before a line of app code
// runs: HTML parse, eager chunk fetch, compile and evaluate — the cost the
// bundle-size ceiling stands in for.
markStartupAt('renderer.navigation-start', performance.timeOrigin)
markStartup('renderer.script-start')

// The diagnostics window's content (process/IPC/memory panels + report
// formatter) is heavy and only mounts in the `?view=diagnostics` window, so keep
// it out of the eager boot chunk and fetch it when that window opens.
const DiagnosticsWindowApp = React.lazy(() => import('./components/diagnostics/DiagnosticsWindowApp'))

// Build identity, reported before anything else runs: if this document
// and main are on different commits, every IPC below is suspect, and the point
// is to say so rather than let each route fail its own way.
reportBuildStamp()

bindElectronClipboardPasteBridge()

// The modal repaint pause reports through `logPerfEvent` like everything else,
// but the store itself imports nothing: it is pulled into the xterm output
// queue, whose tests bundle without `import.meta.env` defined. Injecting the
// reporter here keeps that module dependency-free and keeps the perf events in
// the one rollup the diagnostics panel reads.
setTerminalRepaintPauseReporter(logPerfEvent)

window.addEventListener('error', (event) => {
  console.error('[RendererError]', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  console.error('[RendererUnhandledRejection]', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

try {
  const longTaskThresholdMs = perfDiagnosticsEnabled() ? 75 : 250
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      if (entry.duration >= longTaskThresholdMs) {
        console.warn('[RendererLongTask]', {
          name: entry.name,
          durationMs: Math.round(entry.duration),
          startTimeMs: Math.round(entry.startTime),
        })
        logPerfEvent('Renderer', 'long-task', {
          name: entry.name,
          durationMs: Math.round(entry.duration),
          startTimeMs: Math.round(entry.startTime),
          thresholdMs: longTaskThresholdMs,
        })
      }
    })
  })
  observer.observe({ entryTypes: ['longtask'] })
} catch {
  // Long task entries are best-effort diagnostics.
}

// Trusted third-party renderer modules register before the first render so
// every consumer (panel factory, workspace-type picker, command pipeline,
// settings rail) sees a complete registry — the same eager-at-boot lifecycle
// bundled modules get. Bounded so a wedged IPC round-trip can never hold the
// window hostage: on timeout we render without third-party contributions and
// the gap shows up in Settings → Modules rather than as a blank window.
const THIRD_PARTY_MODULE_BOOT_TIMEOUT_MS = 3000

async function bootThirdPartyRendererModules(): Promise<void> {
  try {
    await Promise.race([
      loadThirdPartyRendererModules(),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, THIRD_PARTY_MODULE_BOOT_TIMEOUT_MS)),
    ])
  } catch (error) {
    console.error('[ThirdPartyModules] renderer entry loading failed', error)
  }
}

// Tell main the app is actually on screen, which is what closes the splash and
// reveals this window. Two nested rAFs: the first runs after React has committed
// the tree, the second after the browser has painted it — so the plate is not
// pulled away before there is something behind it. `ready-to-show` would have
// been too early, which is why main waits for this instead. Main also holds a
// hard timeout, so failing to get here delays the reveal rather than losing it.
let bootCompleteSignalled = false
function signalBootComplete(): void {
  if (bootCompleteSignalled) return
  bootCompleteSignalled = true
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      markStartup('renderer.first-paint')
      if (typeof window.api?.notifyBootComplete !== 'function') return
      window.api.notifyBootComplete()
    })
  })
}

// The diagnostics window loads the same renderer bundle with `?view=diagnostics`
// and mounts only the standalone panel — no workspace shell, no third-party
// module boot (it needs none, and skipping it makes the monitor window snappy).
const searchParams = new URLSearchParams(window.location.search)
const isDiagnosticsWindow = searchParams.get('view') === 'diagnostics'
// Auxiliary windows (diff viewer, external file editor) mount a dedicated root —
// no workspace shell, no third-party module boot — branching on `?aux=<kind>`.
const auxWindowKind = searchParams.get('aux')

if (isDiagnosticsWindow) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ConfirmDialogProvider>
      <React.Suspense fallback={null}>
        <DiagnosticsWindowApp />
      </React.Suspense>
    </ConfirmDialogProvider>,
  )
} else if (auxWindowKind) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ConfirmDialogProvider>
      <AuxWindowApp />
    </ConfirmDialogProvider>,
  )
} else {
  void bootThirdPartyRendererModules().then(() => {
    markStartup('renderer.third-party-modules-settled')
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <ConfirmDialogProvider>
        <WorkspaceManager />
      </ConfirmDialogProvider>,
    )
    markStartup('renderer.root-rendered')
    // Only the primary workspace window reveals itself. The diagnostics and aux
    // branches above share this bundle but are opened by user action long after
    // boot — a boot-complete from one of them would be answering for a window
    // the splash was never covering.
    signalBootComplete()
  })
}
