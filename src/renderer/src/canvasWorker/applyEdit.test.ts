/**
 * `apply-edit`, against a stub converter.
 *
 * The real converter needs a document, a canvas and loaded fonts, so it cannot
 * run here — but almost nothing this file gets wrong is about typography. What
 * it gets wrong is about REFERENCES: which shape an arrow ends up fastened to,
 * which shape lists it back, which elements a frame holds, and which versions
 * moved. So the bridge is stubbed with a converter that keeps the ids it is
 * given, builds bound labels, wires bindings and adopts frame children — and
 * that throws exactly where the shipped one throws, on an arrow aimed at
 * something that cannot hold one.
 *
 * Two invariants run through every case and are asserted on their own at the
 * end, because breaking either one loses somebody's drawing when main merges
 * the result: an element this request did not change comes back as the SAME
 * object, and an element it did change comes back on a strictly higher version.
 */
import assert from 'node:assert/strict'

import { applyEdit } from './applyEdit'
import type { ApplyEditOutcome } from './applyEdit'
import type { CanvasEditorBridge } from './editorBridge'
import type { LibrarySkeleton } from './skeletonMap'
import type { CanvasEditRequest, CanvasElement } from '../../../shared/canvas/types'
import type { CanvasWorkerRequestOf } from '../../../shared/canvas/worker-protocol'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// --- the stub converter ------------------------------------------------------

/** What the shipped converter will fasten an arrow to. */
const BINDABLE = new Set(['rectangle', 'ellipse', 'diamond', 'image'])

type Built = Record<string, unknown>

function createBridge(): CanvasEditorBridge {
  let ids = 0
  let nonce = 900
  let clock = 5_000
  const newId = (): string => {
    ids += 1
    return `new-${ids}`
  }
  return {
    newId,
    nonce: () => {
      nonce += 1
      return nonce
    },
    now: () => {
      clock += 1
      return clock
    },
    convert: (skeletons) => convert(skeletons, newId),
    convertFresh: () => {
      throw new Error('convertFresh is not part of apply-edit')
    },
    restoreScene: () => {
      throw new Error('restoreScene is not part of apply-edit')
    },
    exportImage: () => {
      throw new Error('exportImage is not part of apply-edit')
    },
    parseMermaid: () => {
      throw new Error('parseMermaid is not part of apply-edit')
    },
  }
}

function defaults(): Built {
  return {
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: 1,
    isDeleted: false,
    link: null,
    locked: false,
    boundElements: null,
    updated: 1,
  }
}

function refs(value: unknown): Array<{ id: string; type: string }> {
  return Array.isArray(value) ? (value as Array<{ id: string; type: string }>) : []
}

function addRef(host: Built, ref: { id: string; type: string }): void {
  const current = refs(host.boundElements)
  if (current.some((entry) => entry && entry.id === ref.id)) return
  host.boundElements = [...current, ref]
}

/**
 * The converter's habits, as `applyEdit` relies on them: ids are kept, a
 * `label` becomes a text element bound to its container, `start`/`end` become
 * bindings in both directions, and a frame's `children` are adopted by writing
 * `frameId` on them. Elements not named in the same call are invisible to it,
 * which is why `applyEdit` sends passthroughs at all.
 */
