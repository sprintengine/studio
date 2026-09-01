import type { PluginManifestValidationIssue } from '../shared/plugin-manifest';
export type InstallPluginOk = {
    ok: true;
    id: string;
    kind: 'cli' | 'provider';
    displayName: string;
};
export type InstallPluginError = {
    ok: false;
    message: string;
    issues?: PluginManifestValidationIssue[];
};
export type InstallPluginResult = InstallPluginOk | InstallPluginError;
/**
 * Validate the plugin.json in a selected folder, then copy the whole folder
 * into the user plugin root under its declared id (overwriting an existing
 * install of the same id). The destination folder name is the manifest's
 * declared id so the registry's folder-name==id check always passes, regardless
 * of the (arbitrary) source folder name.
 */
export declare function installPluginFolder(srcDir: string, root: string): Promise<InstallPluginResult>;
