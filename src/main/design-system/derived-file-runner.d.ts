import type { BundleRegenResult, DerivedScriptRun, DesignSystemRegenResult } from '../../shared/design-system/derived-files';
export type { BundleRegenResult, DerivedScriptRun, DesignSystemRegenResult };
export interface BundleScriptExit {
    /** Null when the process could not be spawned or was killed on timeout. */
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
export type BundleScriptFork = (scriptPath: string, args: string[], options: {
    cwd: string;
}) => Promise<BundleScriptExit>;
/** Regenerate one bundle's derived files by running its generator scripts. */
export declare function regenerateBundleDerivedFiles(bundleDir: string, fork: BundleScriptFork): Promise<BundleRegenResult>;
/**
 * Find design-system bundles under a root: the root itself when it carries a
 * manifest, otherwise its direct child directories that do. This covers both
 * an explicit bundle dir (the attach caller) and a designer workspace
 * whose bundle lives one level down.
 */
export declare function discoverBundleDirs(rootDir: string): Promise<string[]>;
/**
 * Regenerate derived files for every bundle under a root. A readable root
 * with no bundle is a successful no-op, so non-design-system workspaces
 * (full-brief, frontend-design) are untouched — but a missing or unreadable
 * root is an observable failure, never a silent ok.
 */
export declare function regenerateDesignSystemDerivedFiles(rootDir: string, fork: BundleScriptFork): Promise<DesignSystemRegenResult>;
