import { readdirSync, readFileSync } from 'fs';
import { cp, mkdir, readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, join } from 'path';
import { BUNDLED_MODULE_IDS } from '../../shared/modules/manifest';
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest';
import { classifyModuleTrust, isSignedByTrustedPublisher, manifestFingerprint } from './module-signature';
// Discovery + install for third-party capability modules under
// ~/.multicode/modules/<id>/manifest.json. Mirrors the BYO-CLI plugin-registry
// pattern. This layer validates, classifies trust, and installs — it does NOT
// execute module code; trusted `entry.main` loading is wired separately through
// third-party-main-loader.
// MULTICODE_USER_MODULE_ROOT redirects discovery for hermetic end-to-end
// testing (paired with MULTICODE_USER_DATA_DIR temp profiles). It moves the
// install root only — trust classification, signing, and isLoadEligible gating
// apply to that root exactly as they do to the default one.
export function defaultUserModuleRoot() {
    const override = process.env.MULTICODE_USER_MODULE_ROOT?.trim();
    if (override)
        return override;
    return join(homedir(), '.multicode', 'modules');
}
const RESERVED_IDS = new Set(BUNDLED_MODULE_IDS);
async function readDirSafe(dir) {
    try {
        return await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function readDirSafeSync(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
// Validate the manifest.json in a module folder and confirm its declared id
// matches the folder name and isn't an impermissible reserved id. Reserved
// (bundled) ids are publisher-locked, not absolutely blocked: a module signed
// with a first-party marketplace publisher key may claim one — that's how the
// extracted first-party modules keep their ids (and existing workspace modes)
// while third parties still can't shadow them.
function validateInstalledManifestSource(source, manifestPath, expectedId, ctx) {
    const result = parseThirdPartyModuleManifest(source);
    if (!result.ok)
        return { ok: false, rejection: { path: manifestPath, issues: result.issues } };
    if (RESERVED_IDS.has(result.manifest.id) && !isSignedByTrustedPublisher(result.manifest, ctx)) {
        return {
            ok: false,
            rejection: {
                path: manifestPath,
                issues: [{ path: 'id', message: `"${result.manifest.id}" is a reserved id, publisher-locked to the first-party signing key.` }],
            },
        };
    }
    if (result.manifest.id !== expectedId) {
        return {
            ok: false,
            rejection: {
                path: manifestPath,
                issues: [
                    { path: 'id', message: `manifest id "${result.manifest.id}" must match its folder name "${expectedId}".` },
                ],
            },
        };
    }
    return { ok: true, manifest: result.manifest };
}
async function loadManifestFromDir(moduleRoot, expectedId, ctx) {
    const manifestPath = join(moduleRoot, 'manifest.json');
    let source;
    try {
        source = await readFile(manifestPath, 'utf8');
    }
    catch (error) {
        return {
            ok: false,
            rejection: {
                path: manifestPath,
                issues: [{ path: '', message: error instanceof Error ? error.message : 'manifest.json not found' }],
            },
        };
    }
    return validateInstalledManifestSource(source, manifestPath, expectedId, ctx);
}
function loadManifestFromDirSync(moduleRoot, expectedId, ctx) {
    const manifestPath = join(moduleRoot, 'manifest.json');
    let source;
    try {
        source = readFileSync(manifestPath, 'utf8');
    }
    catch (error) {
        return {
            ok: false,
            rejection: {
                path: manifestPath,
                issues: [{ path: '', message: error instanceof Error ? error.message : 'manifest.json not found' }],
            },
        };
    }
    return validateInstalledManifestSource(source, manifestPath, expectedId, ctx);
}
// Enumerate installed third-party modules, validating + trust-classifying each.
export async function discoverUserModules(root, ctx) {
    const modules = [];
    const rejected = [];
    for (const entry of await readDirSafe(root)) {
        if (!entry.isDirectory())
            continue;
        const moduleRoot = join(root, entry.name);
        const loaded = await loadManifestFromDir(moduleRoot, entry.name, ctx);
        if (!loaded.ok) {
            rejected.push(loaded.rejection);
            continue;
        }
        modules.push({ manifest: loaded.manifest, moduleRoot, trust: classifyModuleTrust(loaded.manifest, ctx) });
    }
    modules.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { modules, rejected };
}
export function discoverUserModulesSync(root, ctx) {
    const modules = [];
    const rejected = [];
    for (const entry of readDirSafeSync(root)) {
        if (!entry.isDirectory())
            continue;
        const moduleRoot = join(root, entry.name);
        const loaded = loadManifestFromDirSync(moduleRoot, entry.name, ctx);
        if (!loaded.ok) {
            rejected.push(loaded.rejection);
            continue;
        }
        modules.push({ manifest: loaded.manifest, moduleRoot, trust: classifyModuleTrust(loaded.manifest, ctx) });
    }
    modules.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { modules, rejected };
}
// Validate the manifest in a selected folder, then copy the whole folder into
// the user module root under its declared id (overwriting an existing install of
// the same id). Returns the trust classification so the UI can prompt.
export async function installModuleFolder(srcDir, root, ctx) {
    // The folder name a manifest must match is its own id, so validate against the
    // manifest's declared id rather than the (arbitrary) source folder name.
    const manifestPath = join(srcDir, 'manifest.json');
    let source;
    try {
        source = await readFile(manifestPath, 'utf8');
    }
    catch (error) {
        const rejection = {
            path: manifestPath,
            issues: [{ path: '', message: error instanceof Error ? error.message : 'manifest.json not found' }],
        };
        return { ok: false, rejected: rejection, message: 'No manifest.json found in the selected folder.' };
    }
    const result = parseThirdPartyModuleManifest(source);
    if (!result.ok) {
        return {
            ok: false,
            rejected: { path: manifestPath, issues: result.issues },
            message: 'Module manifest is invalid.',
        };
    }
    if (RESERVED_IDS.has(result.manifest.id) && !isSignedByTrustedPublisher(result.manifest, ctx)) {
        const message = `"${result.manifest.id}" is a reserved id, publisher-locked to the first-party signing key.`;
        return {
            ok: false,
            rejected: { path: manifestPath, issues: [{ path: 'id', message }] },
            message,
        };
    }
    const destination = join(root, result.manifest.id);
    await mkdir(root, { recursive: true });
    // Copy the folder by content; force overwrites a prior install of this id.
    await cp(srcDir, destination, { recursive: true, force: true });
    return {
        ok: true,
        id: result.manifest.id,
        trust: classifyModuleTrust(result.manifest, ctx),
        manifestFp: manifestFingerprint(result.manifest),
    };
}
// Exported for tests / callers that need the install destination of an id.
export function moduleInstallPath(root, id) {
    return join(root, basename(id));
}
