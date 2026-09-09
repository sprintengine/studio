import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import * as glyphs from './GitActionGlyphs'
import { KebabGlyph } from './KebabGlyph'

// The Commit-window action glyphs (epic `git-commit-window`, T2). Three
// contracts the family cannot be trusted without, all read off the RENDERED
// glyph rather than the source text — a convention that only holds in the file
// that declares it is not a convention:
//
//   1. the 16-grid discipline from design-system/components/glyphs/component.md
//      — viewBox `0 0 16 16`, `fill="none"`, `currentColor` only, every stroke
//      inside the 1.2–1.5 band, nothing drawn off the grid, and `aria-hidden`
//      on every one of them (an action glyph never speaks for itself; the
//      icon-only button that hosts it carries the label);
//   2. that previous-difference is the next-difference DRAWING mirrored, not a
//      second shape that can drift;
//   3. that each React twin still draws what its framework-neutral asset in
//      `design-system/glyphs/` draws. The asset is the contract a non-React
//      consumer takes, and letting the two copies diverge is exactly how the
//      title-bar chrome ended up with two versions of one mark (Known drift).
//
// The list below is the FAMILY, and it is the whole of it. T6 shipped four
// changelist glyphs with assets and left them out of this list, so four marks
// had a framework-neutral twin that nothing held them to — which is the same
// defect as not shipping one. `ShowDiffGlyph` and `KebabGlyph` joined on
// 2026-09-09. The kebab lives in its own module rather than in
// `GitActionGlyphs.tsx` (it is the app-wide overflow trigger, not a git
// action), so the registry below takes it by name: a family check that covered
// only what sat in one file would be a check that stops at a filename.

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const glyphsDir = join(process.cwd(), 'design-system', 'glyphs')

type Glyph = (props: { className?: string }) => JSX.Element

// Every 16-grid action mark in the product, wherever its module lives. The
// kebab is not a git action — it is the app-wide overflow trigger — but it is
// one of these drawings, with an asset to stay in step with, and a family
// check that covered only the ones that happened to sit in one file would be a
// check that stops at a filename.
const REGISTRY: Record<string, Glyph> = { ...(glyphs as unknown as Record<string, Glyph>), KebabGlyph }

/** Component export → the framework-neutral asset it mirrors. */
const FAMILY: Array<[string, string]> = [
  ['RollbackGlyph', 'rollback.svg'],
  ['MoveToChangelistGlyph', 'move-to-changelist.svg'],
  ['StashGlyph', 'stash.svg'],
  ['GroupByGlyph', 'group-by.svg'],
  ['ExpandAllGlyph', 'expand-all.svg'],
  ['CollapseAllGlyph', 'collapse-all.svg'],
  ['NextDifferenceGlyph', 'next-difference.svg'],
  ['ShowDiffGlyph', 'show-diff.svg'],
  ['SideBySideGlyph', 'side-by-side.svg'],
  ['UnifiedGlyph', 'unified.svg'],
  ['GearGlyph', 'gear.svg'],
  ['OpenInEditorGlyph', 'open-in-editor.svg'],
  ['WriteCommitMessageGlyph', 'write-commit-message.svg'],
  // T6's four, added to this list on 2026-09-09: they shipped with assets and
  // with nothing asserting the twin still matched them.
  ['NewChangelistGlyph', 'new-changelist.svg'],
  ['DeleteChangelistGlyph', 'delete-changelist.svg'],
  ['EditChangelistGlyph', 'edit-changelist.svg'],
  ['CreatePatchGlyph', 'create-patch.svg'],
  ['KebabGlyph', 'kebab.svg'],
]

function render(name: string): Element {
  const Glyph = REGISTRY[name]
  assert.ok(Glyph, `${name} is not exported`)
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(React.createElement(Glyph))
  const svg = host.firstElementChild
  assert.ok(svg, `${name} rendered nothing`)
  return svg
}

// Every anchor point a `d` visits, in absolute user units. Only the commands
// this family actually draws with are understood (M/L/H/V/A/Z, absolute and
// relative) — an unrecognised command fails loudly rather than being skipped,
// because a check that silently ignores half a path proves nothing. Arc
// SWEEPS bulge outside their endpoints, so an arc also contributes its own
// radius as a bound; that is conservative, which is the safe direction here.
function pathAnchors(d: string): Array<[number, number]> {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const points: Array<[number, number]> = []
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let command = ''
  let i = 0
  const num = () => Number(tokens[i++])

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++]
    const relative = command === command.toLowerCase()
    switch (command.toUpperCase()) {
      case 'M':
      case 'L': {
        const dx = num()
        const dy = num()
        x = relative ? x + dx : dx
        y = relative ? y + dy : dy
        if (command.toUpperCase() === 'M') {
          startX = x
          startY = y
          command = relative ? 'l' : 'L' // an implicit run after M is a lineto
        }
        points.push([x, y])
        break
      }
      case 'H': {
        const dx = num()
        x = relative ? x + dx : dx
        points.push([x, y])
        break
      }
      case 'V': {
        const dy = num()
        y = relative ? y + dy : dy
        points.push([x, y])
        break
      }
      case 'A': {
        const rx = num()
        const ry = num()
        num() // x-axis rotation
        num() // large-arc flag
        num() // sweep flag
        const dx = num()
        const dy = num()
        const fromX = x
        const fromY = y
        x = relative ? x + dx : dx
        y = relative ? y + dy : dy
        points.push([x, y])
        // The bulge: the widest an arc of these radii can reach from either end.
        for (const [ax, ay] of [
          [fromX, fromY],
          [x, y],
        ]) {
          points.push([ax - rx, ay - ry], [ax + rx, ay + ry])
        }
        break
      }
      case 'Z':
        x = startX
        y = startY
        break
      default:
        throw new Error(`unhandled path command "${command}" in ${d}`)
    }
  }
  return points
}

