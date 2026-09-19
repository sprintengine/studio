import assert from 'node:assert/strict'

import type { AutomationRun } from '../../../../shared/automations/contracts'
import { extractReportPaths } from './reportPaths'
import { test } from 'vitest'

test('reportPaths', async () => {
  function run(
    fields: Partial<Pick<AutomationRun, 'reportPaths' | 'summary'>>,
  ): Pick<AutomationRun, 'reportPaths' | 'summary'> {
    return { reportPaths: fields.reportPaths, summary: fields.summary }
  }

  function testPrefersReportPathsOverSummary(): void {
    // Both present: the structured field wins and the summary is never scanned.
    const result = extractReportPaths(
      run({
        reportPaths: ['reports/from-field.md'],
        summary: 'Wrote reports/from-summary.md and opened a PR.',
      }),
    )
    assert.deepEqual(result, ['reports/from-field.md'])
  }

  function testReportPathsAreNormalizedAndContained(): void {
    // Invalid structured entries drop (no fallback to summary on precedence), and
    // a backslash/relative path is normalized to forward slashes.
    const result = extractReportPaths(
      run({
        reportPaths: ['reports\\sub\\a.md', '../escape.md', 'notes/outside.md', './reports/b.html'],
        summary: 'reports/from-summary.md',
      }),
    )
    assert.deepEqual(result, ['reports/sub/a.md', 'reports/b.html'])
  }

  function testEmptyReportPathsFallsBackToSummary(): void {
    // An empty structured array is treated as absent, so the summary is scanned.
    const result = extractReportPaths(
      run({
        reportPaths: [],
        summary: 'See reports/review.md for details.',
      }),
    )
    assert.deepEqual(result, ['reports/review.md'])
  }

  function testExtractsMarkdownAndHtmlFromSummary(): void {
    const result = extractReportPaths(
      run({
        summary: 'Generated reports/2026-06-28-review.md and reports/sub/dashboard.html; opened PR #7.',
      }),
    )
    assert.deepEqual(result, ['reports/2026-06-28-review.md', 'reports/sub/dashboard.html'])
  }

  function testSummaryScanRejectsTraversalAndOutOfReports(): void {
    // `..` traversal and out-of-reports tokens are dropped; the contained one survives.
    const result = extractReportPaths(
      run({
        summary: 'Touched reports/../secret.md, notes/leak.md, and reports/ok.md.',
      }),
    )
    assert.deepEqual(result, ['reports/ok.md'])
  }

  function testSummaryScanIgnoresMidWordExtensions(): void {
    // `.md` inside a longer token (`.markdown`) must not be captured as a path.
    const result = extractReportPaths(
      run({
        summary: 'The reports/notes.markdown file is not a report; reports/real.md is.',
      }),
    )
    assert.deepEqual(result, ['reports/real.md'])
  }

  function testDeduplicatesAndBounds(): void {
    // Repeated mentions collapse to one entry.
    const deduped = extractReportPaths(
      run({
        summary: 'reports/a.md then again reports/a.md and reports/a.md',
      }),
    )
    assert.deepEqual(deduped, ['reports/a.md'])

    // Output is capped at 20 even when more distinct paths are present.
    const many = Array.from({ length: 25 }, (_, i) => `reports/r${i}.md`)
    const bounded = extractReportPaths(run({ reportPaths: many }))
    assert.equal(bounded.length, 20, 'result is capped at 20 paths')
    assert.deepEqual(bounded, many.slice(0, 20))
  }

  // The summary is now the ONLY carrier of a report path (the signal file that
  // populated `reportPaths` is gone), and it is the agent's last assistant message
  // — i.e. markdown prose. These pin the shapes a real final message takes.
  function testScansTranscriptProseShapes(): void {
    const cases: Array<[string, string]> = [
      ['backticked', 'Done. I audited 14 dependencies and wrote the findings to `reports/2026-07-14-audit.md`.'],
      ['markdown link', 'Report: [the audit](reports/2026-07-14-audit.md) — 3 highs.'],
      ['bold', '**Report:** **reports/2026-07-14-audit.md** is ready.'],
      ['bullet list', 'Run summary:\n\n- Scanned 212 files\n- Wrote `reports/2026-07-14-audit.md`'],
      ['absolute path', 'Wrote /Users/me/workspace/proj/reports/2026-07-14-audit.md with the results.'],
    ]
    for (const [label, summary] of cases) {
      assert.deepEqual(
        extractReportPaths(run({ summary })),
        ['reports/2026-07-14-audit.md'],
        `the summary scan survives a ${label} report path`,
      )
    }
  }

  function testSummaryScanDecodesMarkdownEscapes(): void {
    // A markdown-escaped underscore must decode, not become a directory separator:
    // `normalizeReportPath` reads `\` as a separator, so leaving it would fabricate
    // `reports/weekly/_audit.md` — a live affordance pointing at a nonexistent file.
    assert.deepEqual(extractReportPaths(run({ summary: 'Wrote reports/weekly\\_audit.md with the results.' })), [
      'reports/weekly_audit.md',
    ])
  }

  function testEscapeDecodingCannotDefeatContainment(): void {
    // Escapes are decoded BEFORE the containment guard runs, so an escaped traversal
    // must not sneak past it: the guard is the last word on every candidate.
    assert.deepEqual(extractReportPaths(run({ summary: 'Wrote reports/\\.\\./secret.md.' })), [])
    assert.deepEqual(extractReportPaths(run({ summary: 'Wrote reports/ok.md and reports/\\.\\./etc/passwd.md.' })), [
      'reports/ok.md',
    ])
  }

  function testSummaryScanDropsCandidatesWithStrayBackslashes(): void {
    // A backslash we cannot read as an escape is not guessed at: dropping it costs
    // one report link; keeping it invents a path and renders a dead affordance.
    assert.deepEqual(extractReportPaths(run({ summary: 'Wrote reports/weekly\\nightly.md.' })), [])
  }

  function testTruncatedSummaryDegradesToNoAffordance(): void {
    // The transcript summary is capped, so a late mention can be cut mid-path. That
    // must yield no affordance, never a partial/dead one.
    assert.deepEqual(extractReportPaths(run({ summary: 'Wrote reports/very-long-name-au…' })), [])
  }

  function testReturnsEmptyForNeitherField(): void {
    assert.deepEqual(extractReportPaths(run({})), [])
    assert.deepEqual(extractReportPaths(run({ summary: 'No report here.' })), [])
    assert.deepEqual(extractReportPaths(run({ summary: '' })), [])
  }

  testPrefersReportPathsOverSummary()
  testReportPathsAreNormalizedAndContained()
  testEmptyReportPathsFallsBackToSummary()
  testExtractsMarkdownAndHtmlFromSummary()
  testSummaryScanRejectsTraversalAndOutOfReports()
  testSummaryScanIgnoresMidWordExtensions()
  testScansTranscriptProseShapes()
  testSummaryScanDecodesMarkdownEscapes()
  testEscapeDecodingCannotDefeatContainment()
  testSummaryScanDropsCandidatesWithStrayBackslashes()
  testTruncatedSummaryDegradesToNoAffordance()
  testDeduplicatesAndBounds()
  testReturnsEmptyForNeitherField()
  console.log('automations report-paths tests passed')
})
