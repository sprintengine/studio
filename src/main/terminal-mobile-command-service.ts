import type { TerminalSessionSnapshot } from '../shared/electron-api'
import { MobileSwarmCommandService } from './mobile-sprintengine-command'
import {
  DesktopMobileSwarmSessionOrchestrator,
  type DesktopMobileSwarmSessionAdapters,
} from './mobile-sprintengine-session'

type TerminalMobileCommandServiceOptions = {
  listTerminals(): Promise<TerminalSessionSnapshot[]>
  spawnAgentTerminal: DesktopMobileSwarmSessionAdapters['spawnAgentTerminal']
  writeTerminal(sessionId: string, data: string): void
}

export function createTerminalMobileCommandService({
  listTerminals,
  spawnAgentTerminal,
  writeTerminal,
}: TerminalMobileCommandServiceOptions): MobileSwarmCommandService {
  const orchestrator = new DesktopMobileSwarmSessionOrchestrator({
    adapters: {
      listTerminals,
      spawnAgentTerminal,
      writeTerminal,
    },
  })

  return new MobileSwarmCommandService({
    workspaceRoot: process.cwd(),
    sessionOrchestrator: orchestrator,
  })
}
