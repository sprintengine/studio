// The usage scan's worker thread. The usage service starts it with
// `new Worker(<main build>/usage-scan-worker.js)` for one scan at a time; all
// file reading and JSON parsing happens here, off the process's main thread,
// so gigabytes of session logs never stall the app.

import { parentPort } from 'node:worker_threads'

import { runUsageScan, type UsageScanRoots } from './usage-scan'

export type UsageScanWorkerRequest =
  { type: 'scan'; roots: UsageScanRoots; previous: Record<string, string> } | { type: 'stop' }

let stopping = false

parentPort?.on('message', (message: UsageScanWorkerRequest) => {
  const port = parentPort!
  if (message.type === 'stop') {
    stopping = true
    return
  }
  void runUsageScan(message.roots, message.previous, {
    onEntry: (entry) => port.postMessage({ type: 'entry', entry }),
    shouldStop: () => stopping,
  })
    .then((result) => port.postMessage({ type: 'done', result }))
    .catch((error: unknown) =>
      port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
})
