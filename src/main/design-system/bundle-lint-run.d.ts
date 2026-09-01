import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run';
import type { BundleScriptFork } from './derived-file-runner';
export declare function runDesignSystemBundleLint(bundleDir: string, fork: BundleScriptFork): Promise<DesignSystemBundleLintRunResult>;
