import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import {
  findTerminalFileReferences,
  rangeForTerminalFileReference,
  readWrappedLogicalLine,
  resolveTerminalFileReferencePath,
} from './terminalFileLinks'

const roots = {
  workspaceRoot: '/repo',
  executionRoot: '/repo/packages/app',
}

const relative = findTerminalFileReferences(
  'Open src/renderer/src/components/panels/TerminalView.tsx:274:7 for details.',
  roots
)
assert.equal(relative.length, 1)
assert.equal(relative[0]?.text, 'src/renderer/src/components/panels/TerminalView.tsx:274:7')
assert.equal(relative[0]?.path, 'src/renderer/src/components/panels/TerminalView.tsx')
assert.equal(relative[0]?.resolvedPath, '/repo/packages/app/src/renderer/src/components/panels/TerminalView.tsx')
assert.equal(relative[0]?.line, 274)
assert.equal(relative[0]?.column, 7)

const dotRelative = findTerminalFileReferences('Edited ./src/App.tsx:42.', roots)
assert.equal(dotRelative.length, 1)
assert.equal(dotRelative[0]?.resolvedPath, '/repo/packages/app/src/App.tsx')
assert.equal(dotRelative[0]?.line, 42)

const parentRelative = findTerminalFileReferences('See ../shared/types.ts', roots)
assert.equal(parentRelative.length, 1)
assert.equal(parentRelative[0]?.resolvedPath, '/repo/packages/shared/types.ts')

const absolute = findTerminalFileReferences('Failure at /repo/src/main.ts:8', roots)
assert.equal(absolute.length, 1)
assert.equal(absolute[0]?.resolvedPath, '/repo/src/main.ts')
assert.equal(absolute[0]?.line, 8)

const urls = findTerminalFileReferences('Docs: https://example.com/src/main.ts and file://ignored', roots)
assert.equal(urls.length, 0)

const bare = findTerminalFileReferences('Do not link package.json or TerminalView.tsx without a path separator.', roots)
assert.equal(bare.length, 0)

assert.equal(resolveTerminalFileReferencePath('src/../README.md', roots), '/repo/packages/app/README.md')
assert.equal(resolveTerminalFileReferencePath('~/notes.md', roots), null)

const wrappedFirstSegment = 'Failure in src/renderer/src/components/panels/'
const wrappedSecondSegment = 'TerminalView.tsx:274:7'
const wrappedSegments = [
  { y: 10, startIndex: 0, startColumn: 1, text: wrappedFirstSegment },
  { y: 11, startIndex: wrappedFirstSegment.length, startColumn: 1, text: wrappedSecondSegment },
]
const wrappedReferences = findTerminalFileReferences(
  wrappedSegments.map((segment) => segment.text).join(''),
  roots
)
assert.equal(wrappedReferences.length, 1)
assert.equal(wrappedReferences[0]?.text, 'src/renderer/src/components/panels/TerminalView.tsx:274:7')
assert.deepEqual(
  rangeForTerminalFileReference(wrappedReferences[0]!, wrappedSegments),
  {
    start: { x: 12, y: 10 },
    end: { x: wrappedSecondSegment.length, y: 11 },
  }
)

// Producer hard-wrap stitching: an agent CLI word-wraps a long path token onto
// an indented continuation line, emitting separate non-wrapped buffer lines.
type MockLine = { text: string; isWrapped: boolean }

function makeTerminal(cols: number, lines: MockLine[]): Terminal {
  const padded = lines.map((line) => ({
    isWrapped: line.isWrapped,
    raw: line.text.length >= cols ? line.text.slice(0, cols) : line.text.padEnd(cols, ' '),
  }))
  const buffer = {
    active: {
      getLine(index: number) {
        const line = padded[index]
        if (!line) return undefined
        return {
          isWrapped: line.isWrapped,
          translateToString(trimRight?: boolean, startColumn = 0, endColumn = cols) {
            const slice = line.raw.slice(startColumn, endColumn)
            return trimRight ? slice.replace(/\s+$/u, '') : slice
          },
          getCell(x: number) {
            if (x < 0 || x >= line.raw.length) return undefined
            const char = line.raw[x] ?? ''
            return { getChars: () => char }
          },
        }
      },
    },
  }
  return { cols, buffer } as unknown as Terminal
}

const hangingPathHead = '    future-plans/2026-06-07-targeted-review-gate-'
const hangingTerminal = makeTerminal(hangingPathHead.length, [
  { text: hangingPathHead, isWrapped: false },
  { text: '    rechecks.md', isWrapped: false },
])
const hangingLogical = readWrappedLogicalLine(hangingTerminal, 1)
assert.ok(hangingLogical)
assert.equal(
  hangingLogical.text,
  '    future-plans/2026-06-07-targeted-review-gate-rechecks.md'
)
const hangingRefs = findTerminalFileReferences(hangingLogical.text, roots)
assert.equal(hangingRefs.length, 1)
assert.equal(
  hangingRefs[0]?.text,
  'future-plans/2026-06-07-targeted-review-gate-rechecks.md'
)
assert.equal(
  hangingRefs[0]?.resolvedPath,
  '/repo/packages/app/future-plans/2026-06-07-targeted-review-gate-rechecks.md'
)
const hangingRange = rangeForTerminalFileReference(hangingRefs[0]!, hangingLogical.segments)
assert.deepEqual(hangingRange, { start: { x: 5, y: 1 }, end: { x: 15, y: 2 } })

// Wrapped prose must not be stitched: the bottom line fills the width but its
// trailing token has no path separator.
const proseHead = 'The plan covers the gate reset path and the proposed'
const proseTerminal = makeTerminal(proseHead.length, [
  { text: proseHead, isWrapped: false },
  { text: '    publish-id/gate-retention model', isWrapped: false },
])
const proseLogical = readWrappedLogicalLine(proseTerminal, 1)
assert.ok(proseLogical)
assert.equal(proseLogical.segments.length, 1)
assert.equal(proseLogical.text, proseHead)

// A path that ends before the right edge is complete; an unrelated indented
// line below it must not be merged in.
const completeHead = 'See src/a/b.json'
const completeTerminal = makeTerminal(40, [
  { text: completeHead, isWrapped: false },
  { text: '    src/c/d.json also', isWrapped: false },
])
const completeLogical = readWrappedLogicalLine(completeTerminal, 1)
assert.ok(completeLogical)
assert.equal(completeLogical.segments.length, 1)
assert.equal(completeLogical.text, completeHead)
