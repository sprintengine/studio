import type { TerminalSessionSnapshot } from '../shared/electron-api'
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc'
import { createMobileAutomationsController } from './mobile/sprintengine/automations-controller'
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command'
import {
  DesktopMobileSprintEngineSessionOrchestrator,
  type DesktopMobileSprintEngineSessionAdapters,
} from './mobile/sprintengine/session'

type TerminalMobileCommandServiceOptions = {
  listTerminals(): Promise<TerminalSessionSnapshot[]>
  spawnAgentTerminal: DesktopMobileSprintEngineSessionAdapters['spawnAgentTerminal']
  writeTerminal(sessionId: string, data: string): void
  setSprintEngineAutomationMode?: DesktopMobileSprintEngineSessionAdapters['setSprintEngineAutomationMode']
  // Item 47: the phone's `automations.control` command. Resolved lazily because
  // the Automations module registers its front door on the kernel after app
  // services are built; absent (tests, or a build without the module) means the
  // command rejects cleanly instead of writing the store behind the engine's back.
  resolveAutomationsFrontDoor?: () => AutomationsAppFrontDoor | null
}

export function createTerminalMobileCommandService({
  listTerminals,
  spawnAgentTerminal,
  writeTerminal,
  setSprintEngineAutomationMode,
  resolveAutomationsFrontDoor,
}: TerminalMobileCommandServiceOptions): MobileSprintEngineCommandService {
  const orchestrator = new DesktopMobileSprintEngineSessionOrchestrator({
    adapters: {
      listTerminals,
      spawnAgentTerminal,
      writeTerminal,
      ...(setSprintEngineAutomationMode ? { setSprintEngineAutomationMode } : {}),
    },
  })

  return new MobileSprintEngineCommandService({
    workspaceRoot: process.cwd(),
    sessionOrchestrator: orchestrator,
    ...(resolveAutomationsFrontDoor
      ? { automationsController: createMobileAutomationsController(resolveAutomationsFrontDoor) }
      : {}),
  })
}
