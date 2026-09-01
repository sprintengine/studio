import { cp, mkdir, readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { parseLayoutTemplateManifest, } from '../shared/layouts/template-manifest';
export function defaultUserLayoutTemplateRoot() {
    return join(homedir(), '.multicode', 'layout-templates');
}
async function readDirSafe(dir) {
    try {
        return await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
}
function isJsonFile(name) {
    return name.toLowerCase().endsWith('.json');
}
// Top-level *.json files in the selected folder are candidate templates.
export async function resolveTemplateFiles(srcDir) {
    return (await readDirSafe(srcDir))
        .filter((entry) => !entry.isDirectory() && isJsonFile(entry.name))
        .map((entry) => join(srcDir, entry.name));
}
// Validate and copy a folder's layout-template manifests into the user-global
// root. Malformed manifests are rejected (not copied).
export async function installLayoutTemplateFolder(srcDir, root) {
    const files = await resolveTemplateFiles(srcDir);
    if (files.length === 0) {
        return {
            ok: false,
            installed: [],
            rejected: [],
            message: 'No layout template JSON files found in the selected folder.',
        };
    }
    const installed = [];
    const rejected = [];
    for (const file of files) {
        let source;
        try {
            source = await readFile(file, 'utf8');
        }
        catch (error) {
            rejected.push({
                path: file,
                issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }],
            });
            continue;
        }
        const result = parseLayoutTemplateManifest(source);
        if (!result.ok) {
            rejected.push({ path: file, issues: result.issues });
            continue;
        }
        await mkdir(root, { recursive: true });
        // Name on disk by validated id so re-installing an updated template replaces
        // it deterministically rather than accumulating duplicate filenames.
        // force: true (the fs.cp default) makes the overwrite explicit.
        await cp(file, join(root, `${result.manifest.id}.json`), { force: true });
        installed.push(result.manifest.id);
    }
    return { ok: installed.length > 0, installed, rejected };
}
// List the layout templates currently installed in the user-global root, with
// malformed ones surfaced so the user can fix them.
export async function loadUserLayoutTemplates(root) {
    const templates = [];
    const rejected = [];
    for (const entry of await readDirSafe(root)) {
        if (entry.isDirectory() || !isJsonFile(entry.name))
            continue;
        const path = join(root, entry.name);
        let source;
        try {
            source = await readFile(path, 'utf8');
        }
        catch (error) {
            rejected.push({ path, issues: [{ path: '', message: error instanceof Error ? error.message : 'read failed' }] });
            continue;
        }
        const result = parseLayoutTemplateManifest(source);
        if (!result.ok) {
            rejected.push({ path, issues: result.issues });
            continue;
        }
        templates.push(result.manifest);
    }
    // Stable order by id so the picker doesn't reshuffle between loads.
    templates.sort((a, b) => a.id.localeCompare(b.id));
    return { templates, rejected };
}