function convert(skeletons: LibrarySkeleton[], newId: () => string): CanvasElement[] {
  const out = new Map<string, Built>()
  const order: string[] = []
  const built: Array<{ skeleton: LibrarySkeleton; id: string }> = []

  for (const skeleton of skeletons) {
    const { label, start, end, children, ...rest } = skeleton as Record<string, unknown>
    const id = typeof rest.id === 'string' ? rest.id : newId()
    const element: Built = {
      ...defaults(),
      ...rest,
      id,
      version: typeof rest.version === 'number' ? rest.version : 1,
      versionNonce: typeof rest.versionNonce === 'number' ? rest.versionNonce : 1,
      width: typeof rest.width === 'number' ? rest.width : 100,
      height: typeof rest.height === 'number' ? rest.height : 100,
    }
    void start
    void end
    void children
    out.set(id, element)
    order.push(id)
    built.push({ skeleton, id })

    if (label && typeof label === 'object') {
      const source = label as Record<string, unknown>
      const labelId = typeof source.id === 'string' ? source.id : newId()
      const text = String(source.text ?? '')
      const textElement: Built = {
        ...defaults(),
        autoResize: false,
        lineHeight: 1.25,
        ...source,
        id: labelId,
        type: 'text',
        containerId: id,
        text,
        originalText: text,
        version: typeof source.version === 'number' ? source.version : 1,
        versionNonce: typeof source.versionNonce === 'number' ? source.versionNonce : 1,
        x: Number(element.x ?? 0) + 5,
        y: Number(element.y ?? 0) + 5,
        width: Math.max(10, text.length * 12),
        height: 25,
        fontSize: source.fontSize ?? 20,
        textAlign: source.textAlign ?? 'center',
        verticalAlign: 'middle',
      }
      out.set(labelId, textElement)
      order.push(labelId)
      addRef(element, { id: labelId, type: 'text' })
      // The shape grows to hold its label, exactly as the shipped one does.
      element.width = Math.max(Number(element.width), Number(textElement.width) + 10)
    }
  }

  for (const { skeleton, id } of built) {
    const element = out.get(id)
    if (!element) continue
    for (const which of ['start', 'end'] as const) {
      const ref = (skeleton as Record<string, unknown>)[which]
      if (!ref || typeof ref !== 'object') continue
      const targetId = (ref as { id?: unknown }).id
      if (typeof targetId !== 'string') continue
      const target = out.get(targetId)
      if (!target) continue
      if (!BINDABLE.has(String(target.type))) {
        // What the shipped converter does: it looks the target up among the
        // shapes it built, finds nothing, and reads `.id` off undefined.
        throw new TypeError("Cannot read properties of undefined (reading 'id')")
      }
      element[which === 'start' ? 'startBinding' : 'endBinding'] = { elementId: targetId, focus: 0, gap: 4 }
      addRef(target, { id, type: String(element.type) })
    }
    const children = (skeleton as Record<string, unknown>).children
    if (Array.isArray(children)) {
      for (const childId of children) {
        const child = out.get(String(childId))
        if (!child) continue
        child.frameId = id
      }
    }
  }

  return order.map((id) => out.get(id) as unknown as CanvasElement)
}

// --- the board ---------------------------------------------------------------

let seed = 0
function element(over: Partial<CanvasElement> & { id: string; type: string }): CanvasElement {
  seed += 1
  // The full default set a real scene element carries, so a round trip through
  // the converter is content-identical unless something actually changed.
  return {
    version: 3,
    versionNonce: 100 + seed,
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    seed: 7,
    index: `a${seed}`,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    roundness: null,
    groupIds: [],
    frameId: null,
    boundElements: null,
    isDeleted: false,
    locked: false,
    link: null,
    updated: 1,
    ...over,
  }
}

function edit(elements: CanvasElement[], request: CanvasEditRequest): ApplyEditOutcome {
  const input: CanvasWorkerRequestOf<'apply-edit'> = {
    kind: 'apply-edit',
    requestId: 'r',
    elements,
    files: {},
    edit: request,
  }
  const outcome = applyEdit(createBridge(), input)
  assertInvariants(elements, outcome)
  return outcome
}

/**
 * The two rules main's merge depends on, checked after every case in this file
 * rather than once: an element the request did not change is the object it was
 * handed, and an element it did change is on a strictly higher version.
 */
function assertInvariants(before: CanvasElement[], outcome: ApplyEditOutcome): void {
  const was = new Map(before.map((item) => [item.id, item]))
  const changed = new Set(outcome.changed)
  for (const after of outcome.elements) {
    const original = was.get(after.id)
    if (!original) continue
    if (!changed.has(after.id)) {
      assert.equal(after, original, `${after.id} was not changed, so it must be the same object`)
      continue
    }
    assert.ok(
      Number(after.version) > Number(original.version),
      `${after.id} changed, so its version must be above ${original.version} (got ${after.version})`,
    )
  }
  for (const id of changed) {
    assert.ok(outcome.elements.some((item) => item.id === id), `${id} is reported changed but is not in the scene`)
  }
}

