import type { AutomationRun } from '../../../../shared/automations/contracts'
import { normalizeReportPath } from '../../../../shared/automations/contracts'

/**
 * Pure resolver for the report files an automation run produced. No IPC, React,
 * or filesystem access — it reads only the {@link AutomationRun} object so
 * historical runs (which predate the structured field) light up with no
 * migration.
 *
 * Precedence:
 *  1. `run.reportPaths` — the structured, engine-validated field (Layer B). When
 *     present and non-empty it is authoritative; the prose summary is not scanned.
 *  2. otherwise a bounded regex scan of `run.summary` for `reports/…(.md|.html)`.
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

function scanSummaryForReportPaths(summary: string | undefined): string[] {
  if (!summary) return []
  const scanned = summary.length > MAX_SUMMARY_SCAN_CHARS ? summary.slice(0, MAX_SUMMARY_SCAN_CHARS) : summary
  return scanned.match(SUMMARY_REPORT_PATH) ?? []
}
