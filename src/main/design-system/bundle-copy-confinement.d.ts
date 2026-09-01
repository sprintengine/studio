/**
 * Walk a bundle directory and return the bundle-relative path of the first
 * symlink that is not confined to the bundle, or null when the whole tree is
 * safe to copy verbatim.
 */
export declare function findEscapingSymlink(bundleDir: string): Promise<string | null>;