function find(outcome: ApplyEditOutcome, id: string): CanvasElement {
  const found = outcome.elements.find((item) => item.id === id)
  assert.ok(found, `${id} is on the board`)
  return found
}

function boundIds(item: CanvasElement): string[] {
  return refs(item.boundElements).map((ref) => ref.id)
}

/** What an end is fastened to, with "nothing" spelled one way. */
function bindingOf(item: CanvasElement, which: 'startBinding' | 'endBinding'): string | null {
  const binding = item[which]
  return binding && typeof binding === 'object' && typeof (binding as { elementId?: unknown }).elementId === 'string'
    ? (binding as { elementId: string }).elementId
    : null
}

// --- R2: an arrow aimed at something that cannot hold one --------------------

run('an arrow naming a frame created in the same request is unfastened, not a thrown request', () => {
  const box = element({ id: 'box', type: 'rectangle' })
  const outcome = edit([box], {
    create: [
      { tempId: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 300, name: 'Section' },
      { tempId: 'a', type: 'arrow', x: 0, y: 0, startElementId: 'f', endElementId: 'box' },
    ],
  })
  const arrowId = outcome.result.tempIds.a
  const arrow = find(outcome, arrowId)
  assert.equal(bindingOf(arrow, 'startBinding'), null, 'the end that named the frame is left unfastened')
  assert.equal(bindingOf(arrow, 'endBinding'), 'box', 'the other end still binds')
  assert.ok(
    outcome.result.warnings.some((warning) => /is a frame; only a shape can hold an arrow/.test(warning)),
    outcome.result.warnings.join(' | '),
  )
})

run('the same rule for a text and for another arrow created in the same request', () => {
  const outcome = edit([], {
    create: [
      { tempId: 't', type: 'text', x: 0, y: 0, text: 'note' },
      { tempId: 'a1', type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]] },
      { tempId: 'a2', type: 'arrow', x: 0, y: 0, startElementId: 't', endElementId: 'a1' },
    ],
  })
  const arrow = find(outcome, outcome.result.tempIds.a2)
  assert.equal(bindingOf(arrow, 'startBinding'), null)
  assert.equal(bindingOf(arrow, 'endBinding'), null)
  assert.equal(
    outcome.result.warnings.filter((warning) => /only a shape can hold an arrow/.test(warning)).length,
    2,
    'both ends are reported, not just the first',
  )
})

// --- R1: frames and the elements they hold -----------------------------------

run('a frame created over existing elements actually adopts them', () => {
  const box = element({ id: 'box', type: 'rectangle', x: 40, y: 40 })
  const note = element({ id: 'note', type: 'ellipse', x: 200, y: 40 })
  const outcome = edit([box, note], {
    create: [{ tempId: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, children: ['box', 'note'] }],
  })
  const frameId = outcome.result.tempIds.f
  assert.equal(find(outcome, 'box').frameId, frameId, 'the frame moves with what it says it holds')
  assert.equal(find(outcome, 'note').frameId, frameId)
  assert.ok(outcome.changed.includes('box'), 'and the adoption is reported as a change')
  assert.ok(outcome.result.updated.includes('box'))
})

run('a child a frame names but the board does not have is said out loud', () => {
  const box = element({ id: 'box', type: 'rectangle' })
  const outcome = edit([box], {
    create: [{ tempId: 'f', type: 'frame', x: 0, y: 0, children: ['box', 'ghost'] }],
  })
  assert.equal(find(outcome, 'box').frameId, outcome.result.tempIds.f)
  assert.ok(
    outcome.result.warnings.some((warning) => /names ghost as a child, which is not on this board/.test(warning)),
    outcome.result.warnings.join(' | '),
  )
})

