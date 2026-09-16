import type { AutomationsAppFrontDoor } from './ipc/automations-ipc'
import { createMobileAutomationsController } from './mobile/control/automations-controller'
import { MobileControlCommandService } from './mobile/control/command'

type TerminalMobileCommandServiceOptions = {
  // Item 47: the phone's `automations.control` command. Resolved lazily because
  // the Automations module registers its front door on the kernel after app
  // services are built; absent (tests, or a build without the module) means the
  // command rejects cleanly instead of writing the store behind the engine's back.
  resolveAutomationsFrontDoor?: () => AutomationsAppFrontDoor | null
}

// The phone's command service. It used to carry a session orchestrator as well —
// the adapters behind `task.start`, `agent.followUp` and a run's automation mode
// — and that left with the engine (MC-2575). What remains reaches the
// desktop's own stores, never a run's.
export function createTerminalMobileCommandService({
  resolveAutomationsFrontDoor,
}: TerminalMobileCommandServiceOptions): MobileControlCommandService {
  return new MobileControlCommandService({
    workspaceRoot: process.cwd(),
    ...(resolveAutomationsFrontDoor
      ? { automationsController: createMobileAutomationsController(resolveAutomationsFrontDoor) }
      : {}),
  })
}
