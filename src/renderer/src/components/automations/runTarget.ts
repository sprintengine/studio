import { normalizeProjectRootKey } from '../../utils/projectKnowledge'
import type { AutomationsRunEvent } from '../../../../shared/automations/contracts'
import type { DiagnosticLogInput } from '../../types/workspace'

// Mirrors workspacesSlice.workspaceFolderKey (normalize + lowercase) for
// folder-equality comparison, imported from the light projectKnowledge util so
// this contract module stays free of the workspace store / FlexLayout graph.
function folderKey(value: string | null | undefined): string | null {
  const normalized = normalizeProjectRootKey(value)
  return normalized ? normalized.toLowerCase() : null
}

// The one source of truth for the automations run notification deep-link
// contract, shared by the producers (AutomationsPanel manual Run-now, the
// AutomationsRunSupervisor background observer) and the consumer
// (AutomationsPanel reveal-target handler + the source-'automations' action
// provider). A run id alone can't be mapped to its definition or owning project
// without loading every history, so the target carries both ids plus the run's
// folderPath as plain JSON that survives notification persistence.
export const RUN_TARGET_KIND = 'run'

export type RunTargetRef = {
  automationId: string
  runId: string
  /** The run's project folder, used to resolve/create its control-center workspace. */
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
  return {
    level: event.status === 'failed' ? 'error' : 'warning',
    source: 'automations',
    title: `Automation ${event.status}: ${event.definitionName}`,
    message: `The scheduled run ended ${event.status}. Open to see its run history.`,
    workspaceId: event.workspaceId,
    navigationTarget: { kind: RUN_TARGET_KIND, ref: encodeRunRef(event.automationId, event.runId, resolveFolderPath()) },
  }
}

// Resolve the automations control-center workspace a run notification's Open
// action should land on. Dedupe-first: reuse an existing automations workspace
// for the run's folder; create one only if none exists, so Open reaches the
// control center even when nothing for this project is open (the background /
// overnight case). With no folderPath we cannot resolve a control center, so we
// fall back to the notification's own workspace id. Pure + injected
// `createAutomationsWorkspace` so it is unit-testable without the store.
export function resolveAutomationsWorkspaceId(input: {
  folderPath: string | null
  fallbackWorkspaceId: string
  workspaces: ReadonlyArray<{ id: string; mode: string; folderPath: string | null }>
  createAutomationsWorkspace: (folderPath: string) => string
}): string {
  const { folderPath, fallbackWorkspaceId, workspaces, createAutomationsWorkspace } = input
  if (!folderPath) return fallbackWorkspaceId
  const targetKey = folderKey(folderPath)
  const existing = workspaces.find(
    (workspace) => workspace.mode === 'automations' && folderKey(workspace.folderPath) === targetKey,
  )
  return existing?.id ?? createAutomationsWorkspace(folderPath)
}
