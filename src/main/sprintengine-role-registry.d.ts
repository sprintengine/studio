import { type RoleInstallResult, type UserRoleDeleteResult, type UserRoleGetResult, type UserRoleListResult, type UserRoleSaveInput, type UserRoleSaveResult } from '../shared/sprintengine/role-manifest';
export declare function defaultUserRoleRegistryRoot(): string;
export type { RoleInstallResult, UserRoleDeleteResult, UserRoleGetResult, UserRoleListResult, UserRoleSaveInput, UserRoleSaveResult, } from '../shared/sprintengine/role-manifest';
export declare function resolveRoleInstallTargets(srcDir: string): Promise<{
    roleFiles: string[];
    skillDirs: string[];
}>;
export declare function installRoleFolder(srcDir: string, root: string): Promise<RoleInstallResult>;
export declare function loadUserRoleManifests(root: string): Promise<UserRoleListResult>;
export declare function saveUserRole(input: UserRoleSaveInput, root: string): Promise<UserRoleSaveResult>;
export declare function deleteUserRole(id: string, root: string): Promise<UserRoleDeleteResult>;
export declare function getUserRole(id: string, root: string): Promise<UserRoleGetResult>;
