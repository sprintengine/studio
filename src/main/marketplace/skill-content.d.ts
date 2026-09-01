import type { MarketplacePluginSkillFile } from '../../shared/marketplace';
/**
 * Folder digest formula shared with @hotstack/catalogue-snapshot: sha256 over
 * the sorted `<path>\0<sha256>` lines of the file listing, joined with `\n`.
 */
export declare function skillContentDigest(files: readonly MarketplacePluginSkillFile[]): string;
export type SkillFolderVerification = {
    ok: true;
} | {
    ok: false;
    message: string;
};
/**
 * Verify a bundled skill folder byte-for-byte against its digest listing:
 * exactly the listed files (no extras, no gaps, regular files only) with
 * matching on-disk size AND sha256 per file, and a listing that reproduces
 * `contentDigest`.
 */
export declare function verifyBundledSkillFolder(folderPath: string, files: readonly MarketplacePluginSkillFile[], contentDigest: string): Promise<SkillFolderVerification>;
