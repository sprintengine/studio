import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PullRequestGlyph } from './PullRequestGlyph'
import { PULL_REQUEST_TONE_VAR, pullRequestTone, type PullRequestState } from '../../../../shared/git/pull-request'

// The pull request marks (epic `pull-request-marks`, decisions 1–3). Four
// contracts, all read off the RENDERED glyph rather than the source text:
//
//   1. the 16-grid discipline the glyphs entry states for this family —
//      viewBox `0 0 16 16`, `fill="none"`, `currentColor` only, stroke 1.4,
//      nothing drawn off the grid;
//   2. THREE states and no more, each a DIFFERENT drawing. This is the whole
//      point of the family: the exception that let merged-vs-unmerged be told
//      apart by colour alone is retired, so the shapes have to carry it, and a
//      test that only checked "it renders" would not notice two states quietly
//      converging on one path list;
//   3. the aria contract — `role="img"` + `aria-label` (and a `<title>`, so a
//      hover confirms) when labelled, `aria-hidden` when the row's text
//      already names the state, and never both;
//   4. that each React drawing still matches its framework-neutral twin in
//      `design-system/glyphs/`. The asset is the contract a non-React consumer
//      takes, and two copies of one mark are how a family drifts.
//
// The tone map is asserted beside them because it is the OTHER half of
// "shape first, colour second": the shapes must differ AND the tones must be
// the epic's, from one shared function rather than a per-surface guess.

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const glyphsDir = join(process.cwd(), 'design-system', 'glyphs')

const STATES: PullRequestState[] = ['open', 'merged', 'closed']

function render(props: { state: PullRequestState; label?: string; className?: string }): Element {
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(React.createElement(PullRequestGlyph, props))
  const svg = host.firstElementChild
  assert.ok(svg, `${props.state} rendered nothing`)
  return svg
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

// 1 — the 16-grid discipline.
run('every state holds the 16-grid, stroke 1.4, currentColor', () => {
  for (const state of STATES) {
    const svg = render({ state })
    assert.equal(svg.getAttribute('viewBox'), '0 0 16 16', `${state}: not drawn on the 16-grid`)
    assert.equal(svg.getAttribute('fill'), 'none', `${state}: line work is fill="none"`)

    const markup = svg.outerHTML
    const inks = Array.from(markup.matchAll(/(?:stroke|fill)="([^"]*)"/g)).map((m) => m[1])
    assert.ok(inks.includes('currentColor'), `${state}: inks with currentColor`)
    for (const ink of inks) {
      assert.ok(
        ink === 'currentColor' || ink === 'none',
        `${state}: "${ink}" is a colour of the glyph's own — the mark inherits the ink beside it`,
      )
    }

    const widths = Array.from(markup.matchAll(/stroke-width="([\d.]+)"/g)).map((m) => Number(m[1]))
    assert.ok(widths.length > 0, `${state}: draws no stroked line work`)
    for (const width of widths) {
      assert.equal(width, 1.4, `${state}: stroke ${width} is off the family's 1.4`)
    }

    // Nothing hangs off the grid. Circles are the family's only non-path
    // shapes, and every path here is straight-line/arc work whose numbers are
    // coordinates, so the bounds check is exact enough to catch a stray digit.
    for (const circle of Array.from(svg.querySelectorAll('circle'))) {
      const cx = Number(circle.getAttribute('cx'))
      const cy = Number(circle.getAttribute('cy'))
      const r = Number(circle.getAttribute('r'))
      assert.ok(cx - r >= 0 && cx + r <= 16, `${state}: a node falls off the grid horizontally`)
      assert.ok(cy - r >= 0 && cy + r <= 16, `${state}: a node falls off the grid vertically`)
    }
  }
})

// 2 — three states, three DIFFERENT drawings, and no fourth.
run('the three states are three distinguishable shapes', () => {
  assert.deepEqual(STATES, ['open', 'merged', 'closed'], 'the family is exactly three states')

  const drawing = (state: PullRequestState): string => {
    const svg = render({ state })
    const nodes = Array.from(svg.querySelectorAll('circle')).map(
      (c) => `${c.getAttribute('cx')},${c.getAttribute('cy')},${c.getAttribute('r')}`,
    )
    const paths = Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('d'))
    return JSON.stringify({ nodes, paths })
  }

  const drawings = new Map(STATES.map((state) => [state, drawing(state)]))
  assert.equal(
    new Set(drawings.values()).size,
    3,
    'two states share a drawing — the family only works because the shape carries the state',
  )

  // Named differences, so a future edit that flattens one into another fails
  // here rather than passing a set-size check on some incidental attribute.
  const nodesOf = (state: PullRequestState) =>
    Array.from(render({ state }).querySelectorAll('circle')).map((c) => Number(c.getAttribute('cy')))
  assert.deepEqual(nodesOf('open'), [3.5, 12.5, 12.5], 'open keeps its third node down on the right')
  assert.deepEqual(nodesOf('merged'), [3.5, 12.5, 8.5], 'merged brings its third node up into the middle')
  assert.deepEqual(nodesOf('closed'), [3.5, 12.5, 12.5], 'closed keeps the open armature')
  // Open and closed share the node placement, so the ENDING is what separates
  // them: closed's connector is cut short and crossed out.
  const endings = (state: PullRequestState) =>
    Array.from(render({ state }).querySelectorAll('path')).map((p) => p.getAttribute('d'))
  assert.ok(
    endings('closed').some((d) => d?.includes('9.6 7')),
    'closed ends in the cross',
  )
  assert.ok(
    endings('open').every((d) => !d?.includes('9.6 7')),
    'open does not wear the cross',
  )
})

