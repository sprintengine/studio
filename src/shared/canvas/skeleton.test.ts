import assert from 'node:assert/strict'

import type { CanvasElement, CanvasError, CanvasSkeleton } from './types'
import {
  CANVAS_MAX_CREATES_PER_EDIT,
  canvasFontFamilyName,
  toSkeleton,
  validateEditRequest,
  validateSkeleton,
} from './skeleton'
import { test } from 'vitest'

test('skeleton', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  let nonce = 0
  function element(partial: Partial<CanvasElement> & { id: string; type: string }): CanvasElement {
    nonce += 1
    return { version: 1, versionNonce: nonce, ...partial }
  }

  function skeletonFor(elements: CanvasElement[], id: string): CanvasSkeleton {
    const found = toSkeleton(elements).find((skeleton) => skeleton.id === id)
    assert.ok(found, `no skeleton for ${id}`)
    return found as CanvasSkeleton
  }

  const codes = (errors: CanvasError[]): string[] => errors.map((error) => error.code)
  const messages = (errors: CanvasError[]): string => errors.map((error) => error.message).join(' | ')

  // A shape with a label bound into it, an arrow bound to two shapes, and a frame.
  function scene(): CanvasElement[] {
    return [
      element({
        id: 'box',
        type: 'rectangle',
        x: 10.4,
        y: 20.6,
        width: 160,
        height: 80,
        roundness: { type: 3 },
        boundElements: [
          { id: 'label', type: 'text' },
          { id: 'arrow', type: 'arrow' },
        ],
        frameId: 'frame',
      }),
      element({
        id: 'label',
        type: 'text',
        containerId: 'box',
        x: 20,
        y: 40,
        width: 60,
        height: 25,
        text: 'API',
        originalText: 'API',
        fontSize: 20,
        fontFamily: 3,
        textAlign: 'center',
      }),
      element({ id: 'target', type: 'ellipse', x: 400, y: 20, width: 120, height: 80 }),
      element({
        id: 'arrow',
        type: 'arrow',
        x: 170,
        y: 60,
        width: 230,
        height: 0,
        points: [
          [0, 0],
          [230, 0],
        ],
        startBinding: { elementId: 'box', focus: 0, gap: 4 },
        endBinding: { elementId: 'target', focus: 0, gap: 4 },
      }),
      element({ id: 'frame', type: 'frame', x: 0, y: 0, width: 600, height: 300, name: 'Auth flow' }),
      element({ id: 'gone', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true }),
      element({ id: 'scribble', type: 'freedraw', x: 0, y: 0, width: 10, height: 10 }),
    ]
  }

  run('toSkeleton skips deleted elements and kinds an agent cannot author', () => {
    const projected = toSkeleton(scene()).map((skeleton) => skeleton.id)
    assert.ok(!projected.includes('gone'))
    assert.ok(!projected.includes('scribble'))
  })

  run('toSkeleton folds a bound label into its container and drops the text element', () => {
    const elements = scene()
    const projected = toSkeleton(elements)
    assert.ok(!projected.some((skeleton) => skeleton.id === 'label'), 'the label is not its own element')
    const box = skeletonFor(elements, 'box')
    assert.equal(box.text, 'API')
    assert.equal(box.fontFamily, 'code')
    assert.equal(box.fontSize, 20)
    assert.equal(box.textAlign, 'center')
  })

  run('toSkeleton folds bindings into the ids of the shapes an arrow joins', () => {
    const arrow = skeletonFor(scene(), 'arrow')
    assert.equal(arrow.startElementId, 'box')
    assert.equal(arrow.endElementId, 'target')
    // Bound at both ends with two points: the pair says everything, so the
    // coordinates the worker owns are not handed back to the agent.
    assert.equal(arrow.points, undefined)
  })

  run('toSkeleton emits absolute points for a multi-point or unbound linear element', () => {
    const elements = [
      element({
        id: 'elbow',
        type: 'arrow',
        x: 100,
        y: 100,
        points: [
          [0, 0],
          [50, 0],
          [50, 40],
        ],
        startBinding: { elementId: 'a', focus: 0, gap: 4 },
        endBinding: { elementId: 'b', focus: 0, gap: 4 },
        elbowed: true,
      }),
      element({
        id: 'loose',
        type: 'line',
        x: 10,
        y: 10,
        points: [
          [0, 0],
          [30, 30],
        ],
      }),
    ]
    assert.deepEqual(skeletonFor(elements, 'elbow').points, [
      [100, 100],
      [150, 100],
      [150, 140],
    ])
    assert.equal(skeletonFor(elements, 'elbow').elbowed, true)
    assert.deepEqual(skeletonFor(elements, 'loose').points, [
      [10, 10],
      [40, 40],
    ])
  })

  run('toSkeleton rounds coordinates and reads roundness as a flag', () => {
    const box = skeletonFor(scene(), 'box')
    assert.equal(box.x, 10)
    assert.equal(box.y, 21)
    assert.equal(box.width, 160)
    assert.equal(box.rounded, true)
    assert.equal(skeletonFor(scene(), 'target').rounded, undefined)
  })

  run('toSkeleton reports a frame by name with the elements it holds', () => {
    const frame = skeletonFor(scene(), 'frame')
    assert.equal(frame.name, 'Auth flow')
    assert.deepEqual(frame.children, ['box'])
  })

  run('toSkeleton omits the editor default styles and keeps the rest', () => {
    const elements = [
      element({
        id: 'plain',
        type: 'rectangle',
        x: 0,
        y: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeStyle: 'solid',
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
      }),
      element({
        id: 'styled',
        type: 'rectangle',
        x: 0,
        y: 0,
        strokeColor: '#e03131',
        backgroundColor: '#ffc9c9',
        fillStyle: 'hachure',
        strokeStyle: 'dashed',
        strokeWidth: 4,
        roughness: 0,
        opacity: 40,
      }),
    ]
    assert.deepEqual(skeletonFor(elements, 'plain'), { id: 'plain', type: 'rectangle', x: 0, y: 0 })
    const styled = skeletonFor(elements, 'styled')
    assert.equal(styled.strokeColor, '#e03131')
    assert.equal(styled.backgroundColor, '#ffc9c9')
    assert.equal(styled.fillStyle, 'hachure')
    assert.equal(styled.strokeStyle, 'dashed')
    assert.equal(styled.strokeWidth, 4)
    assert.equal(styled.roughness, 0)
    assert.equal(styled.opacity, 40)
  })

  run('canvasFontFamilyName names the three voices and defaults to hand-drawn', () => {
    assert.equal(canvasFontFamilyName(5), 'hand')
    assert.equal(canvasFontFamilyName(1), 'hand')
    assert.equal(canvasFontFamilyName(2), 'normal')
    assert.equal(canvasFontFamilyName(6), 'normal')
    assert.equal(canvasFontFamilyName(3), 'code')
    assert.equal(canvasFontFamilyName(8), 'code')
    assert.equal(canvasFontFamilyName(99), 'hand')
    assert.equal(canvasFontFamilyName(undefined), 'hand')
  })

  run('a label whose container is gone stays visible as its own element', () => {
    const elements = [element({ id: 'orphan', type: 'text', containerId: 'missing', x: 0, y: 0, text: 'stranded' })]
    assert.equal(skeletonFor(elements, 'orphan').text, 'stranded')
  })

  // --- validation -------------------------------------------------------------

  run('validateSkeleton accepts a well-formed create', () => {
    assert.deepEqual(validateSkeleton({ type: 'rectangle', x: 0, y: 0, width: 100, text: 'API' }), [])
  })

  run('validateSkeleton requires type, x and y on a create', () => {
    const errors = validateSkeleton({ width: 10 }, { label: 'create[0]' })
    assert.equal(errors.length, 3)
    assert.match(messages(errors), /create\[0\]\.type/)
    assert.match(messages(errors), /create\[0\]\.x/)
    assert.match(messages(errors), /create\[0\]\.y/)
  })

  run('validateSkeleton names the offending index and field', () => {
    const errors = validateSkeleton({ type: 'rectangle', x: 0, y: 0, opacity: '40' }, { label: 'create[3]' })
    assert.deepEqual(codes(errors), ['invalid_edit'])
    assert.equal(errors[0].message, 'create[3].opacity must be a finite number.')
  })

  run('validateSkeleton rejects unknown keys, wrong types and non-finite numbers', () => {
    assert.match(messages(validateSkeleton({ type: 'rectangle', x: 0, y: 0, colour: 'red' })), /unknown field "colour"/)
    assert.match(messages(validateSkeleton({ type: 'triangle', x: 0, y: 0 })), /must be one of rectangle/)
    assert.match(messages(validateSkeleton({ type: 'rectangle', x: 0, y: 0, text: 7 })), /text must be a string/)
    assert.match(messages(validateSkeleton({ type: 'rectangle', x: Number.NaN, y: 0 })), /x must be a finite number/)
    assert.match(
      messages(validateSkeleton({ type: 'rectangle', x: 0, y: Number.POSITIVE_INFINITY })),
      /y must be a finite number/,
    )
    assert.match(messages(validateSkeleton({ type: 'rectangle', x: 0, y: 0, locked: 'yes' })), /must be true or false/)
    assert.match(messages(validateSkeleton({ type: 'rectangle', x: 0, y: 0, fillStyle: 'gradient' })), /fillStyle/)
    assert.match(messages(validateSkeleton({ type: 'line', x: 0, y: 0, points: [[0, 0], [1]] })), /points\[1\]/)
    assert.match(
      messages(validateSkeleton({ type: 'frame', x: 0, y: 0, children: ['a', 2] })),
      /children must contain ids/,
    )
    assert.match(messages(validateSkeleton('a string')), /must be an object/)
  })

  run('validateSkeleton refuses identity fields in an update patch', () => {
    assert.deepEqual(validateSkeleton({ text: 'new' }, { partial: true }), [])
    const errors = validateSkeleton({ id: 'r1', type: 'ellipse' }, { partial: true, label: 'update[0].set' })
    assert.equal(errors.length, 2)
    assert.match(messages(errors), /must not set "id"/)
    assert.match(messages(errors), /must not set "type"/)
  })

  run('validateEditRequest accepts an edit that only names what exists', () => {
    const errors = validateEditRequest(
      {
        delete: ['old'],
        update: [{ id: 'box', set: { text: 'Gateway' } }],
        create: [
          { tempId: 't1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, text: 'New' },
          { type: 'arrow', x: 0, y: 0, startElementId: 't1', endElementId: 'box' },
        ],
      },
      ['box', 'old'],
    )
    assert.deepEqual(errors, [])
  })

  run('validateEditRequest rejects unknown top-level and entry keys', () => {
    assert.match(messages(validateEditRequest({ move: [] }, [])), /unknown field "move"/)
    assert.match(
      messages(validateEditRequest({ update: [{ id: 'a', set: {}, force: true }] }, ['a'])),
      /update\[0\] has an unknown field "force"/,
    )
    assert.match(messages(validateEditRequest('nope', [])), /An edit must be an object/)
  })

  run('validateEditRequest rejects updates and deletes of ids the board does not hold', () => {
    const errors = validateEditRequest({ delete: ['ghost'], update: [{ id: 'other', set: {} }] }, ['box'])
    assert.deepEqual(codes(errors), ['unknown_element', 'unknown_element'])
    assert.match(messages(errors), /delete\[0\] names ghost/)
    assert.match(messages(errors), /update\[0\]\.id names other/)
  })

  run('validateEditRequest rejects a reference that is neither an id nor a tempId', () => {
    const errors = validateEditRequest(
      {
        create: [
          { type: 'arrow', x: 0, y: 0, startElementId: 'box', endElementId: 'nowhere' },
          { type: 'frame', x: 0, y: 0, children: ['box', 'phantom'] },
        ],
      },
      ['box'],
    )
    assert.deepEqual(codes(errors), ['unknown_element', 'unknown_element'])
    assert.match(messages(errors), /endElementId names nowhere/)
    assert.match(messages(errors), /children\[1\] names phantom/)
  })

  run('validateEditRequest resolves a reference to a tempId created later in the same edit', () => {
    const errors = validateEditRequest(
      {
        create: [
          { type: 'arrow', x: 0, y: 0, startElementId: 't2', endElementId: 't2' },
          { tempId: 't2', type: 'rectangle', x: 0, y: 0 },
        ],
      },
      [],
    )
    assert.deepEqual(errors, [])
  })

  run('validateEditRequest rejects duplicate tempIds', () => {
    const errors = validateEditRequest(
      {
        create: [
          { tempId: 'a', type: 'rectangle', x: 0, y: 0 },
          { tempId: 'a', type: 'ellipse', x: 0, y: 0 },
        ],
      },
      [],
    )
    assert.match(messages(errors), /tempId "a" is used twice/)
  })

  run('validateEditRequest caps a single edit at 500 creates', () => {
    const create = Array.from({ length: CANVAS_MAX_CREATES_PER_EDIT }, () => ({ type: 'rectangle', x: 0, y: 0 }))
    assert.deepEqual(validateEditRequest({ create }, []), [])
    const errors = validateEditRequest({ create: [...create, { type: 'rectangle', x: 0, y: 0 }] }, [])
    assert.deepEqual(codes(errors), ['invalid_edit'])
    assert.match(messages(errors), /at most 500 elements; this one creates 501/)
  })

  run('validateEditRequest rejects the wrong shape for each section', () => {
    assert.match(messages(validateEditRequest({ delete: 'box' }, ['box'])), /edit\.delete must be an array/)
    assert.match(messages(validateEditRequest({ update: {} }, [])), /edit\.update must be an array/)
    assert.match(messages(validateEditRequest({ create: 'one' }, [])), /edit\.create must be an array/)
    assert.match(messages(validateEditRequest({ delete: [7] }, [])), /delete\[0\] must be an id string/)
    assert.match(messages(validateEditRequest({ update: [{ id: 'box' }] }, ['box'])), /update\[0\]\.set is required/)
    assert.match(messages(validateEditRequest({ update: ['box'] }, ['box'])), /update\[0\] must be an object/)
  })

  run('validateEditRequest reports every problem, not the first', () => {
    const errors = validateEditRequest(
      { delete: ['ghost'], create: [{ type: 'rectangle', x: 'left', y: 0, colour: 'red' }] },
      [],
    )
    assert.ok(errors.length >= 3, messages(errors))
  })

  console.log('canvas skeleton tests passed')
})
