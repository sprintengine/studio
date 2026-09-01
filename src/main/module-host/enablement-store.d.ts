import { type ModuleEnablementOverrides } from '../../shared/modules/manifest';
export declare function moduleEnablementPath(userDataDir: string): string;
export declare function parseModuleOverrides(raw: string): ModuleEnablementOverrides;
export declare function readModuleOverridesSync(userDataDir: string): ModuleEnablementOverrides;
export type ModuleEnablementWriteResult = {
    ok: boolean;
    message?: string;
};
export declare function writeModuleOverrides(userDataDir: string, overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult>;