run('updating a frame\'s children re-parents what joined and releases what left', () => {
  const frame = element({ id: 'frame', type: 'frame', x: 0, y: 0, width: 500, height: 300, name: 'Section' })
  const inside = element({ id: 'inside', type: 'rectangle', x: 20, y: 20, frameId: 'frame' })
  const outside = element({ id: 'outside', type: 'rectangle', x: 300, y: 20 })
  const outcome = edit([frame, inside, outside], {
    update: [{ id: 'frame', set: { children: ['outside'] } }],
  })
  assert.equal(find(outcome, 'outside').frameId, 'frame', 'the element named joins the frame')
  assert.equal(find(outcome, 'inside').frameId, null, 'and the one dropped from the list stops following it')
  assert.ok(outcome.changed.includes('inside') && outcome.changed.includes('outside'))
})

// --- R3: a connector pointed somewhere else ----------------------------------

run('re-pointing an arrow detaches it from the shape it used to name', () => {
  const from = element({ id: 'from', type: 'rectangle', x: 0, y: 0, boundElements: [{ id: 'arrow', type: 'arrow' }] })
  const was = element({ id: 'was', type: 'rectangle', x: 400, y: 0, boundElements: [{ id: 'arrow', type: 'arrow' }] })
  const now = element({ id: 'now', type: 'rectangle', x: 400, y: 300 })
  const arrow = element({
    id: 'arrow',
    type: 'arrow',
    x: 200,
    y: 50,
    width: 200,
    height: 0,
    points: [[0, 0], [200, 0]],
    startBinding: { elementId: 'from', focus: 0, gap: 4 },
    endBinding: { elementId: 'was', focus: 0, gap: 4 },
  })
  const outcome = edit([from, was, now, arrow], {
    update: [{ id: 'arrow', set: { endElementId: 'now' } }],
  })
  assert.equal(bindingOf(find(outcome, 'arrow'), 'endBinding'), 'now')
  assert.deepEqual(boundIds(find(outcome, 'was')), [], 'the old target stops listing an arrow that left it')
  assert.deepEqual(boundIds(find(outcome, 'now')), ['arrow'], 'and the new one lists it')
  assert.deepEqual(boundIds(find(outcome, 'from')), ['arrow'], 'the end that did not move is left alone')
  assert.ok(outcome.changed.includes('was'), 'the detached shape is reported as changed')
})

// --- R8: an arrow from a shape back to itself --------------------------------

run('a self-loop is routed around its shape rather than drawn across it', () => {
  const box = element({ id: 'box', type: 'rectangle', x: 100, y: 100, width: 200, height: 100 })
  const outcome = edit([box], {
    create: [{ tempId: 'loop', type: 'arrow', x: 0, y: 0, startElementId: 'box', endElementId: 'box' }],
  })
  const loop = find(outcome, outcome.result.tempIds.loop)
  const points = loop.points as Array<[number, number]>
  assert.ok(Array.isArray(points) && points.length >= 4, `a loop needs corners, got ${JSON.stringify(points)}`)
  const absolute = points.map(([px, py]) => [Number(loop.x) + px, Number(loop.y) + py] as const)
  const above = absolute.some(([, py]) => py < 100)
  const right = absolute.some(([px]) => px > 300)
  assert.ok(above && right, `the loop leaves the shape: ${JSON.stringify(absolute)}`)
  const first = absolute[0]
  const last = absolute[absolute.length - 1]
  assert.ok(Math.hypot(last[0] - first[0], last[1] - first[1]) > 1, 'and it is not a zero-length stub')
  assert.deepEqual(boundIds(find(outcome, 'box')), [loop.id], 'the shape lists it once, not twice')
})

// --- R9: a label belongs to its shape's group --------------------------------

run('a labelled shape created in a group puts its label in the group too', () => {
  const outcome = edit([], {
    create: [{ tempId: 'b', type: 'rectangle', x: 0, y: 0, text: 'Auth', groupId: 'group-1' }],
  })
  const shape = find(outcome, outcome.result.tempIds.b)
  assert.deepEqual(shape.groupIds, ['group-1'])
  const label = outcome.elements.find((item) => item.type === 'text' && item.containerId === shape.id)
  assert.ok(label, 'the shape has a label')
  assert.deepEqual(label.groupIds, ['group-1'], 'a label outside the group is left behind when the group moves')
})

