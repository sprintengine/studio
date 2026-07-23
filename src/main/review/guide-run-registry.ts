// Where a review's guide run actually lives (MC-1784). The renderer's run state
// used to be the only record of "the guide is working", so navigating away from
// the Reviews door and back lost it — a live run looked like no run, and a
// failure lost its reason. This module holds that state in the main process,
// which outlives every remount.
//
// It is deliberately transport-neutral: it knows nothing about companions,
// terminals, MCP, or IPC. Whatever runs the guide records its phases here, and
// the review IPC reads them back. That makes it the contract of record across
// the companion path (today) and the terminal path (MC-1783).

// Honest run progress, shared with BriefRunEvent so one vocabulary describes a
// run whether it is read live off the event channel or polled from here.
// `reading` loads the change set, `grouping` is the guide generating,
// `annotating` validates the produced brief, `writing` persists, and
// `done`/`failed` are terminal.
export type GuideRunPhase = 'reading' | 'grouping' | 'annotating' | 'writing' | 'done' | 'failed'

const TERMINAL_PHASES: ReadonlySet<GuideRunPhase> = new Set<GuideRunPhase>(['done', 'failed'])

export interface GuideRunStatus {
  // False once the run reached a terminal phase. The phase is still the terminal
  // one, so a remount can render "failed: <detail>" rather than an empty pane.
  running: boolean
  phase: GuideRunPhase
  detail?: string
  startedAt: string
}

// Records phases for ONE run. A replaced run keeps writing through its own
// recorder as it unwinds (an interrupted run reports `failed` from its catch),
// and those late writes must not land on the run that replaced it — so the
// recorder, not the review id, is what a phase belongs to.
export interface GuideRunRecorder {
  record(phase: GuideRunPhase, detail?: string): void
}

interface GuideRunEntry extends GuideRunStatus {
  runId: number
}

export class GuideRunRegistry {
  // Keyed by review id (the id the review's `.multi-code/review/<id>/` directory
  // is named for), which is also the BriefRunEvent `workspaceId`.
  private readonly runs = new Map<string, GuideRunEntry>()
  private nextRunId = 1

  // Mark a run as started, replacing any retained terminal record so a remount
  // shows the run happening now instead of the last one's failure.
  begin(reviewId: string, startedAt: string = new Date().toISOString()): GuideRunRecorder {
    const runId = this.nextRunId++
    this.runs.set(reviewId, { runId, running: true, phase: 'reading', startedAt })
    return {
      record: (phase, detail) => {
        if (this.runs.get(reviewId)?.runId !== runId) return
        this.write(reviewId, runId, startedAt, phase, detail)
      },
    }
  }

  // Record a phase for a run this registry never saw begin — a guide the app
  // did not start, or a transport that reports only its outcome. It adopts the
  // review's current run when there is one, so status never lies by omission.
  record(reviewId: string, phase: GuideRunPhase, detail?: string): void {
    const existing = this.runs.get(reviewId)
    this.write(
      reviewId,
      existing?.runId ?? this.nextRunId++,
      existing?.startedAt ?? new Date().toISOString(),
      phase,
      detail
    )
  }

  // The run state of record for a review, or null when the guide has never run
  // for it in this app session. A terminal phase is retained until the next
  // begin(); it is never cleared on read.
  status(reviewId: string): GuideRunStatus | null {
    const entry = this.runs.get(reviewId)
    if (!entry) return null
    const { running, phase, detail, startedAt } = entry
    return detail ? { running, phase, detail, startedAt } : { running, phase, startedAt }
  }

  private write(
    reviewId: string,
    runId: number,
    startedAt: string,
    phase: GuideRunPhase,
    detail?: string
  ): void {
    const running = !TERMINAL_PHASES.has(phase)
    this.runs.set(reviewId, detail ? { runId, running, phase, detail, startedAt } : { runId, running, phase, startedAt })
  }
}

// One registry per main process. The guide can be driven from several places
// (the companion brief run, the guide terminal, the review MCP tools) and they
// all have to agree on whether a run is live, so the instance is shared rather
// than threaded through each call site. Injectable everywhere it is consumed so
// tests drive their own.
export const guideRunRegistry = new GuideRunRegistry()
