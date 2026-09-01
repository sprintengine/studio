import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { buildHarnessMap } from '../shared/harness-map';
import { plainSkillInvocation, resolveSkillInvocation } from '../shared/skill-invocation';
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../shared/skill-harnesses';
import { parseSkillFrontmatter, SKILL_ENTRY_FILE, } from '../shared/skills';
import { BUILTIN_SKILLS } from './builtin-skills';
// The .multicode-skill.json manifest a builtin install writes next to SKILL.md;
// version drift against BUILTIN_SKILLS marks the entry update-available without
// re-hashing the directory.
const BUILTIN_MANIFEST_FILE = '.multicode-skill.json';
export function createWorkspaceSkillsService() {
    return {
        async listWorkspaceSkills(input) {
            const workspaceRoot = input.workspaceRoot?.trim();
            if (!workspaceRoot || !existsSync(workspaceRoot)) {
                return { ok: false, message: 'Workspace root does not exist.' };
            }
            return { ok: true, skills: listWorkspaceSkills(workspaceRoot) };
        },
    };
}
export function createFsSkillDirectoryReader() {
    return {
        async read(absoluteDir) {
            let entries;
            try {
                entries = await readdir(absoluteDir);
            }
            catch (error) {
                // Only "never created" is normal. A permission error, or a file sitting
                // where the directory should be (ENOTDIR), is a fault the surface must
                // name rather than render as "no skills".
                if (error.code === 'ENOENT') {
                    return { ok: false, reason: 'missing', message: 'No skills directory here yet.' };
                }
                return { ok: false, reason: 'unreadable', message: formatFsError(error) };
            }
            const skills = [];
            for (const entry of entries) {
                const skillDir = join(absoluteDir, entry);
                try {
                    // stat, not the readdir dirent: a skill directory reached through a
                    // symlink is a real skill to the CLI reading it.
                    if (!(await stat(skillDir)).isDirectory())
                        continue;
                }
                catch {
                    // A loose file or a dangling symlink in the skills directory is not a
                    // skill to the CLI reading it either, so it is skipped, not reported.
                    continue;
                }
                const frontmatter = await readEntryFrontmatter(skillDir);
                skills.push({
                    id: entry,
                    name: frontmatter.name || entry,
                    description: frontmatter.description,
                    source: await readSkillProvenance(skillDir),
                });
            }
            return { ok: true, skills };
        },
    };
}
export function createAgentCapabilityService(options) {
    return {
        async resolve({ workspaceRoot, pluginId }) {
            const root = workspaceRoot?.trim();
            if (!root || !existsSync(root)) {
                return { ok: false, message: 'Workspace root does not exist.' };
            }
            const plugins = options.listPlugins();
            const binding = buildHarnessMap(plugins).byPlugin.get(pluginId);
            // The two halves are independent declarations: cursor declares an MCP
            // config and no skill integration at all, so a CLI with nothing to read
            // for skills still has servers to answer for.
            const [skills, mcp] = await Promise.all([
                resolveSkills(options, plugins, binding, pluginId, root),
                resolveServers(options, pluginId, root),
            ]);
            return {
                ok: true,
                support: binding?.support ?? 'unsupported',
                harnessId: binding?.harnessId ?? '',
                skills: skills.skills,
                servers: mcp.servers,
                diagnostics: [
                    ...skills.diagnostics,
                    ...mcp.diagnostics,
                    ...(options.freshness?.diagnosticsFor(root, pluginId) ?? []),
                ],
            };
        },
    };
}
async function resolveSkills(options, plugins, binding, pluginId, workspaceRoot) {
    // A CLI that declares no skill integration, one that declares `unsupported`,
    // and one with no workspace install target are all legitimate answers with
    // nothing to read and no path to report as failing.
    if (!binding || binding.support === 'unsupported' || !binding.skillsDir) {
        return { skills: [], diagnostics: [] };
    }
    const integration = plugins.find((plugin) => plugin.id === pluginId)?.skillIntegration;
    const skillsDir = join(workspaceRoot, ...binding.skillsDir.split('/'));
    const read = await options.reader.read(skillsDir);
    if (!read.ok) {
        return {
            skills: [],
            diagnostics: read.reason === 'unreadable'
                ? [{ capability: 'skills', reason: 'unreadable', path: skillsDir, message: read.message }]
                : [],
        };
    }
    return {
        skills: read.skills
            .map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            invocation: resolveSkillInvocation(integration, skill.id) ?? plainSkillInvocation(skill.id),
            source: skill.source,
            pluginIds: binding.pluginIds,
        }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        diagnostics: [],
    };
}
async function resolveServers(options, pluginId, workspaceRoot) {
    const spec = options.lookupManifest(pluginId)?.mcpConfig;
    // No `mcpConfig` block: this CLI reads no MCP config Multicode knows of, which
    // is an answer rather than a fault.
    if (!spec)
        return { servers: [], diagnostics: [] };
    const resolved = await options.mcpResolver.resolve({
        workspaceRoot,
        targets: [{ pluginId, spec }],
    });
    return resolved.get(pluginId) ?? { servers: [], diagnostics: [] };
}
async function readEntryFrontmatter(skillDir) {
    try {
        const raw = await readFile(join(skillDir, SKILL_ENTRY_FILE), 'utf8');
        const frontmatter = parseSkillFrontmatter(raw);
        return { name: frontmatter.name, description: frontmatter.description };
    }
    catch {
        // A skill directory with no readable entry document still exists for the
        // CLI; its directory name is all we can honestly report.
        return { name: '', description: '' };
    }
}
// Provenance comes from the marker the installers write, so a hand-made
// directory reads as `local` rather than being claimed by anything. The marker
// shapes are documented in src/main/skills/install.ts; a copy the attach path
// made of an unmarked local skill carries a third one, which is neither
// built-in nor from a source and so reads as `local` — which is what it is.
async function readSkillProvenance(skillDir) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(join(skillDir, BUILTIN_MANIFEST_FILE), 'utf8'));
    }
    catch {
        return 'local';
    }
    if (typeof parsed !== 'object' || parsed === null)
        return 'local';
    const marker = parsed;
    if (marker.source === 'multicode-builtin')
        return 'builtin';
    if (typeof marker.sourceId === 'string' && marker.sourceId !== '')
        return 'source';
    return 'local';
}
function formatFsError(error) {
    return error instanceof Error ? error.message : String(error);
}
// ---------------------------------------------------------------------------
// Workspace-wide inventory (every harness, no CLI): the picker's fallback when
// no CLI is in play, and the Extensions inventory.
// ---------------------------------------------------------------------------
function listWorkspaceSkills(workspaceRoot) {
    const builtinById = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, skill]));
    const installed = new Map();
    for (const harness of SKILL_PACK_HARNESSES) {
        const skillsDir = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills');
        for (const dirName of listSkillDirs(skillsDir)) {
            const existing = installed.get(dirName);
            if (existing) {
                if (!existing.harnesses.includes(harness))
                    existing.harnesses.push(harness);
                // A later harness copy still refines missing metadata (the first copy
                // may predate frontmatter or be a bare directory).
                if (!existing.description || !existing.name || existing.name === dirName) {
                    const frontmatter = readSkillFrontmatter(join(skillsDir, dirName));
                    if (!existing.description && frontmatter.description)
                        existing.description = frontmatter.description;
                    if ((!existing.name || existing.name === dirName) && frontmatter.name)
                        existing.name = frontmatter.name;
                }
                continue;
            }
            installed.set(dirName, buildInstalledSkill({
                dirName,
                skillDir: join(skillsDir, dirName),
                harness,
                builtin: builtinById.get(dirName),
            }));
        }
    }
    const skills = Array.from(installed.values());
    for (const builtin of BUILTIN_SKILLS) {
        if (installed.has(builtin.id))
            continue;
        skills.push({
            id: builtin.id,
            name: builtin.name,
            description: builtin.description,
            source: 'builtin',
            harnesses: [],
            installState: 'available',
            version: builtin.version,
        });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
}
function buildInstalledSkill(input) {
    const { dirName, skillDir, harness, builtin } = input;
    const frontmatter = readSkillFrontmatter(skillDir);
    const name = frontmatter.name ?? builtin?.name ?? dirName;
    const description = frontmatter.description ?? builtin?.description;
    if (builtin) {
        return {
            id: builtin.id,
            name,
            description,
            source: 'builtin',
            harnesses: [harness],
            installState: builtinInstallState(skillDir, builtin),
            version: builtin.version,
        };
    }
    return {
        id: dirName,
        name,
        description,
        source: 'custom',
        harnesses: [harness],
        installState: 'installed',
    };
}
function builtinInstallState(skillDir, builtin) {
    try {
        const manifest = JSON.parse(readFileSync(join(skillDir, BUILTIN_MANIFEST_FILE), 'utf8'));
        if (typeof manifest.version === 'string' && manifest.version !== builtin.version) {
            return 'update-available';
        }
    }
    catch {
        // Unmanaged or unreadable copy: treat as installed; overwrite safety lives
        // in the builtin skill manager, not the inventory.
    }
    return 'installed';
}
function listSkillDirs(skillsDir) {
    if (!existsSync(skillsDir))
        return [];
    try {
        return readdirSync(skillsDir).filter((name) => {
            try {
                return statSync(join(skillsDir, name)).isDirectory();
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return [];
    }
}
// One frontmatter reader for the whole app (src/shared/skills.ts); this keeps
// the inventory's "absent means fall back to builtin metadata" contract, which
// an empty string would not express.
function readSkillFrontmatter(skillDir) {
    let raw;
    try {
        raw = readFileSync(join(skillDir, SKILL_ENTRY_FILE), 'utf8');
    }
    catch {
        return {};
    }
    const frontmatter = parseSkillFrontmatter(raw);
    return {
        ...(frontmatter.name ? { name: frontmatter.name } : {}),
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
    };
}
