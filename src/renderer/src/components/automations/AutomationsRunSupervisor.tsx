import { useEffect } from 'react'

import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { RUN_TARGET_KIND, encodeRunRef } from './runTarget'

// Always-mounted renderer observer of T12's automation run-event channel
// (`window.api.onAutomationRunEvent`). It surfaces overnight/background run
// outcomes the AutomationsPanel can't observe — the panel only sees a terminal
// status for a manual Run-now (its IPC return, handled by T6).
//
// Contributed as the automations workspace-type's `scope:'global'` supervisor
// (see automations-workspace-types.ts), so the shell's workspace-type supervisor
// registry mounts it on the primary window whenever the automations module is
// enabled — even when no automations workspace is open. Mirrors the Sprint
// Engine / Multiloop auto-run supervisor precedent.
//
// Disjoint from T6 by design: notifies ONLY on `trigger:'timer'` (scheduled)
// events, so a manual Run-now is never double-toasted. Reuses the
// source-'automations' notification action provider and the run-target deep-link
// contract registered in T6 — no second provider, no new surface. Observer only:
// it reads the store to resolve the run's folder but never mutates it.
export default function AutomationsRunSupervisor(): null {
  useEffect(() => {
    if (typeof window.api?.onAutomationRunEvent !== 'function') return
    return window.api.onAutomationRunEvent((event: AutomationsRunEvent) => {
      // Scheduled runs only — manual Run-now notifications are owned by T6.
      if (event.trigger !== 'timer') return
      // Keep noise low: only surface terminal runs that need attention.
      if (event.status !== 'failed' && event.status !== 'blocked') return
      // The run's project folder lets the Open action resolve/create the
      // control-center workspace even when none is currently open.
      const folderPath =
        useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === event.workspaceId)?.folderPath
        ?? null
      publishDiagnosticSync({
        level: event.status === 'failed' ? 'error' : 'warning',
        source: 'automations',
        title: `Automation ${event.status}: ${event.definitionName}`,
        message: `The scheduled run ended ${event.status}. Open to see its run history.`,
        workspaceId: event.workspaceId,
        navigationTarget: { kind: RUN_TARGET_KIND, ref: encodeRunRef(event.automationId, event.runId, folderPath) },
      })
    })
  }, [])

  return null
}
