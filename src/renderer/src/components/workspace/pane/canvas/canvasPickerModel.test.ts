import assert from 'node:assert/strict'

import type { CanvasBoardSummary } from '../../../../../../shared/canvas/types'
import {
  CANVAS_PICKER_PAGE_SIZE,
  canvasBoardFolder,
  canvasBoardNameIsTaken,
  canvasBoardRowLabel,
  canvasPickerPage,
  clampCanvasPage,
  describeCanvasChangedAt,
  duplicateCanvasBoardNames,
  formatCanvasChangedAt,
  uniqueCanvasBoardName,
} from './canvasPickerModel'

// The picker's arithmetic, without a renderer: where a page starts, what
// happens to a page number when the list shrinks under it, which names need a
// folder to be told apart, and how a file mtime is said in four characters.

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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function board(name: string, folder = 'diagrams', modifiedAt = 0): CanvasBoardSummary {
  return { path: `${folder}/${name}.excalidraw`, name, elementCount: 3, modifiedAt }
}

/** `count` boards named b1…bN, in the order the service hands them over. */
function boards(count: number): CanvasBoardSummary[] {
  return Array.from({ length: count }, (_, index) => board(`b${index + 1}`))
}

run('ten to a page, and the page is the slice the service already ordered', () => {
  assert.equal(CANVAS_PICKER_PAGE_SIZE, 10)
  const view = canvasPickerPage({ boards: boards(23), page: 1 })
  assert.equal(view.pageCount, 3)
  assert.equal(view.boards.length, 10)
  assert.deepEqual(
    view.boards.map((entry) => entry.name),
    ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'],
    'the order is the one it was handed, never re-sorted here',
  )
  assert.equal(view.rangeLabel, 'Showing 1–10 of 23')
})

run('the second page continues where the first stopped', () => {
  const view = canvasPickerPage({ boards: boards(23), page: 2 })
  assert.equal(view.boards[0].name, 'b11')
  assert.equal(view.boards.at(-1)?.name, 'b20')
  assert.equal(view.rangeLabel, 'Showing 11–20 of 23')
})

run('the last page is short, and says how short', () => {
  const view = canvasPickerPage({ boards: boards(23), page: 3 })
  assert.equal(view.boards.length, 3)
  assert.equal(view.rangeLabel, 'Showing 21–23 of 23')
})

run('a page number that outlived its rows lands on the last page that exists', () => {
  const view = canvasPickerPage({ boards: boards(12), page: 3 })
  assert.equal(view.page, 2)
  assert.equal(view.boards.at(-1)?.name, 'b12')
  assert.equal(clampCanvasPage(9, 3), 3)
  assert.equal(clampCanvasPage(0, 3), 1)
  assert.equal(clampCanvasPage(Number.NaN, 3), 1)
  assert.equal(clampCanvasPage(2, 0), 1, 'no pages at all is still page 1')
})

run('ten boards are one page; eleven are two', () => {
  assert.equal(canvasPickerPage({ boards: boards(10), page: 1 }).pageCount, 1)
  assert.equal(canvasPickerPage({ boards: boards(11), page: 1 }).pageCount, 2)
})

run('an empty project has one empty page and says so rather than counting to zero', () => {
  const view = canvasPickerPage({ boards: [], page: 1 })
  assert.equal(view.page, 1)
  assert.equal(view.pageCount, 1)
  assert.equal(view.rangeStart, 0)
  assert.equal(view.rangeEnd, 0)
  assert.equal(view.rangeLabel, 'No boards yet')
})

run('only a name two boards share needs its folder beside it', () => {
  const duplicates = duplicateCanvasBoardNames([
    board('architecture', 'diagrams'),
    board('auth-sequence'),
    board('architecture', 'docs/legacy'),
  ])
  assert.ok(duplicates.has('architecture'))
  assert.ok(!duplicates.has('auth-sequence'))
  assert.equal(duplicates.size, 1)
})

run('two spellings of one name are the same name for that purpose', () => {
  const duplicates = duplicateCanvasBoardNames([board('Arch', 'diagrams'), board('arch', 'docs')])
  assert.ok(duplicates.has('arch'))
})

