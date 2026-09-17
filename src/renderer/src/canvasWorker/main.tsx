// The hidden canvas worker's entry point.
//
// The document this loads is never shown. It mounts one editor instance so the
// scene fonts reach `document.fonts`, then serves the worker protocol from
// src/shared/canvas/worker-protocol.ts: skeleton conversion, arrow binding,
// arranging, diagram import and image export — everything a canvas tool needs
// that only a renderer can do.

// First, before any other module can pull the editor in behind it: the editor
// reads both window globals as its chunk evaluates. See canvasAssetPath.ts.
import '../canvasAssetPath'
import { bootstrapCanvasWorker } from './bootstrap'
import type { BootstrapReport } from './bootstrap'
import { createRequestHandler } from './handleRequest'
import { createLibraryBridge } from './libraryBridge'
import { startCanvasWorkerTransport } from './transport'
import type { CanvasWorkerHandler } from './transport'

declare global {
  interface Window {
    /** Dev only: the handler, so the page can be driven from a plain browser. */
    __canvasWorker?: { handleRequest: CanvasWorkerHandler; ready: Promise<BootstrapReport> }
  }
}

const HOST_ID = 'canvas-worker-host'

const handleRequest = createRequestHandler(createLibraryBridge())

const ready = start()

if (import.meta.env.DEV) {
  window.__canvasWorker = { handleRequest, ready }
}

async function start(): Promise<BootstrapReport> {
  const host = document.getElementById(HOST_ID)
  let report: BootstrapReport = { loaded: [], missing: [], errors: [] }
  if (host) {
    report = await bootstrapCanvasWorker(host)
  } else {
    // The document and this module ship together, so this cannot happen without
    // the build being wrong. It is still not a reason to stay silent: a worker
    // that never says it is ready costs main a deadline per call and explains
    // nothing, where one that answers in a fallback face at least says so.
    report.errors.push(`canvas-worker.html is missing its #${HOST_ID} element, so no scene fonts were loaded.`)
  }
  for (const problem of report.errors) console.warn('[canvas-worker]', problem)
  // The report rides on the handshake: main appends a warning to every write it
  // makes while a scene font is missing.
  startCanvasWorkerTransport(handleRequest, report)
  return report
}

ready.catch((error) => {
  console.error('[canvas-worker] failed to start', error)
})
