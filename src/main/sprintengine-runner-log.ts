/**
 * On-disk Sprint Engine runner log (MC-1754 Phase 3).
 *
 * The shared auto-run corpus emits perf events through one injected seam;
 * main mirrors them to `logMainPerfEvent`, which is console-only and gated
 * behind the diagnostics flag — so a runner incident (spawn storm, retirement
 * stall, dispatch skip) left nothing to read after the fact. This writer
 * appends every Sprint Engine auto-run event to the owning run's
 * `runner/runner-log.jsonl`, size-capped with one rotation, so a post-mortem
 * works from files alone with the app closed — the 2026-07-22
 * post-merge-hardening investigation had to reconstruct the runner's behavior
 * from run-state side effects instead.
 *
 * Never throws: log I/O must not break a tick. Appends are synchronous —
 * events are small (~hundreds of bytes) and per-tick counts are low, so a
 * blocking append is cheaper than managing an async queue's failure modes.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export const RUNNER_LOG_MAX_BYTES = 5 * 1024 * 1024
const RUNNER_LOG_FILENAME = 'runner-log.jsonl'

export type SprintEngineRunnerLogTarget = {
  /** The run's run.yaml path (absolute, or workspace-relative with folderPath). */
  statePath: string
  folderPath?: string | null
}

export function createSprintEngineRunnerLog(
  resolveTarget: (workspaceId: string) => SprintEngineRunnerLogTarget | null,
  nowIso: () => string = () => new Date().toISOString()
): { write(scope: string, event: string, payload: Record<string, unknown>): void } {
  return {
    write(scope, event, payload) {
      try {
        const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : null
        if (!workspaceId) return
        const target = resolveTarget(workspaceId)
        if (!target?.statePath) return
        const statePath = isAbsolute(target.statePath)
          ? target.statePath
          : target.folderPath
            ? join(target.folderPath, target.statePath)
            : null
        if (!statePath) return
        const runnerDir = join(dirname(statePath), 'runner')
        const file = join(runnerDir, RUNNER_LOG_FILENAME)
        mkdirSync(runnerDir, { recursive: true })
        try {
          if (statSync(file).size > RUNNER_LOG_MAX_BYTES) renameSync(file, `${file}.1`)
        } catch {
          // Missing file: first write creates it.
        }
        appendFileSync(file, `${JSON.stringify({ at: nowIso(), scope, event, ...payload })}\n`)
      } catch {
        // Log I/O must never break the runner.
      }
    },
  }
}
