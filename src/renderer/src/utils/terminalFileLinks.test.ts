import assert from 'node:assert/strict'
import type { ILink, Terminal } from '@xterm/xterm'
import {
  createTerminalFileLinkProvider,
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

// ---------------------------------------------------------------------------
// The reported drop (item `terminal-relative-links-dropped`, 2026-09-08): a
// `[file] …` line in an agent pane was not clickable. The line below is the one
// that was reported, verbatim, including Claude Code's `⎿` gutter.
//
// The pattern, the resolution and the cell geometry all handle it — proved
// below at a wide width and at a width that soft-wraps it. What does NOT handle
// it is a pane with no root: `resolveTerminalFileReferencePath` returns null and
// the match is discarded. That stays the behaviour (guessing a base opens the
// wrong file), but it is now reported instead of silent.
// ---------------------------------------------------------------------------

const reportedLine = '  ⎿  [file] resources/studio-plugin/skills/studio-backlog/SKILL.md'
const reportedPath = 'resources/studio-plugin/skills/studio-backlog/SKILL.md'

type Drop = { reason: string; text: string }

// The bare resolver, which is where the null originates.
assert.equal(resolveTerminalFileReferencePath(reportedPath, {}), null)
assert.equal(
  resolveTerminalFileReferencePath(reportedPath, { workspaceRoot: null, executionRoot: null }),
  null
)

const rootlessDrops: Drop[] = []
const rootless = findTerminalFileReferences(
  reportedLine,
  { workspaceRoot: null, executionRoot: null },
  (drop) => rootlessDrops.push(drop)
)
assert.equal(rootless.length, 0)
assert.deepEqual(rootlessDrops, [{ reason: 'no-root', text: reportedPath }])

// Either root alone is enough, and a resolved reference reports no drop.
for (const knownRoots of [
  { workspaceRoot: '/repo', executionRoot: null },
  { workspaceRoot: null, executionRoot: '/repo' },
  // The execution root wins when both are known — an agent in a worktree
  // resolves its own relative paths against the worktree, not the checkout.
  { workspaceRoot: '/checkout', executionRoot: '/repo' },
]) {
  const drops: Drop[] = []
  const found = findTerminalFileReferences(reportedLine, knownRoots, (drop) => drops.push(drop))
  assert.equal(found.length, 1)
  assert.equal(found[0]?.text, reportedPath)
  assert.equal(found[0]?.resolvedPath, `/repo/${reportedPath}`)
  assert.deepEqual(drops, [])
}

// An absolute path still resolves with no roots at all, so a rootless pane is
// not link-dead — only its relative references are.
const rootlessAbsoluteDrops: Drop[] = []
const rootlessAbsolute = findTerminalFileReferences(
  'Failure at /repo/src/main.ts:8',
  { workspaceRoot: null, executionRoot: null },
  (drop) => rootlessAbsoluteDrops.push(drop)
)
assert.equal(rootlessAbsolute.length, 1)
assert.deepEqual(rootlessAbsoluteDrops, [])

// A URL or a `~/…` path is a deliberate non-match, not a drop. Counting these
// would fire the diagnostic on output that contains no local path at all —
// including when a root IS known, which would make the counter meaningless.
for (const roots of [
  { workspaceRoot: null, executionRoot: null },
  { workspaceRoot: '/repo', executionRoot: null },
]) {
  const remoteDrops: Drop[] = []
  const remote = findTerminalFileReferences(
    'Docs: https://example.com/src/main.ts and ~/notes.md and ~/notes.md:12',
    roots,
    (drop) => remoteDrops.push(drop)
  )
  assert.equal(remote.length, 0)
  assert.deepEqual(remoteDrops, [])
}

// `no-range` is the tripwire for match offsets and segment tiling coming apart.
// It cannot be reached through the provider (the references are matched against
// the very text the segments tile), so it is exercised where it is reachable.
assert.equal(
  rangeForTerminalFileReference(
    { startIndex: 100, endIndex: 140 },
    [{ y: 1, startIndex: 0, startColumn: 1, text: 'src/a.ts' }]
  ),
  null
)
assert.equal(rangeForTerminalFileReference({ startIndex: 0, endIndex: 4 }, []), null)

// End to end through the provider, at a width that fits the reported line and
// at a width that soft-wraps it — the wrap is what put the tail of the path on
// a second buffer row in the pane it was reported from.
function provideLinksFor(
  terminal: Terminal,
  bufferLineNumber: number,
  roots: { workspaceRoot: string | null; executionRoot: string | null }
): { links: ILink[] | undefined; drops: Drop[] } {
  const drops: Drop[] = []
  let links: ILink[] | undefined
  let called = false
  createTerminalFileLinkProvider({
    terminal,
    workspaceRoot: roots.workspaceRoot,
    executionRoot: roots.executionRoot,
    inspectPath: async () => ({ exists: true, isDirectory: false }),
    onActivate: () => {},
    onDrop: (drop) => drops.push(drop),
  }).provideLinks(bufferLineNumber, (provided) => {
    called = true
    links = provided
  })
  assert.ok(called, 'provideLinks must always answer its callback')
  return { links, drops }
}

const wideTerminal = makeTerminal(120, [{ text: reportedLine, isWrapped: false }])
const wide = provideLinksFor(wideTerminal, 1, { workspaceRoot: '/repo', executionRoot: null })
assert.equal(wide.links?.length, 1)
assert.equal(wide.links?.[0]?.text, reportedPath)
assert.deepEqual(wide.links?.[0]?.range, {
  start: { x: 13, y: 1 },
  end: { x: 13 + reportedPath.length - 1, y: 1 },
})
assert.deepEqual(wide.drops, [])

// Soft-wrapped across two rows: hovering either row must yield the same link.
const wrappedTerminal = makeTerminal(40, [
  { text: reportedLine.slice(0, 40), isWrapped: false },
  { text: reportedLine.slice(40), isWrapped: true },
])
for (const hoveredRow of [1, 2]) {
  const wrapped = provideLinksFor(wrappedTerminal, hoveredRow, {
    workspaceRoot: '/repo',
    executionRoot: null,
  })
  assert.equal(wrapped.links?.length, 1)
  assert.equal(wrapped.links?.[0]?.text, reportedPath)
  assert.deepEqual(wrapped.links?.[0]?.range, {
    start: { x: 13, y: 1 },
    end: { x: reportedLine.length - 40, y: 2 },
  })
  assert.deepEqual(wrapped.drops, [])
}

// The same pane with no folder configured: no link, and a counted drop rather
// than silence. This is the acceptance criterion of the item.
const rootlessProvider = provideLinksFor(
  makeTerminal(120, [{ text: reportedLine, isWrapped: false }]),
  1,
  { workspaceRoot: null, executionRoot: null }
)
assert.equal(rootlessProvider.links, undefined)
assert.deepEqual(rootlessProvider.drops, [{ reason: 'no-root', text: reportedPath }])

console.log('ok - terminalFileLinks')
