import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import React, { type JSX } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import * as icons from '../AppIcons'

// The Beam and the machine kinds (owner ruling 2026-10-04) are drawn three
// times: the React twin in `AppIcons.tsx`, the framework-neutral asset in
// `design-system/glyphs/`, and the demo in the glyphs component page that the
// catalog is built from. The catalog is what a reviewer looks at, so a demo
// that still draws the retired mark under the new name tells them the wrong
// thing about the product.

const DESIGN_SYSTEM = join(process.cwd(), 'design-system')

type Glyph = (props: { className?: string }) => JSX.Element

/** Component export → the asset it mirrors (and the demo symbol `g-<asset>`). */
const FAMILY: Array<[string, string]> = [
  ['RemoteMachineGlyph', 'remote-machine'],
  ['WslMachineGlyph', 'wsl-machine'],
  ['MachineMiniGlyph', 'machine-mini'],
  ['MachineTowerGlyph', 'machine-tower'],
  ['MachineServerGlyph', 'machine-server'],
  ['MachineCloudGlyph', 'machine-cloud'],
  ['MachineContainerGlyph', 'machine-container'],
  ['MachineBoardGlyph', 'machine-board'],
]

const dom = new JSDOM('<!doctype html><html><body></body></html>')

/** A drawing as what it draws: each shape's tag and geometry, in order. */
function shapes(root: Element): string[] {
  return Array.from(root.querySelectorAll('path, rect, circle, ellipse, line, polyline')).map((node) => {
    const tag = node.tagName.toLowerCase()
    const geometry = ['d', 'x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r', 'points', 'x1', 'y1', 'x2', 'y2']
      .map((name) => node.getAttribute(name))
      .filter((value) => value !== null)
      .join(' ')
    return `${tag} ${geometry}`
  })
}

function parse(markup: string): Element {
  const host = dom.window.document.createElement('div')
  host.innerHTML = markup
  return host
}

test('each machine glyph and its asset are one drawing', () => {
  const registry = icons as unknown as Record<string, Glyph>
  for (const [name, asset] of FAMILY) {
    assert.ok(registry[name], `${name} is still exported from AppIcons`)
    const component = parse(renderToStaticMarkup(React.createElement(registry[name])))
    const disk = parse(readFileSync(join(DESIGN_SYSTEM, 'glyphs', `${asset}.svg`), 'utf8'))
    assert.deepEqual(shapes(component), shapes(disk), `${name} has drifted from glyphs/${asset}.svg`)
  }
})

test('the glyphs page demos the Beam and every machine kind as their assets draw them', () => {
  const page = parse(readFileSync(join(DESIGN_SYSTEM, 'components', 'glyphs', 'component.html'), 'utf8'))
  for (const [, asset] of FAMILY) {
    const symbol = page.querySelector(`symbol#g-${asset}`)
    assert.ok(symbol, `the glyphs page has no demo for ${asset}`)
    assert.ok(page.querySelector(`use[href="#g-${asset}"]`), `the glyphs page never shows ${asset}`)
    const disk = parse(readFileSync(join(DESIGN_SYSTEM, 'glyphs', `${asset}.svg`), 'utf8'))
    assert.deepEqual(shapes(symbol), shapes(disk), `the demo of ${asset} is not the asset's drawing`)
  }
})

test('the command palette page draws the Beam for a machine row', () => {
  const page = readFileSync(join(DESIGN_SYSTEM, 'components', 'command-palette', 'component.html'), 'utf8')
  const beam = parse(readFileSync(join(DESIGN_SYSTEM, 'glyphs', 'remote-machine.svg'), 'utf8'))
  assert.ok(!page.includes('y="2.8" width="12" height="4.6"'), 'the retired stacked-server mark is gone')
  const marks = Array.from(parse(page).querySelectorAll('svg.ds-command-palette-option-mark'))
  assert.ok(
    marks.some((mark) => JSON.stringify(shapes(mark)) === JSON.stringify(shapes(beam))),
    'a machine row wears the Beam',
  )
})
