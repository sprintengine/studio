import { useEffect } from 'react'

import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { handleAutomationRunEvent } from './runTarget'

// Always-mounted renderer observer of T12's automation run-event channel
// (`window.api.onAutomationRunEvent`). It surfaces overnight/background run
// outcomes the AutomationsPanel can't observe — the panel only sees a terminal
// status for a manual Run-now (its IPC return, handled by T6).
//
// Contributed as the automations workspace-type's `scope:'global'` supervisor
// (see automations-workspace-types.ts), so the shell's workspace-type supervisor
// registry mounts it on the primary window whenever the automations module is
// enabled — even when no automations workspace is open.
//
// Mounted EAGERLY (not React.lazy): an always-on observer must subscribe as soon
// as the shell mounts, with no chunk-load gap that could drop an early
// run-event. To keep the eager module-registry graph (and the bundled-ids drift
// test) free of the workspace store / FlexLayout, this module imports no store
// at the top level — the run's folder is resolved on demand inside the handler
// via a dynamic import (and only when an event actually arrives).
//
// Disjoint from T6 by design: scheduledRunNotification notifies ONLY on
// `trigger:'timer'` failed/blocked events, so a manual Run-now is never
// double-toasted. Reuses the source-'automations' action provider and the
// run-target deep-link contract registered in T6 — no second provider, no new
// surface. Observer only: it reads the store to resolve a folder but never
// mutates it.
export default function AutomationsRunSupervisor(): null {
  useEffect(() => {
    if (typeof window.api?.onAutomationRunEvent !== 'function') return
    return window.api.onAutomationRunEvent((event: AutomationsRunEvent) => {
      void import('../../store/workspaceStore').then(({ useWorkspaceStore }) => {
        handleAutomationRunEvent(
          event,
          (workspaceId) =>
            useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
          publishDiagnosticSync,
        )
      })
    })
  }, [])

  return null
}
