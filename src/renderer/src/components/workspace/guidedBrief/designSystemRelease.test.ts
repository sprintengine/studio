import assert from 'node:assert/strict'
import {
  canRelease,
  initialReleaseVersion,
  isReleaseInFlight,
  isValidReleaseVersion,
  releaseButtonLabel,
  releasePhaseAfterLint,
  releasePhaseAfterRelease,
  releaseStatusLine,
  type DesignSystemReleasePhase,
} from './designSystemRelease'

// Version prefill: 1.0.0 for a first release, then the last released version
// for the user to bump (no auto-bump).
assert.equal(initialReleaseVersion(null), '1.0.0')
assert.equal(
  initialReleaseVersion({ name: 'brand', version: '1.2.0', path: '/lib/brand/1.2.0', releasedAt: 't' }),
  '1.2.0',
)

assert.equal(isValidReleaseVersion('1.0.0'), true)
assert.equal(isValidReleaseVersion('1.0.0-beta.1'), true)
assert.equal(isValidReleaseVersion(' 1.0.0 '), true, 'surrounding whitespace is trimmed')
assert.equal(isValidReleaseVersion('1.0'), false)
assert.equal(isValidReleaseVersion('v1.0.0'), false)
assert.equal(isValidReleaseVersion(''), false)

// Gating: designer readiness, no in-flight call, and a valid version.
const idle: DesignSystemReleasePhase = { kind: 'idle' }
assert.equal(canRelease({ phase: idle, designerReady: true, version: '1.0.0' }), true)
assert.equal(canRelease({ phase: idle, designerReady: false, version: '1.0.0' }), false)
assert.equal(canRelease({ phase: idle, designerReady: true, version: 'nope' }), false)
assert.equal(
  canRelease({ phase: { kind: 'validating' }, designerReady: true, version: '1.0.0' }),
  false,
  'no double-fire while validating',
)
assert.equal(
  canRelease({ phase: { kind: 'releasing' }, designerReady: true, version: '1.0.0' }),
  false,
  'no double-fire while releasing',
)
assert.equal(
  canRelease({ phase: { kind: 'lint-failed', findings: 'x' }, designerReady: true, version: '1.0.0' }),
  true,
  'retry is armed from lint-failed',
)
assert.equal(
  canRelease({ phase: { kind: 'error', message: 'x' }, designerReady: true, version: '1.0.0' }),
  true,
  'retry is armed from error',
)

// Lint (validating) phase results.
assert.deepEqual(releasePhaseAfterLint({ ok: true }), { kind: 'releasing' })
assert.deepEqual(
  releasePhaseAfterLint({ ok: false, kind: 'findings', findings: 'raw-hex at button.css:3' }),
  { kind: 'lint-failed', findings: 'raw-hex at button.css:3' },
)
assert.deepEqual(
  releasePhaseAfterLint({ ok: false, kind: 'error', message: 'lint script missing' }),
  { kind: 'error', message: 'lint script missing' },
)

// Release pipeline results.
const released = releasePhaseAfterRelease({
  ok: true,
  name: 'brand',
  version: '1.1.0',
  releasedAt: '2026-07-02T00:00:00.000Z',
  path: '/home/u/.multicode/design-systems/brand/1.1.0',
})
assert.deepEqual(released, {
  kind: 'released',
  release: {
    name: 'brand',
    version: '1.1.0',
    releasedAt: '2026-07-02T00:00:00.000Z',
    path: '/home/u/.multicode/design-systems/brand/1.1.0',
  },
})
assert.deepEqual(
  releasePhaseAfterRelease({ ok: false, stage: 'lint', message: 'violations', lintFindings: 'F' }),
  { kind: 'lint-failed', findings: 'F' },
  'a pipeline lint failure (designer edited mid-flight) still lands on lint-failed',
)
assert.deepEqual(
  releasePhaseAfterRelease({ ok: false, stage: 'lint', message: 'lint could not run' }),
  { kind: 'error', message: 'lint could not run' },
  'a lint misconfiguration without findings is an error, not a findings state',
)
assert.deepEqual(
  releasePhaseAfterRelease({ ok: false, stage: 'conflict', message: 'brand@1.1.0 exists' }),
  { kind: 'error', message: 'brand@1.1.0 exists' },
)

// The five action states are text-distinct: labels and status lines never
// collapse two states into the same rendering (non-color-only requirement).
const phases: DesignSystemReleasePhase[] = [
  { kind: 'validating' },
  { kind: 'releasing' },
  { kind: 'released', release: { name: 'b', version: '1.0.0', path: '/p', releasedAt: 't' } },
  { kind: 'lint-failed', findings: 'F' },
  { kind: 'error', message: 'boom' },
]
const renderings = phases.map((phase) => `${releaseButtonLabel(phase)} | ${releaseStatusLine(phase)}`)
assert.equal(new Set(renderings).size, phases.length, `states must render distinctly: ${renderings.join(' // ')}`)
assert.equal(releaseStatusLine({ kind: 'idle' }), null)
assert.equal(releaseButtonLabel({ kind: 'idle' }), 'Save as design system')
assert.equal(isReleaseInFlight({ kind: 'validating' }), true)
assert.equal(isReleaseInFlight(idle), false)

console.log('designSystemRelease.test.ts: ok')
