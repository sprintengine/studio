import type { ProjectLogo } from '../shared/electron-api';
export declare const PROJECT_LOGO_CANDIDATES: readonly ["logo.svg", "logo.png", "icon.svg", "icon.png", "favicon.svg", "favicon.png", "favicon.ico"];
export declare const PROJECT_LOGO_MAX_BYTES: number;
export declare const PROJECT_LOGO_RASTER_MAX_PX = 32;
export type ProjectLogoStat = {
    isFile: boolean;
    size: number;
    mtimeMs: number;
};
export type ProjectLogoIo = {
    /** Top-level entry names of the repo. Rejects when the folder is unreadable. */
    readdir(dirPath: string): Promise<string[]>;
    stat(filePath: string): Promise<ProjectLogoStat>;
    readFile(filePath: string): Promise<Buffer>;
    /**
     * Downscale a raster candidate to at most `maxPx` on its longest edge,
     * preserving aspect ratio. Returning the input unchanged is always valid —
     * the size guard has already run.
     */
    downscaleRaster(bytes: Buffer, mimeType: string, maxPx: number): Promise<{
        bytes: Buffer;
        mimeType: string;
    }>;
    join(dirPath: string, name: string): string;
};
export declare function rankProjectLogoCandidates(entryNames: string[]): string[];
export declare function sanitizeProjectLogoSvg(source: string): string | null;
/**
 * Scan the top level of `folderPath` for the project's logo. Returns null when
 * there is no usable candidate — the caller keeps today's glyph and nothing is
 * written anywhere.
 *
 * A candidate that is oversized, unreadable, or (for SVG) rejected by the
 * sanitizer does not end the scan: the next-ranked candidate is tried, exactly
 * as if the rejected file were not there.
 */
export declare function detectProjectLogo(folderPath: string, io: ProjectLogoIo): Promise<ProjectLogo | null>;
export type ProjectLogoResolver = {
    resolve(folderPath: string): Promise<ProjectLogo | null>;
};
/**
 * `detectProjectLogo` behind a hit cache. There is no watcher — the check runs
 * when a project is opened, and the cached entry is only trusted while the
 * resolved file still exists at the same mtime. Misses are never cached, so
 * dropping a `logo.svg` into a repo and reopening the project picks it up
 * without a restart.
 */
export declare function createProjectLogoResolver(io: ProjectLogoIo): ProjectLogoResolver;
