import { type MobileControlRoleDescriptor } from '../../../shared/mobile-control/protocol';
export type RoleCatalogReader = (workspaceRoot: string) => Promise<MobileControlRoleDescriptor[] | undefined>;
/** Drops the cache. Tests, and any surface that has just written a role. */
export declare function clearRoleCatalogCache(): void;
export declare const readWorkspaceRoleCatalog: RoleCatalogReader;
export declare function normalizeRoleCatalog(input: unknown): MobileControlRoleDescriptor[] | undefined;
