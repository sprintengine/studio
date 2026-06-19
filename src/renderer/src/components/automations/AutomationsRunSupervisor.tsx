import { useEffect } from 'react'

import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { scheduledRunNotification } from './runTarget'

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
      // scheduledRunNotification decides (timer-only, failed/blocked) and builds
      // the source-'automations' diagnostic; the folder thunk resolves the run's
      // project folder (for Open's resolve/create) only when we actually notify.
      const diagnostic = scheduledRunNotification(event, () =>
        useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === event.workspaceId)?.folderPath
        ?? null,
      )
      if (diagnostic) publishDiagnosticSync(diagnostic)
    })
  }, [])

  return null
}
