import { type DesignSystemScaffoldResult } from '../../shared/design-system/bundle-scaffold';
export declare function kebabCaseBundleName(value: string): string;
export interface ScaffoldDesignSystemBundleInput {
    /** Workspace root the bundle directory is created under. */
    workspaceRoot: string;
    /** Human workspace/system name; kebab-cased into the manifest `name`. */
    name: string;
    /** The user's design goal; collapsed into the manifest `summary`. */
    summary: string;
    /** Absolute path of resources/design-system/templates (resolved by the caller). */
    templatesDir: string;
}
/**
 * Stamp the bundle layout into `<workspaceRoot>/design-system/`. Never
 * overwrites: when a manifest already exists the result reports
 * `alreadyExisted` and leaves the bundle untouched, so reopening an authoring
 * workspace resumes it. Any other failure is returned as `ok: false` with the
 * cause — no partial-success masking.
 */
export declare function scaffoldDesignSystemBundle(input: ScaffoldDesignSystemBundleInput): Promise<DesignSystemScaffoldResult>;
/**
 * Create a new bundle SEEDED from one the user already has (item 2005).
 *
 * "Start from one you have" copies a source bundle into a folder the user chose,
 * then restamps its identity so the copy is genuinely a new system rather than a
 * second thing claiming to be the first: name, summary, and version reset to
 * 1.0.0, and the source's release provenance is dropped — it belongs to the
 * system it came from, not to this one.
 *
 * The bundle it writes is the user's from the moment it exists. This is the ONE
 * place the design surface writes a bundle at all, and it writes only into the
 * folder the user picked.
 */
export declare function seedDesignSystemBundle(input: {
    /** The bundle to copy, or null for a bare scaffold from the templates. */
    sourceDir: string | null;
    /** The folder the user chose. The bundle IS this directory. */
    targetDir: string;
    name: string;
    summary: string;
    templatesDir: string;
}): Promise<DesignSystemScaffoldResult>;
