import assert from 'node:assert/strict'

import {
  BUILD_SKEW_CODE,
  compareBuildStamps,
  formatBuildSkewLogLine,
  formatBuildSkewNotice,
  parseBuildStamp,
  shortCommit,
  type BuildStamp,
} from './build-stamp'

function stamp(overrides: Partial<BuildStamp> = {}): BuildStamp {
  return {
    commit: 'a'.repeat(40),
    source: 'git',
    builtAt: '2026-08-07T00:08:11.000Z',
    mode: 'development',
    ...overrides,
  }
}

// The identity is the commit, and nothing else. Two bundles built minutes apart
// from the same commit are the same build — which is the normal dev loop, where
// main is bundled at start and the renderer is served per document.
{
  const main = stamp({ builtAt: '2026-08-07T00:08:11.000Z' })
  const renderer = stamp({ builtAt: '2026-08-07T05:31:44.000Z' })
  assert.deepEqual(compareBuildStamps(main, renderer), { status: 'match' })
}

// The incident shape: the window reloaded onto a newer commit, main did not.
{
  const verdict = compareBuildStamps(stamp(), stamp({ commit: 'b'.repeat(40) }))
  assert.deepEqual(verdict, { status: 'skew' })
}

// A missing commit is never compared. Two unknowns are not a match, and one
// unknown is not a skew — the check is off, and says which side turned it off.
{
  assert.deepEqual(compareBuildStamps(stamp({ commit: null }), stamp()), {
    status: 'indeterminate',
    missing: 'main',
  })
  assert.deepEqual(compareBuildStamps(stamp(), stamp({ commit: null })), {
    status: 'indeterminate',
    missing: 'renderer',
  })
  assert.deepEqual(compareBuildStamps(stamp({ commit: null }), stamp({ commit: null })), {
    status: 'indeterminate',
    missing: 'both',
  })
}

// The log line is what tells an operator (or an agent reading logs) "restart"
// apart from "retry": it carries both builds, a stable code, and the explicit
// statement that this is not transient.
{
  const line = formatBuildSkewLogLine(
    stamp({ commit: '78d0e16c7' + '0'.repeat(31) }),
    stamp({ commit: 'feac30b62' + '0'.repeat(31) }),
  )
  assert.ok(line.includes(BUILD_SKEW_CODE), 'carries the stable code')
  assert.ok(line.includes('main=78d0e16'), 'names main’s build')
  assert.ok(line.includes('renderer=feac30b'), 'names the window’s build')
  assert.ok(line.includes('resolution=restart_required'), 'names the resolution')
  assert.ok(line.includes('transient=false'), 'distinguishes itself from a slow renderer')
}

// The person-facing notice names both builds and the restart, in one headline
// and one helper line.
{
  const notice = formatBuildSkewNotice(
    stamp({ commit: '78d0e16c7' + '0'.repeat(31) }),
    stamp({ commit: 'feac30b62' + '0'.repeat(31), builtAt: '2026-08-07T05:31:44.000Z' }),
  )
  assert.equal(notice.headline, 'Main and window are running different builds.')
  assert.ok(notice.detail.includes('78d0e16'), 'names main’s build')
  assert.ok(notice.detail.includes('feac30b'), 'names the window’s build')
  assert.ok(notice.detail.includes('2026-08-07T05:31:44.000Z'), 'timestamps are concrete')
  assert.ok(/[Rr]estart/.test(notice.detail), 'says a restart is required')
}

// Unknown commits print as `unknown`, never as an empty slot that reads like a
// match.
{
  assert.equal(shortCommit(null), 'unknown')
  assert.equal(shortCommit('a'.repeat(40)), 'aaaaaaa')
}

// A window reports over IPC, so the payload is untrusted. Anything that is not a
// stamp is rejected rather than coerced into one.
{
  assert.deepEqual(parseBuildStamp(stamp()), stamp())
  assert.deepEqual(parseBuildStamp({ commit: null, source: 'unavailable', builtAt: 'x', mode: 'production' }), {
    commit: null,
    source: 'unavailable',
    builtAt: 'x',
    mode: 'production',
  })
  assert.equal(parseBuildStamp(null), null)
  assert.equal(parseBuildStamp('a'.repeat(40)), null, 'a bare sha is not a stamp')
  assert.equal(parseBuildStamp({ ...stamp(), commit: 42 }), null, 'commit must be a sha or null')
  assert.equal(parseBuildStamp({ ...stamp(), source: 'guess' }), null, 'source is a closed set')
  assert.equal(parseBuildStamp({ ...stamp(), mode: 'staging' }), null, 'mode is a closed set')
  assert.equal(parseBuildStamp({ commit: 'a'.repeat(40) }), null, 'a partial stamp is not a stamp')
}

console.log('build-stamp contract ok')
