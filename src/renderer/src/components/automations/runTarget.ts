import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import type { DiagnosticLogInput, NotificationNavigationTarget } from '../../types/workspace'

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

// The door-routed deep-link kind. Once the full-page Automations surface (epic
// 1704 / item 1707) is wired, a run notification opens that door and selects the
// run's automation, instead of revealing the now rail-hidden host workspace. The
// ref payload is identical to the legacy run target (automationId + runId +
// folderPath), so the two kinds share `encodeRunRef`/`decodeRunRef`; only the
// kind differs, letting the notification-action provider route the door path
// while the legacy reveal path keeps working until the surface consumes it.
export const AUTOMATIONS_DOOR_TARGET_KIND = 'automations-door'

// Build the door navigation target for a run. The surface consumer (T4) reads it
// with `decodeAutomationTargetRef` and opens the door at the automation.
export function automationsDoorTarget(
  automationId: string,
  runId: string,
  folderPath: string | null,
): NotificationNavigationTarget {
  return { kind: AUTOMATIONS_DOOR_TARGET_KIND, ref: encodeRunRef(automationId, runId, folderPath) }
}

// Decode a navigation target of EITHER the legacy run kind or the door kind into
// the shared run ref, or null for any other kind / malformed ref. A single
// decode both kinds share, so a consumer accepts both during the migration
// without forking the parse.
export function decodeAutomationTargetRef(
  target: { kind: string; ref?: string } | null | undefined,
): RunTargetRef | null {
  if (!target || typeof target.ref !== 'string') return null
  if (target.kind !== RUN_TARGET_KIND && target.kind !== AUTOMATIONS_DOOR_TARGET_KIND) return null
  return decodeRunRef(target.ref)
}

// The notification a background (scheduled) run event should raise, or null
// when it must be ignored. Disjoint from T6's manual Run-now by trigger: only
// `timer` runs notify here. A failed or blocked run is an error or a warning; a
// completed one is an info row (owner, 2026-09-07, with the app rail's badges):
// an overnight run that finished is exactly what the Automations square counts
// while the door is closed, and info never toasts, never pulses the bell and
// never inflates its error count — the low-noise policy holds. `resolveFolderPath`
// is a thunk so the (store-backed) lookup only runs when we actually notify,
// and so the decision stays pure + unit-testable. Pairs with the
// source-'automations' action provider's deep-link contract.
export function scheduledRunNotification(
  event: AutomationsRunEvent,
  resolveFolderPath: () => string | null,
): DiagnosticLogInput | null {
  if (event.trigger !== 'timer') return null
  // Copy is interpolation-free per status: templating the status into the
  // sentence produced "The scheduled run ended failed." The run's own summary
  // names the cause (it cannot be shown here — the run event carries no summary
  // field), so every line sends the reader to the run rather than guessing for them.
  const copy =
    event.status === 'failed'
      ? {
          level: 'error' as const,
          title: 'Automation failed',
          message: 'This scheduled run did not finish. Open it to see what stopped it.',
        }
      : event.status === 'blocked'
        ? {
            level: 'warning' as const,
            title: 'Automation blocked',
            message: 'This scheduled run is blocked and cannot continue. Open it to see why.',
          }
        : {
            level: 'info' as const,
            title: 'Automation finished',
            message: 'This scheduled run finished. Open it to see what it did.',
          }
  return {
    level: copy.level,
    source: 'automations',
    title: `${copy.title}: ${event.definitionName}`,
    message: copy.message,
    workspaceId: event.workspaceId,
    // The full-page Automations door target (item 1707): Open opens the door and
    // selects this run's automation, not the retired host workspace.
    navigationTarget: automationsDoorTarget(event.automationId, event.runId, resolveFolderPath()),
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
