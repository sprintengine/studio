import assert from 'node:assert/strict'

import type {
  CanvasWorkerRequest,
  CanvasWorkerRequestOf,
  CanvasWorkerResponse,
  CanvasWorkerResponseOf,
} from './worker-protocol'
import { isCanvasWorkerFailure } from './worker-protocol'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// The point of these is the compile: if a later change moves a field or renames
// a kind, the host and the worker stop agreeing and this file stops building.
const requests: CanvasWorkerRequest[] = [
  { kind: 'apply-edit', requestId: 'r1', elements: [], files: {}, edit: { create: [] } },
  { kind: 'layout', requestId: 'r2', elements: [], request: { op: 'align', elementIds: ['a'], to: 'left' } },
  { kind: 'import-mermaid', requestId: 'r3', definition: 'graph TD; a-->b;', origin: { x: 0, y: 0 } },
  { kind: 'import-scene', requestId: 'r4', scene: { elements: [] } },
  {
    kind: 'export-image',
    requestId: 'r5',
    elements: [],
    appState: {},
    files: {},
    maxEdge: 1024,
    background: true,
    dark: false,
    format: 'jpeg',
    quality: 0.8,
  },
]

run('every request kind carries a requestId', () => {
  assert.deepEqual(
    requests.map((request) => request.kind),
    ['apply-edit', 'layout', 'import-mermaid', 'import-scene', 'export-image'],
  )
  for (const request of requests) assert.match(request.requestId, /^r\d$/)
})

run('a request narrows to its own payload by kind', () => {
  const request = requests[4]
  assert.equal(request.kind, 'export-image')
  if (request.kind === 'export-image') {
    assert.equal(request.maxEdge, 1024)
    assert.equal(request.format, 'jpeg')
  }
  const applyEdit: CanvasWorkerRequestOf<'apply-edit'> = {
    kind: 'apply-edit',
    requestId: 'r6',
    elements: [],
    files: {},
    edit: {},
  }
  assert.equal(applyEdit.kind, 'apply-edit')
})

run('a failure is recognised by ok alone, whatever it was a reply to', () => {
  const failure: CanvasWorkerResponse = {
    requestId: 'r1',
    ok: false,
    error: { code: 'worker_unavailable', message: 'The canvas worker window is not up.' },
  }
  assert.equal(isCanvasWorkerFailure(failure), true)

  const success: CanvasWorkerResponseOf<'layout'> = {
    kind: 'layout',
    requestId: 'r2',
    ok: true,
    elements: [],
    changed: [],
  }
  assert.equal(isCanvasWorkerFailure(success), false)
})

run('apply-edit answers with the full next array, not a patch', () => {
  const response: CanvasWorkerResponseOf<'apply-edit'> = {
    kind: 'apply-edit',
    requestId: 'r1',
    ok: true,
    elements: [{ id: 'a', type: 'rectangle', version: 2, versionNonce: 7 }],
    changed: ['a', 'container'],
    files: {},
    result: { created: ['a'], updated: [], deleted: [], tempIds: { t1: 'a' }, warnings: [] },
  }
  assert.equal(isCanvasWorkerFailure(response), false)
  if (!isCanvasWorkerFailure(response)) {
    assert.equal(response.elements.length, 1)
    assert.deepEqual(response.result.tempIds, { t1: 'a' })
    // `changed` is the WIDER list: what the worker moved, including elements
    // nobody named. `result.updated` stays the agent's own.
    assert.deepEqual(response.changed, ['a', 'container'])
    assert.deepEqual(response.result.updated, [])
  }
})

console.log('canvas worker-protocol tests passed')
