import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import type { DiagnosticLogInput } from '../../types/workspace'

// The one source of truth for the automations run notification deep-link
// contract, shared by the producers (the Automations screen's manual Run-now and
// the AutomationsRunSupervisor background observer) and the consumer (the
// source-'automations' notification action provider, which opens the global
// Automations screen at the run). A run id alone can't be mapped to its
// definition or owning project without loading every history, so the target
// carries both ids plus the run's folderPath as plain JSON that survives
// notification persistence.
export const RUN_TARGET_KIND = 'run'

export type RunTargetRef = {
  automationId: string
  runId: string
  /** The run's project folder, used to scope the global Automations screen to it. */
  folderPath: string | null
}

export function encodeRunRef(automationId: string, runId: string, folderPath: string | null): string {
  return JSON.stringify({ automationId, runId, folderPath: folderPath ?? null })
}

export function decodeRunRef(ref: string): RunTargetRef | null {
  try {
    const parsed = JSON.parse(ref) as { automationId?: unknown; runId?: unknown; folderPath?: unknown }
    if (typeof parsed.automationId === 'string' && typeof parsed.runId === 'string') {
      return {
        automationId: parsed.automationId,
        runId: parsed.runId,
        folderPath: typeof parsed.folderPath === 'string' ? parsed.folderPath : null,
      }
    }
  } catch {
    // Malformed/foreign target — ignore rather than guess a run to focus.
  }
  return null
}

// The notification a background (scheduled) run event should raise, or null
// when it must be ignored. Disjoint from T6's manual Run-now by trigger: only
// `timer` runs notify here, and only failed/blocked terminal states (completed
// stays silent, matching the panel's low-noise policy). `resolveFolderPath` is
// a thunk so the (store-backed) lookup only runs when we actually notify, and so
// the decision stays pure + unit-testable. Pairs with the source-'automations'
// action provider's deep-link contract.
export function scheduledRunNotification(
  event: AutomationsRunEvent,
  resolveFolderPath: () => string | null,
): DiagnosticLogInput | null {
  if (event.trigger !== 'timer') return null
  if (event.status !== 'failed' && event.status !== 'blocked') return null
  // Copy is interpolation-free per status: templating the status into the
  // sentence produced "The scheduled run ended failed." The run's own summary
  // names the cause (it cannot be shown here — the run event carries no summary
  // field), so both lines send the reader to the run rather than guessing for them.
  const failed = event.status === 'failed'
  return {
    level: failed ? 'error' : 'warning',
    source: 'automations',
    title: `${failed ? 'Automation failed' : 'Automation blocked'}: ${event.definitionName}`,
    message: failed
      ? 'This scheduled run did not finish. Open it to see what stopped it.'
      : 'This scheduled run is blocked and cannot continue. Open it to see why.',
    workspaceId: event.workspaceId,
    navigationTarget: { kind: RUN_TARGET_KIND, ref: encodeRunRef(event.automationId, event.runId, resolveFolderPath()) },
  }
}

// The observer's full event->publish boundary (the path tester C7 exercised in
// Electron): given a delivered run event, resolve its folder and publish the
// scheduled-run notification when one is warranted. Kept here as a pure,
// injected-port function so it is unit-testable without mounting React.
export function handleAutomationRunEvent(
  event: AutomationsRunEvent,
  resolveFolderPath: (workspaceId: string) => string | null,
  publish: (input: DiagnosticLogInput) => void,
): void {
  const diagnostic = scheduledRunNotification(event, () => resolveFolderPath(event.workspaceId))
  if (diagnostic) publish(diagnostic)
}

/** The single capability the run observer needs from T12's preload bridge. */
export type AutomationRunEventSource = {
  onAutomationRunEvent?: (listener: (event: AutomationsRunEvent) => void) => () => void
}

// The always-mounted observer's complete subscription wiring, extracted from the
// React component so the delivered-event -> publish boundary (tester C7/C9/C10:
// the path that failed in built Electron) is exercised the same way the mounted
// supervisor runs it — subscribe via `onAutomationRunEvent`, then per event
// resolve the run folder and publish. The subscription is attached synchronously
// (no async gap that could drop an early run-event); only the folder lookup is
// deferred via `loadResolveFolderPath`, so the eager observer module stays free
// of the workspace store / FlexLayout graph (bundled-ids drift guard). Returns
// the unsubscribe, or a no-op when the channel is unavailable.
export function subscribeAutomationRunNotifications(
  api: AutomationRunEventSource | undefined,
  loadResolveFolderPath: () => Promise<(workspaceId: string) => string | null>,
  publish: (input: DiagnosticLogInput) => void,
): () => void {
  if (typeof api?.onAutomationRunEvent !== 'function') return () => {}
  return api.onAutomationRunEvent((event) => {
    void loadResolveFolderPath().then((resolveFolderPath) =>
      handleAutomationRunEvent(event, resolveFolderPath, publish),
    )
  })
}
