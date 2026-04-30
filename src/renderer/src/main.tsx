import React from 'react'
import ReactDOM from 'react-dom/client'
import './assets/index.css'
import WorkspaceManager from './components/workspace/WorkspaceManager'

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
  const observer = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      if (entry.duration >= 250) {
        console.warn('[RendererLongTask]', {
          name: entry.name,
          durationMs: Math.round(entry.duration),
          startTimeMs: Math.round(entry.startTime),
        })
      }
    })
  })
  observer.observe({ entryTypes: ['longtask'] })
} catch {
  // Long task entries are best-effort diagnostics.
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <WorkspaceManager />
)
