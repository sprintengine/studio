import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LifecycleGlyph } from './LifecycleGlyph'
import type { LifecycleState } from '../../../../shared/lifecycle-state'

// The lifecycle vocabulary's one rule: STATE READS BY SHAPE, and colour only
// reinforces. A test that only checked "it renders an svg" would not catch a
// state told apart by tone alone, so what is asserted is that no two states in
// the whole vocabulary draw the same thing.

const dom = new JSDOM('<!doctype html><html><body></body></html>')

// Every state, kept exhaustive by the Record type: a new state fails to compile
// here until it is listed, and then has to draw a distinct glyph.
const EVERY_STATE: Record<LifecycleState, true> = {
  todo: true,
  idea: true,
  ready: true,
  blocked: true,
  in_progress: true,
  paused: true,
  needs_input: true,
  done: true,
  archived: true,
  failed: true,
}

const STATES = Object.keys(EVERY_STATE) as LifecycleState[]

function svgFor(node: React.ReactElement): Element {
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(node)
  const svg = host.firstElementChild
  assert.ok(svg, 'rendered nothing')
  return svg
}

/** The geometry alone — no classes, no ink — so two states can be compared by shape. */
function drawing(svg: Element): string {
  const shapes = Array.from(svg.querySelectorAll('circle, path, rect, ellipse')).map((node) => {
    const attrs = Array.from(node.attributes)
      .filter((a) => a.name !== 'class')
      .map((a) => `${a.name}=${a.value}`)
      .sort()
    return `${node.tagName}[${attrs.join(' ')}]`
  })
  return JSON.stringify(shapes)
}

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

run('no two lifecycle states draw the same shape', () => {
  const byDrawing = new Map<string, LifecycleState[]>()
  for (const state of STATES) {
    // `live` off: the spinner is a class, not a shape, and would not affect this
    // either way — but a frozen glyph is what a grayscale reader sees.
    const key = drawing(svgFor(<LifecycleGlyph state={state} live={false} />))
    byDrawing.set(key, [...(byDrawing.get(key) ?? []), state])
  }
  const collisions = [...byDrawing.values()].filter((states) => states.length > 1)
  assert.deepEqual(
    collisions,
    [],
    `these states are distinguishable only by colour: ${collisions.map((s) => s.join(' / ')).join(', ')}`,
  )
  assert.equal(byDrawing.size, STATES.length, 'every state has its own drawing')
})

run('a labelled glyph speaks and a decorative one is hidden', () => {
  const labelled = svgFor(<LifecycleGlyph state="done" label="Done" />)
  assert.equal(labelled.getAttribute('role'), 'img')
  assert.equal(labelled.getAttribute('aria-label'), 'Done')
  assert.equal(labelled.getAttribute('aria-hidden'), null)

  const decorative = svgFor(<LifecycleGlyph state="done" />)
  assert.equal(decorative.getAttribute('aria-hidden'), 'true')
  assert.equal(decorative.getAttribute('aria-label'), null)
})

run('every state holds the 16-grid at the family stroke band', () => {
  for (const state of STATES) {
    const svg = svgFor(<LifecycleGlyph state={state} live={false} />)
    assert.equal(svg.getAttribute('viewBox'), '0 0 16 16', `${state}: not drawn on the 16-grid`)
    assert.equal(svg.getAttribute('fill'), 'none', `${state}: line work is fill="none"`)
    for (const width of svg.outerHTML.matchAll(/stroke-width="([\d.]+)"/g)) {
      const value = Number(width[1])
      assert.ok(value >= 1.2 && value <= 1.5, `${state}: stroke ${value} is outside the 16-grid band 1.2–1.5`)
    }
  }
})

if (failures > 0) throw new Error(`${failures} LifecycleGlyph contract(s) failed`)
console.log(`ok - LifecycleGlyph: ${STATES.length} states, ${STATES.length} distinct shapes`)
