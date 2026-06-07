import assert from 'node:assert/strict'
import {
  findTerminalFileReferences,
  rangeForTerminalFileReference,
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
  { y: 10, startIndex: 0, text: wrappedFirstSegment },
  { y: 11, startIndex: wrappedFirstSegment.length, text: wrappedSecondSegment },
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