// 3 — the aria contract.
run('a labelled glyph speaks, a decorative one is hidden', () => {
  const labelled = render({ state: 'merged', label: 'Pull request 421, merged' })
  assert.equal(labelled.getAttribute('role'), 'img', 'a labelled glyph is an image')
  assert.equal(labelled.getAttribute('aria-label'), 'Pull request 421, merged')
  assert.equal(labelled.getAttribute('aria-hidden'), null, 'a labelled glyph is not also hidden')
  assert.equal(
    labelled.querySelector('title')?.textContent,
    'Pull request 421, merged',
    'the label is also a <title>, so hovering confirms it',
  )

  const decorative = render({ state: 'open' })
  assert.equal(decorative.getAttribute('aria-hidden'), 'true', 'unlabelled is decorative')
  assert.equal(decorative.getAttribute('role'), null, 'a decorative glyph claims no role')
  assert.equal(decorative.getAttribute('aria-label'), null)
  assert.equal(decorative.querySelector('title'), null, 'a decorative glyph has no title to read out')
})

// The caller owns size and ink; the glyph owns only the geometry.
run('the caller sizes and inks it', () => {
  const svg = render({ state: 'closed', className: 'icon-xs text-[color:var(--tone-error)]' })
  const className = svg.getAttribute('class') ?? ''
  assert.ok(className.includes('icon-xs'), "the caller's size class survives")
  assert.ok(className.includes('--tone-error'), "the caller's ink survives")
  assert.ok(className.includes('shrink-0'), 'the glyph never squashes in a flex row')
})

// 4 — one mark, two copies: React and the framework-neutral asset.
run('each drawing matches its design-system asset', () => {
  for (const state of STATES) {
    const svg = render({ state })
    const disk = readFileSync(join(glyphsDir, `pull-request-${state}.svg`), 'utf8')

    const componentPaths = Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('d'))
    const assetPaths = Array.from(disk.matchAll(/\sd="([^"]+)"/g)).map((m) => m[1])
    assert.deepEqual(
      componentPaths,
      assetPaths,
      `${state} has drifted from design-system/glyphs/pull-request-${state}.svg`,
    )

    const componentNodes = Array.from(svg.querySelectorAll('circle')).map(
      (c) => `${c.getAttribute('cx')},${c.getAttribute('cy')},${c.getAttribute('r')}`,
    )
    const assetNodes = Array.from(disk.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)).map(
      (m) => `${m[1]},${m[2]},${m[3]}`,
    )
    assert.deepEqual(componentNodes, assetNodes, `${state} and its asset disagree on their nodes`)
  }
})

// The shared tone map — the other half of "shape first, colour second".
run('the tone map is the epic decision, from one shared function', () => {
  assert.equal(pullRequestTone('open'), 'accent', 'open is the one you can still act on')
  assert.equal(pullRequestTone('merged'), 'merged', 'merged takes the landed-branch violet')
  assert.equal(pullRequestTone('closed'), 'error', 'closed takes the danger red, never a muted grey')

  assert.equal(PULL_REQUEST_TONE_VAR.accent, 'var(--accent-primary)')
  assert.equal(PULL_REQUEST_TONE_VAR.merged, 'var(--tone-merged)')
  assert.equal(PULL_REQUEST_TONE_VAR.error, 'var(--tone-error)')

  // Every state resolves to a tone, and every tone to a variable — no state
  // falls through to a default, which is how an "unknown" gets in by the back
  // door (decision 3: there is no fourth state).
  for (const state of STATES) {
    assert.ok(PULL_REQUEST_TONE_VAR[pullRequestTone(state)], `${state} resolves to a CSS variable`)
  }
  assert.equal(new Set(STATES.map(pullRequestTone)).size, 3, 'the three states take three different tones')
})

if (failures > 0) throw new Error(`${failures} PullRequestGlyph contract(s) failed`)
console.log('ok - PullRequestGlyph: the three marks, their aria contract, their assets and their tones')
