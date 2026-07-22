import React from 'react'
import ReactDOM from 'react-dom/client'
import './assets/index.css'
import { ConfirmDialogProvider } from './components/ui'
import AuxWindowApp from './components/auxWindows/AuxWindowApp'
import WorkspaceManager from './components/workspace/WorkspaceManager'
import { loadThirdPartyRendererModules } from './modules'
import { runBundledSpecialistPackMigration } from './utils/bundledSpecialistPackMigration'
import { bindElectronClipboardPasteBridge } from './utils/clipboardPasteBridge'
import { logPerfEvent, perfDiagnosticsEnabled } from './utils/perfDiagnostics'

// The diagnostics window's content (process/IPC/memory panels + report
// formatter) is heavy and only mounts in the `?view=diagnostics` window, so keep
// it out of the eager boot chunk and fetch it when that window opens.
const DiagnosticsWindowApp = React.lazy(() => import('./components/diagnostics/DiagnosticsWindowApp'))

bindElectronClipboardPasteBridge()

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
    </ConfirmDialogProvider>
  )
} else if (auxWindowKind) {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ConfirmDialogProvider>
      <AuxWindowApp />
    </ConfirmDialogProvider>
  )
} else {
  void bootThirdPartyRendererModules().then(() => {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <ConfirmDialogProvider>
        <WorkspaceManager />
      </ConfirmDialogProvider>
    )
    // One-time MC-1587 migration: install the un-shipped specialist pack for
    // profiles that had it enabled before it stopped being bundled. Guarded by a
    // persisted flag and scoped to the main workspace window (never the
    // diagnostics/aux windows above), so it evaluates once per profile.
    void runBundledSpecialistPackMigration()
  })
}