/** Every extreme the drawing reaches, so it can be held to the grid. */
function coordinates(svg: Element): number[] {
  const out: number[] = []
  const push = (...values: number[]) => out.push(...values)
  for (const node of Array.from(svg.querySelectorAll('path, rect, circle, ellipse'))) {
    const attr = (name: string) => Number(node.getAttribute(name) ?? 0)
    switch (node.tagName.toLowerCase()) {
      case 'path':
        for (const [x, y] of pathAnchors(node.getAttribute('d') ?? '')) push(x, y)
        break
      case 'rect':
        push(attr('x'), attr('y'), attr('x') + attr('width'), attr('y') + attr('height'))
        break
      case 'circle':
        push(attr('cx') - attr('r'), attr('cx') + attr('r'), attr('cy') - attr('r'), attr('cy') + attr('r'))
        break
      default:
        push(
          attr('cx') - attr('rx'),
          attr('cx') + attr('rx'),
          attr('cy') - attr('ry'),
          attr('cy') + attr('ry')
        )
    }
  }
  return out
}

// 1 — the 16-grid discipline.
for (const [name] of FAMILY) {
  const svg = render(name)
  assert.equal(svg.getAttribute('viewBox'), '0 0 16 16', `${name}: not drawn on the 16-grid`)
  assert.equal(svg.getAttribute('fill'), 'none', `${name}: line work is fill="none"`)
  assert.equal(svg.getAttribute('aria-hidden'), 'true', `${name}: decorative is the default`)
  assert.match(
    svg.getAttribute('class') ?? '',
    /^icon-(?:xs|sm|md|lg)$/,
    `${name}: sizes from the icon ramp, nothing else`,
  )

  // ONE INK, and it is the text's. Stated over every stroke AND every fill
  // rather than "there must be a stroke": the kebab is three dots, a dot has no
  // line work, and a stroked dot is a circle pretending to be a point. What the
  // rule is actually about is that no glyph carries a colour of its own.
  const markup = svg.outerHTML
  const inks = Array.from(markup.matchAll(/(?:stroke|fill)="([^"]*)"/g)).map((match) => match[1])
  assert.ok(inks.includes('currentColor'), `${name}: inks with currentColor`)
  for (const ink of inks) {
    assert.ok(
      ink === 'currentColor' || ink === 'none',
      `${name}: "${ink}" is a colour of the glyph's own — every mark inherits the ink beside it`,
    )
  }

  for (const width of markup.matchAll(/stroke-width="([\d.]+)"/g)) {
    const value = Number(width[1])
    assert.ok(value >= 1.2 && value <= 1.5, `${name}: stroke ${value} is outside the 16-grid band 1.2–1.5`)
  }

  for (const value of coordinates(svg)) {
    assert.ok(value >= 0 && value <= 16, `${name}: coordinate ${value} falls off the 16-grid`)
  }
}

// 2 — one drawing, two directions.
{
  const next = render('NextDifferenceGlyph')
  const previous = render('PreviousDifferenceGlyph')
  const paths = (svg: Element) => Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('d'))

  assert.deepEqual(paths(previous), paths(next), 'the two hunk directions must share one drawing')
  assert.ok(
    previous.querySelector('g')?.getAttribute('transform'),
    'previous-difference is the mirror of next-difference, not a second shape'
  )
  assert.equal(
    next.querySelector('g')?.getAttribute('transform') ?? null,
    null,
    'next-difference is the unflipped drawing'
  )
}

// 3 — the React twin and the asset on disk are one mark.
for (const [name, asset] of FAMILY) {
  const svg = render(name)
  const disk = readFileSync(join(glyphsDir, asset), 'utf8')

  const componentPaths = Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('d'))
  const assetPaths = Array.from(disk.matchAll(/\sd="([^"]+)"/g)).map((m) => m[1])
  assert.deepEqual(componentPaths, assetPaths, `${name} has drifted from design-system/glyphs/${asset}`)

  const componentShapes = svg.querySelectorAll('rect, circle, ellipse').length
  const assetShapes = (disk.match(/<(?:rect|circle|ellipse)\b/g) ?? []).length
  assert.equal(componentShapes, assetShapes, `${name} and ${asset} disagree on their non-path shapes`)
}

console.log(`ok - ${FAMILY.length} action glyphs hold the 16-grid and match their assets`)
