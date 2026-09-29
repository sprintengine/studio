import type {
  AutomationsDefinitionsChangedEvent,
  AutomationsInstanceEntry,
  AutomationsInstanceListResult,
} from '../../../../shared/automations/contracts'
import type { DiagnosticLogInput } from '../../types/workspace'
import { automationsDoorTarget } from './runTarget'

// The notice that an automation is waiting for approval, raised whether or not
// the Automations door is open. An automation that stops because nobody said
// yes must not stop silently — least of all the ones a user already had when
// the approval gate arrived, every one of which asks once. So the always-on run
// supervisor reads the index when it mounts and again whenever main says the
// definitions changed (which it also says when the engine first finds one
// waiting, e.g. after a `git pull`), and raises one notice per project for the
// automations it has not announced yet. Keyed by fingerprint, so an automation
// that changes again after being announced is announced again.
//
// Imports no store: the supervisor that calls this is mounted eagerly and must
// stay out of the workspace-store graph (see AutomationsRunSupervisor).

function announcementKey(entry: AutomationsInstanceEntry): string {
  return `${entry.workspaceRoot}\u0000${entry.definition.id}\u0000${entry.approval?.fingerprint ?? ''}`
}

function folderName(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/u, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

/**
 * The notices to raise for `entries`, given what was already announced. Adds
 * what it announces to `announced`. Pure apart from that set, so the wording and
 * the once-only rule are pinned by tests.
 */
export function approvalNotices(
  entries: readonly AutomationsInstanceEntry[],
  announced: Set<string>,
): DiagnosticLogInput[] {
  const fresh = new Map<string, AutomationsInstanceEntry[]>()
  for (const entry of entries) {
    if (entry.approval?.state !== 'needs-approval') continue
    const key = announcementKey(entry)
    if (announced.has(key)) continue
    announced.add(key)
    fresh.set(entry.workspaceRoot, [...(fresh.get(entry.workspaceRoot) ?? []), entry])
  }
  return [...fresh.entries()].map(([workspaceRoot, waiting]) => {
    const [first] = waiting
    const project = folderName(workspaceRoot)
    return {
      level: 'warning',
      source: 'automations',
      title:
        waiting.length === 1
          ? `Automation waiting for your OK: ${first.definition.name}`
          : `${waiting.length} automations in ${project} are waiting for your OK`,
      message:
        waiting.length === 1
          ? `It is in ${project}, and this app did not write it here, or it changed after you allowed it. It will not run until you review it.`
          : 'This app did not write them here, or they changed after you allowed them. None of them runs until you review it.',
      workspaceId: first.workspaceId || undefined,
      // Opens the door on the first of them; the review is its canvas. No run
      // to focus, so the run id is empty.
      navigationTarget: automationsDoorTarget(first.definition.id, '', workspaceRoot),
    }
  })
}

/** What the notice needs from the preload bridge. */
export type AutomationApprovalNoticeSource = {
  listInstanceAutomations?: () => Promise<AutomationsInstanceListResult>
  onAutomationsDefinitionsChanged?: (cb: (event: AutomationsDefinitionsChangedEvent) => void) => () => void
}

/**
 * Check now, then on every definitions-changed broadcast. Single-flight: a
 * broadcast that lands mid-check asks for one more pass rather than a second
 * read of every project in parallel. Returns the unsubscribe.
 */
export function subscribeAutomationApprovalNotices(
  api: AutomationApprovalNoticeSource | undefined,
  publish: (input: DiagnosticLogInput) => void,
): () => void {
  if (typeof api?.listInstanceAutomations !== 'function') return () => {}
  const list = api.listInstanceAutomations
  const announced = new Set<string>()
  let stopped = false
  let checking = false
  let again = false

  const check = async (): Promise<void> => {
    if (checking) {
      again = true
      return
    }
    checking = true
    try {
      do {
        again = false
        try {
          const index = await list()
          if (stopped || !index.ok) continue
          for (const notice of approvalNotices(index.value.entries, announced)) publish(notice)
        } catch {
          // The Automations door reports its own read failures; a notice is best-effort.
        }
      } while (again && !stopped)
    } finally {
      checking = false
    }
  }

  const unsubscribe = api.onAutomationsDefinitionsChanged?.(() => void check()) ?? (() => {})
  void check()
  return () => {
    stopped = true
    unsubscribe()
  }
}