// --- R10: what the format cannot re-describe ---------------------------------

run('moving something this format cannot describe is a warning, not a silent no-op', () => {
  const stroke = element({ id: 'stroke', type: 'freedraw', x: 0, y: 0 })
  const outcome = edit([stroke], { update: [{ id: 'stroke', set: { x: 400 } }] })
  assert.equal(find(outcome, 'stroke'), stroke, 'nothing was moved')
  assert.ok(
    outcome.result.warnings.some((warning) => /which this format cannot re-describe/.test(warning)),
    outcome.result.warnings.join(' | '),
  )
})

// --- R14: a label emptied out -------------------------------------------------

run('emptying a label tombstones it, and both the container and the label are reported', () => {
  const container = element({
    id: 'c',
    type: 'rectangle',
    x: 0,
    y: 0,
    boundElements: [{ id: 't', type: 'text' }],
  })
  const label = element({ id: 't', type: 'text', x: 5, y: 5, containerId: 'c', text: 'Auth', originalText: 'Auth' })
  const outcome = edit([container, label], { update: [{ id: 'c', set: { text: '' } }] })
  assert.equal(find(outcome, 't').isDeleted, true, 'the label is tombstoned rather than left floating')
  assert.ok(outcome.result.updated.includes('c'), 'the container changed, and is reported as updated')
  assert.ok(outcome.changed.includes('t'), 'and the tombstone reaches the service, which merges on it')
  assert.deepEqual(boundIds(find(outcome, 'c')), [], 'the container stops listing a label that is gone')
})

// --- the invariants, on their own --------------------------------------------

run('an element nothing in the request touched comes back as the same object', () => {
  const untouched = element({ id: 'far', type: 'rectangle', x: 5_000, y: 5_000 })
  const box = element({ id: 'box', type: 'rectangle' })
  const outcome = edit([untouched, box], { update: [{ id: 'box', set: { x: 40 } }] })
  assert.equal(find(outcome, 'far'), untouched)
  assert.ok(!outcome.changed.includes('far'))
  assert.ok(outcome.changed.includes('box'))
  assert.ok(Number(find(outcome, 'box').version) > Number(box.version))
})

run('setting a field to the value it already has changes nothing', () => {
  const box = element({ id: 'box', type: 'rectangle', x: 40, y: 40, strokeColor: '#1e1e1e' })
  const outcome = edit([box], { update: [{ id: 'box', set: { strokeColor: '#1e1e1e' } }] })
  assert.deepEqual(outcome.changed, [], 'no version moved, so main has nothing to merge')
  assert.equal(find(outcome, 'box'), box)
  assert.deepEqual(outcome.result.updated, ['box'], 'the agent is still told its update was taken')
})

run('a delete tombstones the element, its label, and every reference to it', () => {
  const box = element({ id: 'box', type: 'rectangle', boundElements: [{ id: 't', type: 'text' }, { id: 'arrow', type: 'arrow' }] })
  const label = element({ id: 't', type: 'text', containerId: 'box', text: 'Gone' })
  const arrow = element({
    id: 'arrow',
    type: 'arrow',
    x: 300,
    y: 0,
    points: [[0, 0], [100, 0]],
    startBinding: { elementId: 'box', focus: 0, gap: 4 },
  })
  const outcome = edit([box, label, arrow], { delete: ['box'] })
  assert.equal(find(outcome, 'box').isDeleted, true)
  assert.equal(find(outcome, 't').isDeleted, true, 'a label without its container is nothing')
  assert.notEqual(find(outcome, 'arrow').isDeleted, true, 'the arrow survives its shape')
  assert.equal(bindingOf(find(outcome, 'arrow'), 'startBinding'), null, 'with that end unfastened')
  assert.deepEqual(outcome.result.deleted, ['box'])
})

console.log('canvas applyEdit tests passed')
