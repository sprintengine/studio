import type { AppServices } from '../app-services';
import type { CapabilityManifest } from '../../shared/modules/manifest';
import type { CapabilityModule } from '../module-host/load-modules';
export type ModulePermissionsResolver = (moduleId: string) => readonly string[] | undefined;
export declare const AGENT_RUNTIME_MANIFEST: CapabilityManifest;
export declare function createAgentRuntimeModule(services: AppServices, options: {
    getModulePermissions: ModulePermissionsResolver;
}): CapabilityModule;
