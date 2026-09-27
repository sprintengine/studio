import type { AutomationsAppFrontDoor } from '../../ipc/automations-ipc'
import type { MobileAutomationControlResult, MobileAutomationsController } from './command'

// Binds the phone's `automations.control` command to the SAME front door
// the desktop UI and the automation server write through (ipc/automations-ipc.ts):
// enable/pause is a status patch through the write core, run-now is `engine.runNow`.
//
// There is no second write path onto the automations store. A direct store write
// would skip the provider validation, the next-run recompute and the
// webhook-receiver refresh, and would leave the running engine holding a stale
// definition — the phone would report success while the desktop kept the old
// schedule.
//
// Only the fields the phone asked about come back. The engine's own result carries
// the full definition, whose trigger/action config is provider-owned `unknown` and
// can hold local paths and webhook secrets, and a command result crosses to
// another device, where neither belongs.
//
// No transport serves `automations.control` today: the tailnet gateway's
// command allowlist is `backlog.update` alone (automation-tools.ts), and widening
// it is a decision. This adapter is the seam that decision binds.
export function createMobileAutomationsController(
  resolveFrontDoor: () => AutomationsAppFrontDoor | null,
): MobileAutomationsController {
  return {
    async setStatus(request) {
      const frontDoor = resolveFrontDoor()
      if (!frontDoor) return automationsUnavailable()

      const updated = await frontDoor.updateDefinition({
        workspaceRoot: request.workspaceRoot,
        automationId: request.automationId,
        patch: { status: request.status },
      })
      if (!updated.ok) return rejection(updated)
      return { ok: true, value: { automationId: updated.value.id, status: updated.value.status } }
    },

    async runNow(request) {
      const frontDoor = resolveFrontDoor()
      if (!frontDoor) return automationsUnavailable()

      const fired = await frontDoor.runNow({
        workspaceRoot: request.workspaceRoot,
        automationId: request.automationId,
      })
      if (!fired.ok) return rejection(fired)
      return {
        ok: true,
        value: {
          automationId: fired.value.definition.id,
          status: fired.value.definition.status,
          runId: fired.value.run.id,
          runStatus: fired.value.run.status,
        },
      }
    },
  }
}

// The engine's own rejection codes (`unsupported_trigger`, `in_flight`, store
// failures) travel to the command service untouched; it owns the mapping onto the
// mobile error vocabulary, and it surfaces every one of them to the phone.
function rejection(failure: { code: string; message: string }): MobileAutomationControlResult {
  return { ok: false, error: { code: failure.code, message: failure.message } }
}

function automationsUnavailable(): MobileAutomationControlResult {
  return {
    ok: false,
    error: {
      code: 'automations_unavailable',
      message: 'The Automations module is not loaded on this desktop.',
    },
  }
}