run('a board says which folder it is in, and a bare path says the default one', () => {
  assert.equal(canvasBoardFolder('diagrams/arch.excalidraw'), 'diagrams')
  assert.equal(canvasBoardFolder('docs/legacy/arch.excalidraw'), 'docs/legacy')
  assert.equal(canvasBoardFolder('arch.excalidraw'), 'diagrams')
})

run('a unique name is the base until the base is taken', () => {
  assert.equal(uniqueCanvasBoardName('canvas', []), 'canvas')
  assert.equal(uniqueCanvasBoardName('canvas', ['diagrams/canvas.excalidraw']), 'canvas-2')
  assert.equal(
    uniqueCanvasBoardName('canvas', ['diagrams/canvas.excalidraw', 'diagrams/canvas-2.excalidraw']),
    'canvas-3',
  )
  assert.equal(
    uniqueCanvasBoardName('canvas', ['diagrams/CANVAS.excalidraw']),
    'canvas-2',
    'the same name in another case is the same file on the platforms most people are on',
  )
})

run('a name already on disk is recognised as taken, folding case where the disk does', () => {
  const taken = ['diagrams/arch.excalidraw']
  assert.equal(canvasBoardNameIsTaken('diagrams/arch.excalidraw', taken, false), true)
  assert.equal(canvasBoardNameIsTaken('diagrams/Arch.excalidraw', taken, true), true)
  assert.equal(
    canvasBoardNameIsTaken('diagrams/Arch.excalidraw', taken, false),
    false,
    'on a case-sensitive filesystem those really are two boards',
  )
  assert.equal(canvasBoardNameIsTaken('diagrams/other.excalidraw', taken, true), false)
})

run('the changed column is short, and never says "ago"', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0)
  assert.equal(formatCanvasChangedAt(now - 20_000, now), 'now')
  assert.equal(formatCanvasChangedAt(now - 5 * MINUTE, now), '5m')
  assert.equal(formatCanvasChangedAt(now - 59 * MINUTE, now), '59m')
  assert.equal(formatCanvasChangedAt(now - 2 * HOUR, now), '2h')
  assert.equal(formatCanvasChangedAt(now - 23 * HOUR, now), '23h')
  assert.equal(formatCanvasChangedAt(now - 25 * HOUR, now), 'yesterday')
  assert.equal(formatCanvasChangedAt(now - 2 * DAY, now), '2d')
  assert.equal(formatCanvasChangedAt(now - 27 * DAY, now), '27d')
  const old = formatCanvasChangedAt(now - 200 * DAY, now)
  assert.ok(!/^\d+d$/.test(old), 'past four weeks a count of days has become a date')
  assert.match(old, /\d/)
  assert.equal(formatCanvasChangedAt(undefined, now), '', 'a board with no mtime says nothing')
})

run('the same fact is said in words for anyone who cannot see the column', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0)
  assert.equal(describeCanvasChangedAt(now - 20_000, now), 'changed just now')
  assert.equal(describeCanvasChangedAt(now - MINUTE, now), 'changed 1 minute ago')
  assert.equal(describeCanvasChangedAt(now - 5 * MINUTE, now), 'changed 5 minutes ago')
  assert.equal(describeCanvasChangedAt(now - HOUR, now), 'changed 1 hour ago')
  assert.equal(describeCanvasChangedAt(now - 2 * HOUR, now), 'changed 2 hours ago')
  assert.equal(describeCanvasChangedAt(now - 25 * HOUR, now), 'changed yesterday')
  assert.equal(describeCanvasChangedAt(now - 3 * DAY, now), 'changed 3 days ago')
  assert.match(describeCanvasChangedAt(now - 200 * DAY, now), /^changed on /)
})

run('a row says its folder and its time in full, whatever the drawing leaves out', () => {
  assert.equal(
    canvasBoardRowLabel({
      name: 'checkout-flow',
      folder: 'diagrams',
      changed: 'changed 5 minutes ago',
      open: false,
    }),
    'Open board checkout-flow, in diagrams, changed 5 minutes ago',
  )
  assert.equal(
    canvasBoardRowLabel({
      name: 'architecture',
      folder: 'docs/legacy',
      changed: 'changed yesterday',
      open: true,
    }),
    'Open board architecture, in docs/legacy, changed yesterday, already open in another tab',
  )
})

if (failures > 0) {
  console.error(`${failures} canvas picker model test(s) failed`)
  process.exitCode = 1
} else {
  console.log('canvas picker model tests passed')
}
