import { type DesignSystemLibraryListResult, type DesignSystemLibraryReadResult, type DesignSystemRegisterResult, type DesignSystemRegistryFile } from '../../shared/design-system/library';
/** The registry file, beside the legacy copy directory so the two never collide. */
export declare function defaultDesignSystemRegistryPath(): string;
/** Where release-era copies live. Read for adoption; never written, never removed. */
export declare function defaultDesignSystemLibraryRoot(): string;
/**
 * Read the registry file, tolerating every way it can be absent or damaged.
 *
 * A missing file is an empty library — the ordinary first-run state. A file that
 * will not parse is ALSO treated as empty rather than throwing, because the
 * alternative is a door that cannot open at all; the next write rebuilds it.
 * Individual malformed entries are dropped, not the whole file.
 */
export declare function readDesignSystemRegistry(registryPath: string): Promise<DesignSystemRegistryFile>;
export interface LibraryPaths {
    registryPath: string;
    /** The release-era copy root, read once for adoption. */
    legacyRoot: string;
}
/**
 * List the library: every registered folder, probed live.
 *
 * A folder that cannot be read stays in the list as a row carrying its own
 * failure state — dropping it would hide the fact that anything is wrong, and
 * the user needs the row in order to re-point or forget it.
 */
export declare function listDesignSystemLibrary(paths: LibraryPaths): Promise<DesignSystemLibraryListResult>;
/** Read one registered design system by id. */
export declare function readDesignSystemLibraryEntry(paths: LibraryPaths, id: string): Promise<DesignSystemLibraryReadResult>;
/**
 * Register a folder. Nothing is copied — the library learns the path, and the
 * folder stays exactly where the user's repo put it.
 *
 * Registering a folder already in the library is not an error: it refreshes the
 * cached display values and returns the existing entry, because "point at the
 * one I already have" is a reasonable thing for a person to do twice.
 */
export declare function registerDesignSystemFolder(paths: LibraryPaths, folderPath: string): Promise<DesignSystemRegisterResult>;
/**
 * Forget a registration.
 *
 * Removes the reference and NOTHING else — the folder on disk is the user's, and
 * this app has never owned it. Forgetting an id that is not registered succeeds:
 * the desired end state is already true.
 */
export declare function forgetDesignSystemFolder(paths: LibraryPaths, id: string): Promise<{
    ok: true;
    forgotten: boolean;
}>;
