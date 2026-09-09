import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LifecycleGlyph, LIFECYCLE_LABEL } from './LifecycleGlyph'
import { PullRequestGlyph } from './PullRequestGlyph'
import type { LifecycleState } from '../../../../shared/sprintengine/run-types'

// The lifecycle vocabulary's one rule: STATE READS BY SHAPE, and colour only
// reinforces. It held for sixteen of the eighteen states and not for the last
// two — `done_unmerged` and `done_merged` shared one branch fork and were told
// apart by tone alone, under a ruling (and a sanctioned exception in the glyphs
// entry) that a distinct merge shape read as noise at 16 px.
//
// Both are retired (epic pull-request-marks, decision 12), and this suite is
// what keeps them retired: the two states now draw the OPEN and MERGED pull
// request marks, the same drawings `PullRequestGlyph` renders, and the tones
// stay the lifecycle tones they always were. A test that only checked "it
// renders an svg" would not have caught the defect this fixes, so what is
// asserted is that no two states in the whole vocabulary draw the same thing.

const dom = new JSDOM('<!doctype html><html><body></body></html>')

const STATES = Object.keys(LIFECYCLE_LABEL) as LifecycleState[]

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

run('the branch pair draws the pull request marks, not a private fork', () => {
  const unmerged = drawing(svgFor(<LifecycleGlyph state="done_unmerged" />))
  const merged = drawing(svgFor(<LifecycleGlyph state="done_merged" />))

  assert.equal(
    unmerged,
    drawing(svgFor(<PullRequestGlyph state="open" />)),
    'complete-but-not-merged is the OPEN pull request mark',
  )
  assert.equal(
    merged,
    drawing(svgFor(<PullRequestGlyph state="merged" />)),
    'complete-and-merged is the MERGED pull request mark',
  )
  assert.notEqual(unmerged, merged, 'and they are two shapes, which is the whole point')
})

run('the branch pair keeps its LIFECYCLE tones, which are not the pull request tones', () => {
  const classOf = (state: LifecycleState) => svgFor(<LifecycleGlyph state={state} />).getAttribute('class') ?? ''
  // Unmerged is `--tone-good` (a lifecycle "this is complete"), NOT the accent a
  // pull request's own open state takes. The shapes came from the pull request
  // family; the tones did not, and conflating them would recolour the backlog.
  assert.ok(classOf('done_unmerged').includes('--tone-good'), 'unmerged stays the completion green')
  assert.ok(!classOf('done_unmerged').includes('--accent-primary'), 'unmerged did not take the PR open accent')
  assert.ok(classOf('done_merged').includes('--tone-merged'), 'merged stays the merged violet')
})

run('a labelled glyph speaks and a decorative one is hidden', () => {
  const labelled = svgFor(<LifecycleGlyph state="done_merged" label={LIFECYCLE_LABEL.done_merged} />)
  assert.equal(labelled.getAttribute('role'), 'img')
  assert.equal(labelled.getAttribute('aria-label'), 'Merged')
  assert.equal(labelled.getAttribute('aria-hidden'), null)

  const decorative = svgFor(<LifecycleGlyph state="done_merged" />)
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
