import type { IpcMain } from 'electron';
import type { ModuleEventEnvelope } from '../../shared/modules/events';
import type { CapabilityManifest, ModuleEnablementOverrides, ModuleResolutionErrorCode } from '../../shared/modules/manifest';
import { type ModuleNotification } from '../../shared/modules/notifications';
import { type MainHost, type MainKernel, type SidecarSpec } from './main-host';
export type CapabilityModule = {
    manifest: CapabilityManifest;
    /** Wire the module's services, IPC, sidecars, and lifecycle into the host. */
    registerMain?: (host: MainHost) => void;
};
export type MainModuleLoadError = {
    id: string;
    message: string;
};
export type MainModuleLoadReport = {
    loaded: string[];
    manifestOnly: string[];
    disabled: string[];
    errors: MainModuleLoadError[];
    sidecars: ReadonlyArray<SidecarSpec>;
};
export type MainModuleLiveUpdateReport = {
    loaded: string[];
    disabled: string[];
    errors: MainModuleLoadError[];
};
export type MainModuleLiveUpdateOptions = {
    /** Modules whose tracked main-process registrations can be changed without restart. */
    liveModuleIds: readonly string[];
};
export type LoadMainModulesResult = {
    report: MainModuleLoadReport;
    kernel: MainKernel;
    applyEnablement(overrides: ModuleEnablementOverrides, options: MainModuleLiveUpdateOptions): Promise<MainModuleLiveUpdateReport>;
};
export declare function loadMainModules(options: {
    ipcMain: IpcMain;
    modules: CapabilityModule[];
    overrides?: ModuleEnablementOverrides;
    provideServices?: (host: MainHost) => void;
    /**
     * Modules that must not load regardless of enablement, keyed by id to the
     * reason. The trust gate for third-party modules: when a future increment
     * adds discovered third-party modules to `modules`, it MUST pass each
     * non-`trusted` module here (e.g. `'untrusted'` / `'invalid_signature'`) so
     * its `registerMain` never runs. Bundled modules never appear here.
     */
    ineligible?: Record<string, ModuleResolutionErrorCode>;
    /** Pre-resolution launch errors from module discovery/validation. */
    launchErrors?: MainModuleLoadError[];
    /** Sends a module notification to every open renderer window. */
    deliverNotification?: (notification: ModuleNotification) => void;
    /** Sends a module event to every open renderer window. */
    deliverModuleEvent?: (event: ModuleEventEnvelope) => void;
    /** Clock override for notification flood-bound tests. */
    now?: () => number;
}): LoadMainModulesResult;
