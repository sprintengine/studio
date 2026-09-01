import type { DesignSystemBundleReadResult } from '../../shared/design-system/bundle-view';
/**
 * Read one design-system bundle directory.
 *
 * Failure is typed and always carries the path, because the rail renders a
 * broken row rather than dropping it: a system whose folder moved is still a
 * system the user pointed at, and silently losing the row would hide the fact
 * that anything is wrong.
 */
export declare function readDesignSystemBundle(bundleDir: string): Promise<DesignSystemBundleReadResult>;
