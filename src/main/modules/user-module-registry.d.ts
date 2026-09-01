import { type CapabilityManifest } from '../../shared/modules/manifest';
import { type ModuleTrust, type ModuleTrustContext } from './module-signature';
export declare function defaultUserModuleRoot(): string;
export type ModuleRejectionIssue = {
    path: string;
    message: string;
};
export type ModuleRejection = {
    path: string;
    issues: ModuleRejectionIssue[];
};
export type InstalledModule = {
    manifest: CapabilityManifest;
    moduleRoot: string;
    trust: ModuleTrust;
};
export type UserModuleListResult = {
    modules: InstalledModule[];
    rejected: ModuleRejection[];
};
export type InstallModuleResult = {
    ok: true;
    id: string;
    trust: ModuleTrust;
    manifestFp: string;
} | {
    ok: false;
    rejected: ModuleRejection;
    message: string;
};
export declare function discoverUserModules(root: string, ctx: ModuleTrustContext): Promise<UserModuleListResult>;
export declare function discoverUserModulesSync(root: string, ctx: ModuleTrustContext): UserModuleListResult;
export declare function installModuleFolder(srcDir: string, root: string, ctx: ModuleTrustContext): Promise<InstallModuleResult>;
export declare function moduleInstallPath(root: string, id: string): string;
