import type { AutomationRun } from '../../../../shared/automations/contracts'
import { normalizeReportPath } from '../../../../shared/automations/contracts'

/**
 * Pure resolver for the report files an automation run produced. No IPC, React,
 * or filesystem access — it reads only the {@link AutomationRun} object.
 *
 * Precedence:
 *  1. `run.reportPaths` — the structured field. Honored when present, but NO
 *     producer writes it any more: it was populated by the run-status signal
 *     file, which is gone (finalization is now driven from the agent-state
 *     hooks). It survives only on runs recorded before that, so this branch is
 *     effectively a historical-run path.
 *  2. otherwise a bounded regex scan of `run.summary` for `reports/…(.md|.html)`.
 *
 * Branch 2 is therefore the live carrier: the summary is derived from the
 * agent's last assistant message (`main/automations/transcript-summary.ts`), so
 * a report link exists only when the agent's own prose names the file. Prose it
 * is — the scan must survive markdown (backticks, links, bold, escapes) and
 * degrade to NO affordance rather than a dead one, which is why an ambiguous
 * candidate is dropped instead of guessed at.
 *
 * Every candidate is run through the same containment guard the engine uses
 * (`normalizeReportPath`: project-relative, reject `..`, must resolve under
 * `reports/`); invalid candidates are dropped, never thrown. Results are
 * normalized, de-duplicated, and capped.
 */
export function extractReportPaths(run: Pick<AutomationRun, 'reportPaths' | 'summary'>): string[] {
  const candidates = run.reportPaths && run.reportPaths.length > 0
    ? run.reportPaths
    : scanSummaryForReportPaths(run.summary)

  const seen = new Set<string>()
  const paths: string[] = []
  for (const candidate of candidates) {
    const normalized = normalizeReportPath(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
    if (paths.length >= MAX_REPORT_PATHS) break
  }
  return paths
}

/** Upper bound on resolved report paths, mirroring the engine's per-run cap. */
const MAX_REPORT_PATHS = 20

/** Cap on the prose scanned so a pathological summary cannot drive the scan. */
const MAX_SUMMARY_SCAN_CHARS = 64 * 1024

// A `reports/` path token ending in `.md` or `.html`, embedded in prose. Bounded
// to defeat catastrophic backtracking: the body excludes whitespace and quote
// delimiters and is length-capped, and a trailing word boundary stops the
// extension matching inside a longer token (e.g. `reports/a.markdown`). Matched
// case-sensitively to align with the lowercase `reports/` convention the guard
// enforces.
const SUMMARY_REPORT_PATH = /reports\/[^\s"'`)\]]{1,256}?\.(?:md|html)\b/g

// A markdown escape: a backslash before punctuation (`reports/weekly\_audit.md`).
// The summary is agent-written markdown, so escapes reach us verbatim.
const MARKDOWN_ESCAPE = /\\([^A-Za-z0-9])/g

function scanSummaryForReportPaths(summary: string | undefined): string[] {
  if (!summary) return []
  const scanned = summary.length > MAX_SUMMARY_SCAN_CHARS ? summary.slice(0, MAX_SUMMARY_SCAN_CHARS) : summary
  const matches = scanned.match(SUMMARY_REPORT_PATH) ?? []
  // In prose a backslash is a markdown escape, never a path separator — but
  // `normalizeReportPath` reads `\` as a separator (correct for the structured
  // field, which could carry a Windows path). Left alone, `reports/weekly\_audit.md`
  // would normalize to `reports/weekly/_audit.md`: a fabricated directory, and a
  // live "View report" pointing at a file that does not exist. So decode the
  // escapes, and drop any candidate still carrying a backslash rather than invent
  // a path from it.
  return matches
    .map((match) => match.replace(MARKDOWN_ESCAPE, '$1'))
    .filter((candidate) => !candidate.includes('\\'))
}
