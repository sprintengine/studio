import type { ModuleResolutionErrorCode } from '../../shared/modules/manifest';
import type { CapabilityModule, MainModuleLoadError, MainModuleLoadReport } from '../module-host/load-modules';
import type { InstalledModule, ModuleRejection } from './user-module-registry';
export type ThirdPartyMainLoadDiagnostics = {
    rejected: ModuleRejection[];
};
export type ThirdPartyMainLoadInput = {
    modules: InstalledModule[];
    rejected: ModuleRejection[];
};
export type ThirdPartyMainLoadPlan = {
    modules: CapabilityModule[];
    ineligible: Record<string, ModuleResolutionErrorCode>;
    launchErrors: MainModuleLoadError[];
    diagnostics: ThirdPartyMainLoadDiagnostics;
};
export type ThirdPartyMainLaunchSnapshot = {
    loaded: ReadonlySet<string>;
    manifestOnly: ReadonlySet<string>;
    errors: ReadonlyMap<string, string>;
};
export declare function planThirdPartyMainModules(input: ThirdPartyMainLoadInput): ThirdPartyMainLoadPlan;
export declare function recordThirdPartyMainLaunchReport(moduleIds: readonly string[], report: MainModuleLoadReport): void;
export declare function readThirdPartyMainLaunchSnapshot(): ThirdPartyMainLaunchSnapshot;
