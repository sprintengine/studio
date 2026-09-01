import type { TerminalSessionSnapshot } from '../shared/electron-api';
import type { AutomationsAppFrontDoor } from './ipc/automations-ipc';
import { MobileSprintEngineCommandService } from './mobile/sprintengine/command';
import { type DesktopMobileSprintEngineSessionAdapters } from './mobile/sprintengine/session';
type TerminalMobileCommandServiceOptions = {
    listTerminals(): Promise<TerminalSessionSnapshot[]>;
    spawnAgentTerminal: DesktopMobileSprintEngineSessionAdapters['spawnAgentTerminal'];
    writeTerminal(sessionId: string, data: string): void;
    setSprintEngineAutomationMode?: DesktopMobileSprintEngineSessionAdapters['setSprintEngineAutomationMode'];
    resolveAutomationsFrontDoor?: () => AutomationsAppFrontDoor | null;
};
export declare function createTerminalMobileCommandService({ listTerminals, spawnAgentTerminal, writeTerminal, setSprintEngineAutomationMode, resolveAutomationsFrontDoor, }: TerminalMobileCommandServiceOptions): MobileSprintEngineCommandService;
export {};
