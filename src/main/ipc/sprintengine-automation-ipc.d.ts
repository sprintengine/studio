import type { IpcMain } from 'electron';
import type { SprintEngineAutomationService } from '../sprintengine-automation-service';
import type { SprintEngineLaunchSettingsMirror } from '../sprintengine-launch-settings-mirror';
export declare const SPRINT_ENGINE_AUTOMATION_CHANGED_CHANNEL = "sprintengine:automation-changed";
type SprintEngineAutomationIpcDependencies = {
    automation: Pick<SprintEngineAutomationService, 'readAutomationMode' | 'setAutomationMode' | 'hydrateAutomationMode' | 'setCliPermissionPreset'>;
    launchSettings: Pick<SprintEngineLaunchSettingsMirror, 'set' | 'hydrate'>;
};
export declare function registerSprintEngineAutomationIpc(ipcMain: IpcMain, deps: SprintEngineAutomationIpcDependencies): void;
export {};
