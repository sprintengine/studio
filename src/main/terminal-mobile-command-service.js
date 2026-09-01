import { createMobileAutomationsController } from './mobile/sprintengine/automations-controller';
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command';
import { DesktopMobileSprintEngineSessionOrchestrator, } from './mobile/sprintengine/session';
export function createTerminalMobileCommandService({ listTerminals, spawnAgentTerminal, writeTerminal, setSprintEngineAutomationMode, resolveAutomationsFrontDoor, }) {
    const orchestrator = new DesktopMobileSprintEngineSessionOrchestrator({
        adapters: {
            listTerminals,
            spawnAgentTerminal,
            writeTerminal,
            ...(setSprintEngineAutomationMode ? { setSprintEngineAutomationMode } : {}),
        },
    });
    return new MobileSprintEngineCommandService({
        workspaceRoot: process.cwd(),
        sessionOrchestrator: orchestrator,
        ...(resolveAutomationsFrontDoor
            ? { automationsController: createMobileAutomationsController(resolveAutomationsFrontDoor) }
            : {}),
    });
}
