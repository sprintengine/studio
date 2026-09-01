import type { CapabilityModule } from '../module-host/load-modules';
import { type AutomationsModuleOptions } from './automations-module';
export type BundledMainModuleOptions = {
    automations?: AutomationsModuleOptions;
};
export declare function createBundledMainModules(options?: BundledMainModuleOptions): CapabilityModule[];
export declare const BUNDLED_MAIN_MODULES: CapabilityModule[];
