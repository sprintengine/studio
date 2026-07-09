import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canRelease,
  displayLibraryPath,
  initialReleaseVersion,
  isReleaseInFlight,
  isValidReleaseVersion,
  lintFixRequestMessage,
  lintIssueCountLabel,
  parseLintFindings,
  releaseButtonLabel,
  releaseDestinationDisplay,
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

// --- Release card presentation helpers (MC-1505 §4, T8) ---------------------

// parseLintFindings reads the bundle's own scripts/lint.mjs report shape:
// indented finding rows grouped under file-path lines, then a summary block
// (dropped) whose "Total violations" line carries the count.
{
  const report = [
    '',
    'components/task-card/component.css',
    '  12:5  no-raw-hex  #30d058',
    '  40:3  contrast  3.8:1',
    '',
    'foundations/tokens.tokens.json',
    '  sem.color.accent  missing-token-semantics  sem token needs role and use',
    '',
    'Design-system lint summary',
    '  bundle: /ws/design-system',
    '  scanned: 12 component/pattern files, 80 tokens',
    'Total violations: 3',
    '',
    'Fix by reading colors from the --sem-* custom properties…',
  ].join('\n')
  const parsed = parseLintFindings(report)
  assert.equal(parsed.totalViolations, 3, 'the count comes from the report summary line')
  assert.deepEqual(
    parsed.issues,
    [
      { file: 'components/task-card/component.css', detail: '12:5  no-raw-hex  #30d058' },
      { file: 'components/task-card/component.css', detail: '40:3  contrast  3.8:1' },
      { file: 'foundations/tokens.tokens.json', detail: 'sem.color.accent  missing-token-semantics  sem token needs role and use' },
    ],
    'rows keep the report text grouped under their file; the summary block is dropped',
  )
  assert.equal(lintIssueCountLabel(parsed), '3 lint issues')
  assert.equal(
    lintIssueCountLabel({ totalViolations: 1, issues: parsed.issues.slice(0, 1) }),
    '1 lint issue',
  )
  assert.equal(
    lintIssueCountLabel(parseLintFindings('some unrecognized shape')),
    'Lint failed',
    'an unparsable report never invents a count',
  )
  assert.deepEqual(
    parseLintFindings('unexpected prose only'),
    { totalViolations: null, issues: [] },
    'no indented rows → zero issues (the card falls back to the raw report)',
  )
}

// The blocked card's message to the designer: the conversation transport gets
// the full report; terminal (PTY) stdin submits on newline, so that transport
// gets a single-line instruction instead — never a garbled multi-line paste.
{
  const conversation = lintFixRequestMessage('a\nb', 'conversation')
  assert.ok(conversation.includes('Lint report:\na\nb'), 'conversation message carries the report')
  const terminal = lintFixRequestMessage('a\nb', 'terminal')
  assert.equal(terminal.includes('\n'), false, 'terminal message is a single line')
  assert.ok(terminal.includes('scripts/lint.mjs'), 'terminal message routes the designer to the real lint')
}

// Destination display: the canonical library layout with the real manifest
// name; unknown name yields null (the card omits the line, never invents one).
assert.equal(
  releaseDestinationDisplay('brand', '1.2.0'),
  '~/.multicode/design-systems/brand/1.2.0',
)
assert.equal(
  releaseDestinationDisplay('brand', 'not-semver'),
  '~/.multicode/design-systems/brand/<version>',
  'an invalid version shows an explicit placeholder segment',
)
assert.equal(releaseDestinationDisplay(null, '1.0.0'), null)
assert.equal(
  displayLibraryPath('/home/u/.multicode/design-systems/brand/1.1.0'),
  '~/.multicode/design-systems/brand/1.1.0',
  'released absolute paths abbreviate to the ~ display form',
)
assert.equal(
  displayLibraryPath('/elsewhere/brand/1.1.0'),
  '/elsewhere/brand/1.1.0',
  'a path outside the library passes through unabbreviated',
)

// Reachable disabled reason (T15, ux-review finding 6): a disabled button is
// unfocusable, so a hover tooltip alone strands keyboard/SR users. Source
// contract on GuidedBriefFlow.tsx DesignSystemReleaseCard: the reason rides an
// always-present aria-label on the save button (visible label included, per
// label-in-name), and the version input carries aria-invalid plus an
// aria-describedby format hint that is always in the DOM — visible inline
// error text while the version is invalid, sr-only otherwise.
{
  const flowSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/guidedBrief/GuidedBriefFlow.tsx'),
    'utf8',
  )
  assert.match(
    flowSource,
    /aria-label=\{saveDisabledReason \? `\$\{buttonLabel\} — \$\{saveDisabledReason\}` : undefined\}/,
    'save button carries the disabled reason as an always-present aria-label',
  )
  assert.match(
    flowSource,
    /aria-invalid=\{!versionValid\}\s*aria-describedby=\{RELEASE_VERSION_HINT_ID\}/,
    'version input announces invalid state and points at the format hint',
  )
  assert.match(
    flowSource,
    /id=\{RELEASE_VERSION_HINT_ID\}\s*className=\{versionValid \? 'sr-only' : '[^']*--tone-error[^']*'\}/,
    'the format hint is always in the DOM and becomes a visible inline error while invalid',
  )
  assert.match(
    flowSource,
    /lintFixRequestMessage\(releasePhase\.findings, session\.transport\)/,
    'the blocked card sends the real findings over the real session transport',
  )
}

console.log('designSystemRelease.test.ts: ok')
