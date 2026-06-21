import { join } from 'node:path'

import type { AutomationRunStatus } from '../../shared/automations/contracts'

/**
 * Signal file an agent-backed automation run writes into its worktree to declare
 * its own terminal outcome. The engine scans for this file to finalize the run.
 * Pure contract module: no I/O — it only names the file and parses its contents.
 */
export const RUN_SIGNAL_FILENAME = '.multicode-automation-run-status.json'

/** Terminal outcomes an agent may declare via the signal file. */
export type RunSignalOutcome = Extract<AutomationRunStatus, 'completed' | 'failed'>

/** Parsed, validated signal payload. `summary` is present only when non-empty. */
export type RunSignal = {
  outcome: RunSignalOutcome
  summary?: string
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
 * `summary` of the wrong type. Callers must skip finalize on `null` rather than
 * coercing an unrecognized status into an outcome.
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

  if ('summary' in record) {
    if (typeof record.summary !== 'string' || record.summary.length === 0) {
      return null
    }
    return { outcome, summary: record.summary }
  }

  return { outcome }
}
