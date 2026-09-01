import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { DESIGN_SYSTEM_MANIFEST_FILENAME, DESIGN_SYSTEM_SCHEMA_VERSION, parseDesignSystemManifest, } from '../../shared/design-system/manifest';
import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME, } from '../../shared/design-system/bundle-scaffold';
// Scaffolds the design-system bundle layout for the Design Wizard's
// design-system preset: stamps the governance templates (USAGE.md, AGENTS.md,
// scripts/*.mjs) from resources/design-system/templates verbatim, creates the
// authored-content directories, and writes a fresh manifest. Authored content
// (tokens, principles, components, patterns, glyphs) is the designer agent's
// work — the scaffold never seeds sample design content, so nothing in the
// bundle pretends to be authored. Layout contract:
// knowledge/multicode/design-system-bundle.md.
const AUTHORED_CONTENT_DIRECTORIES = [
    'foundations',
    'components',
    'patterns',
    'glyphs',
    'assets',
    'catalog',
];
// v1 naming-grammar prose is part of the schema contract and identical for
// every authored bundle (the reference example carries the same text).
const V1_NAMING_GRAMMAR = {
    tokens: "<tier>.<group...>.<name> — tier is 'ref' or 'sem'; every segment is lowercase kebab-case; nesting follows DTCG groups; aliases reference the full dotted path as {tier.group.name}",
    cssVariables: "'--' plus the token path with '.' replaced by '-' (sem.color.bg.app -> --sem-color-bg-app); components consume only the --sem-* set",
    components: 'kebab-case directory under components/, containing component.html, component.css, and component.md',
    glyphs: 'kebab-case concept name, one concept per SVG; strokes and fills use currentColor',
};
export function kebabCaseBundleName(value) {
    const name = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return name || DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME;
}
function manifestSummary(raw) {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (!collapsed)
        return 'Design system authored in the Multicode Design Wizard.';
    return collapsed.length > 160 ? `${collapsed.slice(0, 159).trimEnd()}…` : collapsed;
}
function buildManifestJson(name, summary) {
    const manifest = {
        schemaVersion: DESIGN_SYSTEM_SCHEMA_VERSION,
        name,
        version: '0.1.0',
        summary,
        modes: ['light', 'dark'],
        namingGrammar: V1_NAMING_GRAMMAR,
        contents: { foundations: [], components: [], patterns: [], glyphs: [], assets: [] },
        derived: {
            'foundations/tokens.css': 'scripts/build-tokens.mjs',
            'catalog/index.html': 'scripts/build-catalog.mjs',
        },
        provenance: {
            authoredBy: 'multicode-design-wizard',
            sourceLibraryId: null,
            sourceLibraryVersion: null,
            releasedAt: null,
            attachedAt: null,
        },
    };
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    // Self-check against the canonical parser so a scaffold bug fails loudly
    // here instead of surfacing later as an unreadable bundle.
    parseDesignSystemManifest(json);
    return json;
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Stamp the bundle layout into `<workspaceRoot>/design-system/`. Never
 * overwrites: when a manifest already exists the result reports
 * `alreadyExisted` and leaves the bundle untouched, so reopening an authoring
 * workspace resumes it. Any other failure is returned as `ok: false` with the
 * cause — no partial-success masking.
 */
export async function scaffoldDesignSystemBundle(input) {
    if (!input.workspaceRoot.trim()) {
        return { ok: false, message: 'No workspace root provided.' };
    }
    const bundleDir = join(input.workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME);
    return stampBundleInto({ ...input, bundleDir });
}
/**
 * Stamp the layout into an EXPLICIT directory.
 *
 * Split out of `scaffoldDesignSystemBundle` because that one always appends
 * `design-system/` to a workspace root — correct for the authoring studio, wrong
 * for "create a system in the folder I just chose", where the folder the user
 * picked IS the bundle.
 */
async function stampBundleInto(input) {
    const { bundleDir } = input;
    try {
        if (await pathExists(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME))) {
            return { ok: true, bundleDir, alreadyExisted: true };
        }
        const templateFiles = ['USAGE.md', 'AGENTS.md'];
        for (const file of templateFiles) {
            if (!(await pathExists(join(input.templatesDir, file)))) {
                return {
                    ok: false,
                    message: `Design-system template missing: ${file} (looked in ${input.templatesDir})`,
                };
            }
        }
        const scriptsDir = join(input.templatesDir, 'scripts');
        const scriptNames = (await readdir(scriptsDir).catch(() => [])).filter((name) => name.endsWith('.mjs'));
        if (scriptNames.length === 0) {
            return {
                ok: false,
                message: `Design-system script templates missing (looked in ${scriptsDir})`,
            };
        }
        await mkdir(bundleDir, { recursive: true });
        for (const directory of AUTHORED_CONTENT_DIRECTORIES) {
            await mkdir(join(bundleDir, directory), { recursive: true });
        }
        for (const file of templateFiles) {
            await copyFile(join(input.templatesDir, file), join(bundleDir, file));
        }
        await mkdir(join(bundleDir, 'scripts'), { recursive: true });
        for (const script of scriptNames.sort()) {
            await copyFile(join(scriptsDir, script), join(bundleDir, 'scripts', script));
        }
        await writeFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), buildManifestJson(kebabCaseBundleName(input.name), manifestSummary(input.summary)));
        // Read-back verification: the manifest on disk must parse with the
        // canonical parser before the scaffold reports success.
        parseDesignSystemManifest(await readFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8'));
        return { ok: true, bundleDir };
    }
    catch (error) {
        return {
            ok: false,
            message: `Could not scaffold the design-system bundle: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
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
export async function seedDesignSystemBundle(input) {
    if (!input.targetDir.trim())
        return { ok: false, message: 'No folder chosen.' };
    if (!input.name.trim())
        return { ok: false, message: 'A design system needs a name.' };
    // Never write over an existing bundle: the same rule the scaffold has always
    // had, for the same reason — the folder may be someone's work.
    if (await pathExists(join(input.targetDir, DESIGN_SYSTEM_MANIFEST_FILENAME))) {
        return {
            ok: true,
            bundleDir: input.targetDir,
            alreadyExisted: true,
        };
    }
    // Cancel-safety: remember whether the folder existed before us, so a failure
    // can leave the disk exactly as it was. A folder the user already had is never
    // removed — only one we created.
    const targetPreexisted = await pathExists(input.targetDir);
    const createdPaths = [];
    try {
        if (!input.sourceDir) {
            // Empty system: stamp the shipped templates into the folder the user
            // chose. NOT via scaffoldDesignSystemBundle, which appends `design-system/`
            // to its root — that is right for the authoring studio and wrong here,
            // where the chosen folder IS the bundle.
            createdPaths.push(input.targetDir);
            const stamped = await stampBundleInto({
                workspaceRoot: dirname(input.targetDir),
                bundleDir: input.targetDir,
                name: input.name,
                summary: input.summary,
                templatesDir: input.templatesDir,
            });
            if (!stamped.ok)
                throw new Error(stamped.message ?? 'scaffold failed');
            return stamped;
        }
        const sourceManifestPath = join(input.sourceDir, DESIGN_SYSTEM_MANIFEST_FILENAME);
        if (!(await pathExists(sourceManifestPath))) {
            return { ok: false, message: `That folder is not a design system: ${input.sourceDir}` };
        }
        await mkdir(input.targetDir, { recursive: true });
        createdPaths.push(input.targetDir);
        // `dereference: false` keeps the source's own links as links; the source is a
        // bundle we already read, and materialising links would change what it is.
        await cp(input.sourceDir, input.targetDir, { recursive: true });
        await restampManifest(input.targetDir, input.name, input.summary);
        return { ok: true, bundleDir: input.targetDir };
    }
    catch (error) {
        // Leave nothing behind. A folder the user already had keeps its contents;
        // one we created goes entirely.
        if (!targetPreexisted) {
            for (const path of createdPaths)
                await rm(path, { recursive: true, force: true }).catch(() => undefined);
        }
        return {
            ok: false,
            message: `Could not create the design system: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * Give a seeded copy its own identity.
 *
 * Unknown manifest fields survive, because the canonical parser preserves them —
 * a bundle carrying vendor extensions keeps them through the copy. What does NOT
 * survive is the source's provenance: those stamps describe where the SOURCE came
 * from, and inheriting them would make the new system claim a history it does
 * not have.
 */
async function restampManifest(bundleDir, name, summary) {
    const manifestPath = join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME);
    const manifest = parseDesignSystemManifest(await readFile(manifestPath, 'utf8'));
    manifest.name = kebabCaseBundleName(name);
    manifest.summary = manifestSummary(summary);
    manifest.version = '1.0.0';
    manifest.provenance = {};
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    // Read-back verification before reporting success, as the scaffold does.
    parseDesignSystemManifest(json);
    await writeFile(manifestPath, json);
}
