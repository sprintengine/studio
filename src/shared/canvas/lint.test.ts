import assert from 'node:assert/strict'

import type { CanvasElement, CanvasLintIssueType } from './types'
import { CANVAS_LINT_COLLECT_LIMIT, CANVAS_LINT_MAX_ISSUES, CANVAS_LINT_SEVERITY_WEIGHT, lintScene } from './lint'
import { test } from 'vitest'

test('lint', async () => {
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

  function box(id: string, x: number, y: number, width = 100, height = 60, extra: Partial<CanvasElement> = {}) {
    return element({ id, type: 'rectangle', x, y, width, height, ...extra })
  }

  function has(elements: CanvasElement[], type: CanvasLintIssueType): boolean {
    return lintScene(elements).issues.some((issue) => issue.type === type)
  }

  function assertFlags(elements: CanvasElement[], type: CanvasLintIssueType): void {
    assert.equal(has(elements, type), true, `expected ${type}`)
  }

  function assertClean(elements: CanvasElement[], type: CanvasLintIssueType): void {
    const issues = lintScene(elements).issues.filter((issue) => issue.type === type)
    assert.deepEqual(issues, [], `expected no ${type}`)
  }

  run('duplicate_id: the same id twice, and not once', () => {
    assertFlags([box('a', 0, 0), box('a', 400, 0)], 'duplicate_id')
    assertClean([box('a', 0, 0), box('b', 400, 0)], 'duplicate_id')
  })

  run('dangling_binding: an end or a container that is not on the board', () => {
    const arrow = element({
      id: 'arrow',
      type: 'arrow',
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [300, 0],
      ],
      endBinding: { elementId: 'ghost', focus: 0, gap: 4 },
    })
    assertFlags([arrow], 'dangling_binding')
    assertFlags(
      [
        box('gone', 0, 0, 100, 60, { isDeleted: true }),
        element({ id: 'label', type: 'text', containerId: 'gone', x: 0, y: 0, text: 'stranded' }),
      ],
      'dangling_binding',
    )
    assertClean(boundPair(), 'dangling_binding')
  })

  // A shape, its label, a target and an arrow, all bound in both directions.
  function boundPair(): CanvasElement[] {
    return [
      box('from', 0, 0, 160, 80, {
        boundElements: [
          { id: 'label', type: 'text' },
          { id: 'arrow', type: 'arrow' },
        ],
      }),
      element({
        id: 'label',
        type: 'text',
        containerId: 'from',
        x: 20,
        y: 30,
        width: 60,
        height: 25,
        text: 'API',
        fontSize: 20,
      }),
      box('to', 500, 0, 160, 80, { boundElements: [{ id: 'arrow', type: 'arrow' }] }),
      element({
        id: 'arrow',
        type: 'arrow',
        x: 165,
        y: 40,
        width: 330,
        height: 0,
        points: [
          [0, 0],
          [330, 0],
        ],
        startBinding: { elementId: 'from', focus: 0, gap: 4 },
        endBinding: { elementId: 'to', focus: 0, gap: 4 },
      }),
    ]
  }

  run('a correctly drawn two-box diagram lints clean and scores 100', () => {
    const report = lintScene(boundPair())
    assert.deepEqual(report.issues, [])
    assert.equal(report.score, 100)
    assert.equal(report.omitted, 0)
  })

  run('one_way_binding: an arrow the shape does not list, and the reverse', () => {
    const missingOnShape = boundPair().map((entry) => (entry.id === 'to' ? { ...entry, boundElements: [] } : entry))
    assertFlags(missingOnShape, 'one_way_binding')

    const missingOnArrow = boundPair().map((entry) => (entry.id === 'arrow' ? { ...entry, endBinding: null } : entry))
    assertFlags(missingOnArrow, 'one_way_binding')

    const labelNotListed = boundPair().map((entry) =>
      entry.id === 'from' ? { ...entry, boundElements: [{ id: 'arrow', type: 'arrow' as const }] } : entry,
    )
    assertFlags(labelNotListed, 'one_way_binding')

    assertClean(boundPair(), 'one_way_binding')
  })

  run('text_overflow: a label wider or taller than the shape that holds it', () => {
    const wide = [
      box('b', 0, 0, 80, 60, { boundElements: [{ id: 't', type: 'text' }] }),
      element({
        id: 't',
        type: 'text',
        containerId: 'b',
        x: 0,
        y: 0,
        text: 'Authentication gateway service',
        originalText: 'Authentication gateway service',
        fontSize: 20,
      }),
    ]
    assertFlags(wide, 'text_overflow')

    const tall = [
      box('b', 0, 0, 600, 30, { boundElements: [{ id: 't', type: 'text' }] }),
      element({
        id: 't',
        type: 'text',
        containerId: 'b',
        x: 0,
        y: 0,
        text: 'one\ntwo\nthree',
        originalText: 'one\ntwo\nthree',
        fontSize: 20,
      }),
    ]
    assertFlags(tall, 'text_overflow')

    const fits = [
      box('b', 0, 0, 300, 100, { boundElements: [{ id: 't', type: 'text' }] }),
      element({ id: 't', type: 'text', containerId: 'b', x: 0, y: 0, text: 'API', originalText: 'API', fontSize: 20 }),
    ]
    assertClean(fits, 'text_overflow')
  })

  run('overlap: two shapes on top of each other', () => {
    assertFlags([box('a', 0, 0), box('b', 50, 30)], 'overlap')
    assertClean([box('a', 0, 0), box('b', 400, 0)], 'overlap')
  })

  run('overlap forgives a shape and its own bound label', () => {
    assertClean(
      [
        box('b', 0, 0, 160, 80, { boundElements: [{ id: 't', type: 'text' }] }),
        element({ id: 't', type: 'text', containerId: 'b', x: 20, y: 30, width: 60, height: 25, text: 'API' }),
      ],
      'overlap',
    )
  })

  run('overlap forgives an element inside its frame', () => {
    assertClean(
      [
        element({ id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 300, name: 'Zone' }),
        box('inner', 20, 20, 100, 60, { frameId: 'f' }),
      ],
      'overlap',
    )
    // Even one that hangs over the frame's edge: it is still the frame's.
    assertClean(
      [
        element({ id: 'f', type: 'frame', x: 0, y: 0, width: 200, height: 100, name: 'Zone' }),
        box('inner', 150, 50, 200, 200, { frameId: 'f' }),
      ],
      'overlap',
    )
  })

  run('overlap forgives an arrow and the shapes it is bound to', () => {
    // The arrow's box spans both shapes, which is what a bound arrow does.
    const elements = [
      box('from', 0, 0, 100, 100, { boundElements: [{ id: 'arrow', type: 'arrow' }] }),
      box('to', 90, 0, 100, 100, { boundElements: [{ id: 'arrow', type: 'arrow' }] }),
      element({
        id: 'arrow',
        type: 'arrow',
        x: 20,
        y: 50,
        width: 150,
        height: 30,
        points: [
          [0, 0],
          [150, 30],
        ],
        startBinding: { elementId: 'from', focus: 0, gap: 4 },
        endBinding: { elementId: 'to', focus: 0, gap: 4 },
      }),
    ]
    const overlaps = lintScene(elements).issues.filter((issue) => issue.type === 'overlap')
    assert.deepEqual(
      overlaps.map((issue) => issue.elementIds),
      [['from', 'to']],
      'only the two boxes are flagged',
    )
  })

  run('overlap forgives containment, grouped or not', () => {
    assertClean([box('outer', 0, 0, 400, 300), box('inner', 50, 50, 100, 60)], 'overlap')
    assertClean(
      [box('bg', 0, 0, 400, 300, { groupIds: ['g'] }), box('card', 50, 50, 100, 60, { groupIds: ['g'] })],
      'overlap',
    )
  })

  run('cramped: a gap under 40px, but not a comfortable one', () => {
    assertFlags([box('a', 0, 0), box('b', 120, 0)], 'cramped')
    assertClean([box('a', 0, 0), box('b', 200, 0)], 'cramped')
    assertClean([box('a', 0, 0), box('b', 141, 0)], 'cramped')
  })

  run('short_arrow: under 80px of travel', () => {
    const arrow = (length: number) =>
      element({
        id: 'arrow',
        type: 'arrow',
        x: 0,
        y: 0,
        width: length,
        height: 0,
        points: [
          [0, 0],
          [length, 0],
        ],
      })
    assertFlags([arrow(40)], 'short_arrow')
    assertClean([arrow(200)], 'short_arrow')
  })

  run('arrow_tip_inside_shape: an end buried in a shape it is not bound to', () => {
    const inside = [
      box('target', 200, 0, 200, 200),
      element({
        id: 'arrow',
        type: 'arrow',
        x: 0,
        y: 100,
        points: [
          [0, 0],
          [300, 0],
        ],
      }),
    ]
    assertFlags(inside, 'arrow_tip_inside_shape')

    const bound = inside.map((entry) =>
      entry.id === 'arrow' ? { ...entry, endBinding: { elementId: 'target', focus: 0, gap: 4 } } : entry,
    )
    assertClean(bound, 'arrow_tip_inside_shape')
  })

  function fan(focusA: number, focusB: number): CanvasElement[] {
    const target = box('target', 400, 0, 100, 100, {
      boundElements: [
        { id: 'a1', type: 'arrow' as const },
        { id: 'a2', type: 'arrow' as const },
      ],
    })
    const source = (id: string, y: number) =>
      box(id, 0, y, 100, 60, { boundElements: [{ id: id === 's1' ? 'a1' : 'a2', type: 'arrow' as const }] })
    const arrow = (id: string, from: string, y: number, focus: number) =>
      element({
        id,
        type: 'arrow',
        x: 100,
        y,
        width: 300,
        height: 0,
        points: [
          [0, 0],
          [300, 0],
        ],
        startBinding: { elementId: from, focus: 0, gap: 4 },
        endBinding: { elementId: 'target', focus, gap: 4 },
      })
    return [target, source('s1', 0), source('s2', 200), arrow('a1', 's1', 60, focusA), arrow('a2', 's2', 250, focusB)]
  }

  run('fan_in_same_focus: two arrows landing on one point from the same side', () => {
    assertFlags(fan(0, 0.01), 'fan_in_same_focus')
    assertClean(fan(-0.4, 0.4), 'fan_in_same_focus')
  })

  run('fan_in_same_focus ignores two arrows out of the same source', () => {
    const elements = fan(0, 0).map((entry) =>
      entry.id === 'a2' ? { ...entry, startBinding: { elementId: 's1', focus: 0, gap: 4 } } : entry,
    )
    assertClean(elements, 'fan_in_same_focus')
  })

  run('deleted elements are not linted', () => {
    assertClean([box('a', 0, 0), box('b', 50, 30, 100, 60, { isDeleted: true })], 'overlap')
  })

  run('the score is 100 less the weight of every issue, floored at zero', () => {
    const report = lintScene([box('a', 0, 0), box('b', 50, 30)])
    assert.equal(report.issues.length, 1)
    assert.equal(report.score, 100 - CANVAS_LINT_SEVERITY_WEIGHT.medium)

    const pile: CanvasElement[] = []
    for (let i = 0; i < 30; i += 1) pile.push(box(`dup-${i % 2}`, i * 5, 0))
    assert.equal(lintScene(pile).score, 0, 'a badly broken board bottoms out rather than going negative')
  })

  run('the report is capped, and says how many issues it did not list', () => {
    const pile: CanvasElement[] = []
    // Every box overlaps every other, so the pair count runs well past the cap.
    for (let i = 0; i < 20; i += 1) pile.push(box(`b-${i}`, i, i))
    const report = lintScene(pile)
    assert.equal(report.issues.length, CANVAS_LINT_MAX_ISSUES)
    assert.equal(report.omitted, (20 * 19) / 2 - CANVAS_LINT_MAX_ISSUES)
  })

  run('issue order is deterministic: severity, then type, then ids', () => {
    const elements = [
      ...boundPair().map((entry) => (entry.id === 'to' ? { ...entry, boundElements: [] } : entry)),
      box('dup', 1000, 0),
      box('dup', 1000, 0),
    ]
    const report = lintScene(elements)
    const order = report.issues.map((issue) => `${issue.severity}:${issue.type}`)
    assert.equal(order[0], 'high:duplicate_id')
    assert.deepEqual(order, [...order].sort(bySeverityThenType))
    assert.deepEqual(lintScene(elements), report)
  })

  function bySeverityThenType(a: string, b: string): number {
    const rank = (entry: string): number => ({ high: 0, medium: 1, low: 2 })[entry.split(':')[0] as 'high'] ?? 3
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a < b ? -1 : a > b ? 1 : 0
  }

  run('a dense pile is bounded in time and in objects, and says it stopped early', () => {
    // The shape that used to block the main thread for twenty seconds and three
    // gigabytes: every element on top of every other, so the pair count is
    // quadratic and every pair is an issue.
    const pile: CanvasElement[] = []
    for (let i = 0; i < 5000; i += 1) pile.push(box(`d-${i}`, i % 30, i % 17))
    const started = Date.now()
    const report = lintScene(pile)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `5000 stacked elements linted in ${elapsed}ms`)
    assert.equal(report.issues.length, CANVAS_LINT_MAX_ISSUES)
    assert.equal(report.truncated, true, 'a scan that stopped early says so')
    assert.ok(report.omitted >= CANVAS_LINT_COLLECT_LIMIT - CANVAS_LINT_MAX_ISSUES)
    assert.equal(report.score, 0)
  })

  run('a large spread-out board is still linted, and is not reported as truncated', () => {
    // The same count laid out on a grid 200px apart: nothing overlaps, nothing
    // is cramped, and the bucketing means the pairs are never looked at.
    const grid: CanvasElement[] = []
    for (let i = 0; i < 5000; i += 1) grid.push(box(`g-${i}`, (i % 100) * 200, Math.floor(i / 100) * 200, 120, 60))
    const started = Date.now()
    const report = lintScene(grid)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `5000 spread elements linted in ${elapsed}ms`)
    assert.deepEqual(report.issues, [])
    assert.equal(report.score, 100)
    assert.equal(report.truncated, undefined)
    assert.equal(report.notes, undefined)
  })

  run('an oversized element is still compared against what sits on it', () => {
    // A frame wider than the grid can index, with a box overlapping its edge:
    // the element is not in any cell, so only the oversized pass can catch it.
    const wide = box('wide', 0, 0, 400_000, 200)
    const over = box('over', 399_950, 100, 200, 300)
    assertFlags([wide, over], 'overlap')
  })

  console.log('canvas lint tests passed')
})
