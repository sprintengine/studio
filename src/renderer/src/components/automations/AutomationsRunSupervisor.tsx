import { useEffect } from 'react'

import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import { publishDiagnosticSync } from '../../utils/diagnostics'

// Always-mounted renderer observer of T12's automation run-event channel
// (`window.api.onAutomationRunEvent`). It surfaces overnight/background run
// outcomes that the AutomationsPanel can't observe — the panel only sees a
// terminal status for a manual Run-now (its IPC return, handled by T6).
//
// Disjoint from T6 by design: this observer notifies ONLY on `trigger:'timer'`
// (scheduled) events, so a manual Run-now is never double-toasted. It reuses
// the source-'automations' notification action provider and the
// `multicode:reveal-target` latch registered in T6 — no second provider, no new
// notification surface. Observer only: it never mutates the store or calls IPC
// beyond the subscription.
//
// Mounted as a primary-window global supervisor (gated by the automations
// module) so it is active regardless of whether an automations workspace is
// open.

// Mirror of AutomationsPanel's run-target contract (decodeRunRef): a run id
// alone can't be mapped to its definition without loading every history, so the
// reveal target carries both as plain JSON that survives notification storage.
function encodeRunRef(automationId: string, runId: string): string {
  return JSON.stringify({ automationId, runId })
}

export default function AutomationsRunSupervisor(): null {
  useEffect(() => {
    if (typeof window.api?.onAutomationRunEvent !== 'function') return
    return window.api.onAutomationRunEvent((event: AutomationsRunEvent) => {
      // Scheduled runs only — manual Run-now notifications are owned by T6.
      if (event.trigger !== 'timer') return
      // Keep noise low: only surface terminal runs that need attention.
      if (event.status !== 'failed' && event.status !== 'blocked') return
      publishDiagnosticSync({
        level: event.status === 'failed' ? 'error' : 'warning',
        source: 'automations',
        title: `Automation ${event.status}: ${event.definitionName}`,
        message: `The scheduled run ended ${event.status}. Open to see its run history.`,
        workspaceId: event.workspaceId,
        navigationTarget: { kind: 'run', ref: encodeRunRef(event.automationId, event.runId) },
      })
    })
  }, [])

  return null
}
