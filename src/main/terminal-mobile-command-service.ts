import type { TerminalSessionSnapshot } from '../shared/electron-api'
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
}

export function createTerminalMobileCommandService({
  listTerminals,
  spawnAgentTerminal,
  writeTerminal,
  setSprintEngineAutomationMode,
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
  })
}
