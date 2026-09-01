import type { AutomationsAppFrontDoor } from '../../ipc/automations-ipc';
import type { MobileAutomationsController } from './command';
export declare function createMobileAutomationsController(resolveFrontDoor: () => AutomationsAppFrontDoor | null): MobileAutomationsController;
