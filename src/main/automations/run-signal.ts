import { join } from 'node:path'

import type { AutomationRunStatus } from '../../shared/automations/contracts'

/**
 * Signal file an agent-backed automation run writes into its worktree to declare
 * its own terminal outcome. The engine scans for this file to finalize the run.
 * Pure contract module: no I/O — it only names the file and parses its contents.
 */
export const RUN_SIGNAL_FILENAME = '.multicode-automation-run-status.json'

/**
 * Caps on the optional `reports` array an agent may declare. They bound the
 * array independently of MAX_RUN_SIGNAL_BYTES (engine.ts): a malformed,
 * wrong-typed, or oversize `reports` value is coerced to absent rather than
 * failing the parse, so a valid terminal outcome is never stranded.
 */
export const MAX_RUN_SIGNAL_REPORTS = 20
export const MAX_RUN_SIGNAL_REPORT_PATH_LENGTH = 512

/** Terminal outcomes an agent may declare via the signal file. */
export type RunSignalOutcome = Extract<AutomationRunStatus, 'completed' | 'failed'>

/** Parsed, validated signal payload. `summary` is present only when non-empty. */
export type RunSignal = {
  outcome: RunSignalOutcome
  summary?: string
  /**
   * Report files the agent declared writing, trimmed and structurally valid
   * (non-empty strings within the caps above). Present only when the signal
   * carried a well-formed `reports` array. Path containment (under `reports/`)
   * is enforced later by the engine, not here.
   */
  reports?: string[]
}

/** Absolute path to the run-status signal file inside a run's worktree. */
export function runSignalPath(worktreePath: string): string {
  return join(worktreePath, RUN_SIGNAL_FILENAME)
}

/**
 * Parse and validate raw signal-file contents.
 *
 * Returns the validated {@link RunSignal} for a well-formed payload, or `null`
 * (the invalid marker) for malformed JSON, a missing/unrecognized `status`, or a
 * non-string `summary`. An empty or whitespace-only `summary` is cosmetic, not a
 * parse failure: it is treated as absent so a valid terminal declaration still
 * finalizes. A malformed `reports` value (non-array, non-string/empty entries,
 * over the count or per-path caps) is likewise coerced to absent rather than
 * failing the parse — the terminal outcome is never stranded by bad provenance.
 * Callers must skip finalize on `null` rather than coercing an unrecognized
 * status into an outcome.
 */
export function parseRunSignal(raw: string): RunSignal | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }

  const record = parsed as Record<string, unknown>
  const outcome = record.status
  if (outcome !== 'completed' && outcome !== 'failed') {
    return null
  }

  const signal: RunSignal = { outcome }

  if ('summary' in record) {
    if (typeof record.summary !== 'string') {
      return null
    }
    // Empty/whitespace summary == no summary: align with finalizeRun's
    // input.summary?.trim() so '' and '   ' both finalize, not strand the run.
    if (record.summary.trim().length > 0) signal.summary = record.summary
  }

  if ('reports' in record) {
    const reports = validateReports(record.reports)
    if (reports) signal.reports = reports
  }

  return signal
}

/**
 * Validate the optional `reports` field. Returns the trimmed path list for a
 * well-formed array (every entry a non-empty string within
 * {@link MAX_RUN_SIGNAL_REPORT_PATH_LENGTH}, count within
 * {@link MAX_RUN_SIGNAL_REPORTS}), or `undefined` for any malformed,
 * wrong-typed, or oversize value — coerced to absent, never a parse failure,
 * mirroring the empty-summary rule.
 */
function validateReports(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RUN_SIGNAL_REPORTS) {
    return undefined
  }
  const reports: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined
    const trimmed = entry.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_RUN_SIGNAL_REPORT_PATH_LENGTH) return undefined
    reports.push(trimmed)
  }
  return reports
}
