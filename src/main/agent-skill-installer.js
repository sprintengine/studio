// Attaching a skill: making one skill exist in every workspace directory an
// installed, skill-capable CLI reads — and removing it only from the copies
// Multicode wrote.
//
// The fan-out is derived, never listed. The harness map turns the plugin
// manifests into the distinct directories they declare, which today is four
// covering six CLIs, because claude-code, kimi-claude and zai all read
// `.claude/skills`. A thirteenth CLI declaring a new harness receives its copy
// with no edit here.
//
// Only CLIs actually installed on this machine get a directory: a copy nothing
// on this machine can read is not an install, and a user without OpenCode
// should not find an `.opencode/` in their repository.
//
// FORMAT, settled here so nobody re-derives it. Install targets declare a
// `format` — `claude-code`, `codex`, `opencode`, `agent-skills-v1`, `generic`.
// On disk they are the same layout: a directory whose entry document is
// `SKILL.md` with YAML frontmatter, plus whatever files the skill ships. The
// three the bundled manifests actually use (`claude-code` for .claude and
// .grok, `codex`, `opencode`) were each read by their own CLI from a
// byte-identical directory while building this. `format` is a routing label,
// not a conversion, so there is one writer instead of a per-format adapter. A
// format that genuinely differs on disk is the moment to add one, mirroring the
// MCP reader registry in src/main/mcp-config-readers/.
import { existsSync } from 'fs';
import { readFile, rm, stat, writeFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { buildHarnessMap } from '../shared/harness-map';
import { builtinSkillSourceRoot, copySkillDirectory, findBuiltinSkill, hashSkillDirectory, MANAGED_SKILL_MANIFEST_FILE, writeManagedSkillManifest, } from './builtin-skills';
import { detectAgentCliAvailability } from './cli-availability';
import { listPluginRegistryEntries } from './plugin-registry-instance';
/**
 * Marker source for a copy this installer made of a skill that carried no
 * provenance of its own — a directory the user hand-authored in one harness and
 * then attached to the rest. Its own copies are Multicode's to remove; the
 * hand-authored original is not, and stays unmarked.
 *
 * Third shape of `.multicode-skill.json`, alongside the built-in manifest
 * (src/main/builtin-skills.ts) and the source-install marker
 * (src/main/skills/install.ts). One filename for "Multicode put this here";
 * each reader recognises only its own shape.
 */
const ATTACHED_MARKER_SOURCE = 'multicode-attach';
const NO_TARGET_MESSAGE = 'No agent CLI on this machine reads workspace skills.';
export function createFsSkillCopyIo() {
    return {
        async inspect(dir) {
            try {
                await stat(dir);
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    return { exists: false, managed: false, contentHash: '' };
                }
                throw error;
            }
            return {
                exists: true,
                managed: await isManagedCopy(dir),
                // Ignores the marker for the same reason the built-in status reader
                // does: it is written after the copy, so including it would make every
                // copy differ from its source.
                contentHash: await hashSkillDirectory(dir, new Set([MANAGED_SKILL_MANIFEST_FILE])),
            };
        },
        async write({ sourceDir, destinationDir, marker }) {
            await copySkillDirectory(sourceDir, destinationDir);
            if (marker?.kind === 'builtin') {
                await writeManagedSkillManifest({
                    destinationDir,
                    skill: marker.skill,
                    sourceHash: marker.sourceHash,
                });
                return;
            }
            if (marker?.kind === 'attached') {
                await writeFile(join(destinationDir, MANAGED_SKILL_MANIFEST_FILE), `${JSON.stringify({
                    id: marker.skillId,
                    source: ATTACHED_MARKER_SOURCE,
                    copiedFrom: marker.copiedFrom,
                    installedAt: new Date().toISOString(),
                }, null, 2)}\n`, 'utf-8');
            }
        },
        async remove(dir) {
            await rm(dir, { recursive: true, force: true });
        },
    };
}
export function createAgentSkillInstaller(options = {}) {
    const listPlugins = options.listPlugins ?? listPluginRegistryEntries;
    // Probed without the renderer's per-CLI command overrides, exactly as the
    // marketplace install path does: a CLI on a custom command may probe absent
    // and only miss its copy.
    const detectAvailability = options.detectAvailability ?? (() => detectAgentCliAvailability());
    const builtinSourceRoot = options.builtinSourceRoot ?? builtinSkillSourceRoot;
    const io = options.io ?? createFsSkillCopyIo();
    const invalidate = options.invalidate ?? (() => { });
    return {
        async attach({ workspaceRoot, skillId }) {
            const request = validate(workspaceRoot, skillId);
            if (!request.ok)
                return request;
            const builtin = findBuiltinSkill(skillId);
            const availability = await detectAvailability();
            const declared = harnessTargets(listPlugins(), request.root, skillId);
            const targets = declared
                .map((target) => ({
                ...target,
                // Attribution, not filtering by count: `.claude` is reported for
                // whichever of claude-code, kimi-claude and zai this machine has.
                pluginIds: target.pluginIds.filter((pluginId) => availability[pluginId]?.installed === true),
            }))
                .filter((target) => target.pluginIds.length > 0 && allowsHarness(builtin, target.harnessId));
            if (targets.length === 0)
                return { ok: false, message: NO_TARGET_MESSAGE };
            // Where the bytes may be *read* from is every declared harness, not only
            // the ones being written: a skill sitting in the directory of a CLI the
            // user has since uninstalled is still the copy to spread.
            const origin = await resolveOrigin({ io, builtin, builtinSourceRoot, targets: declared, skillId });
            if (!origin) {
                return {
                    ok: false,
                    message: `Nothing to attach: ${skillId} is not a built-in skill and is not installed in this workspace.`,
                };
            }
            const outcomes = [];
            const changed = new Set();
            for (const target of targets) {
                const outcome = await attachOne({ io, target, origin, skillId });
                if (outcome.status === 'written')
                    changed.add(target.harnessId);
                outcomes.push(outcome);
            }
            for (const harnessId of changed)
                invalidate(request.root, harnessId);
            return { ok: true, skillId, targets: outcomes };
        },
        async remove({ workspaceRoot, skillId }) {
            const request = validate(workspaceRoot, skillId);
            if (!request.ok)
                return request;
            // Every declared harness, not only the installed ones: a copy written
            // before the user uninstalled that CLI is still Multicode's to clean up,
            // and the provenance check below is what makes reaching wider safe.
            const targets = harnessTargets(listPlugins(), request.root, skillId);
            if (targets.length === 0)
                return { ok: false, message: NO_TARGET_MESSAGE };
            const outcomes = [];
            const changed = new Set();
            for (const target of targets) {
                const base = describe(target);
                try {
                    const existing = await io.inspect(target.absoluteDir);
                    if (!existing.exists) {
                        outcomes.push({ ...base, status: 'skipped', reason: 'absent' });
                        continue;
                    }
                    if (!existing.managed) {
                        outcomes.push({ ...base, status: 'skipped', reason: 'not-ours' });
                        continue;
                    }
                    await io.remove(target.absoluteDir);
                    changed.add(target.harnessId);
                    outcomes.push({ ...base, status: 'removed' });
                }
                catch (error) {
                    outcomes.push({ ...base, status: 'failed', message: formatError(error) });
                }
            }
            for (const harnessId of changed)
                invalidate(request.root, harnessId);
            return { ok: true, skillId, targets: outcomes };
        },
    };
}
function validate(workspaceRoot, skillId) {
    const root = workspaceRoot?.trim();
    if (!root || !existsSync(root))
        return { ok: false, message: 'Workspace root does not exist.' };
    // A skill id is a directory name in someone's repository, so it is checked
    // rather than trusted: a `../` in it would resolve outside the harness dir.
    // A leading dot is refused with it — a hidden directory is not a skill any
    // CLI lists, and `.` and `..` are the traversal this is guarding.
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(skillId)) {
        return { ok: false, message: `"${skillId}" is not a usable skill directory name.` };
    }
    return { ok: true, root: resolve(root) };
}
function harnessTargets(plugins, workspaceRoot, skillId) {
    const targets = [];
    for (const binding of buildHarnessMap(plugins).byHarness.values()) {
        // A harness every bound CLI declares unsupported reads no skills, and one
        // with no workspace install target declares nowhere to put them.
        if (binding.support !== 'native' || !binding.skillsDir)
            continue;
        const absoluteDir = resolve(workspaceRoot, ...binding.skillsDir.split('/'), skillId);
        if (!isInside(workspaceRoot, absoluteDir))
            continue;
        targets.push({
            harnessId: binding.harnessId,
            pluginIds: [...binding.pluginIds],
            path: `${binding.skillsDir}/${skillId}`,
            absoluteDir,
            restartRequired: binding.restartRequired,
        });
    }
    return targets;
}
/**
 * A built-in that names its harnesses is restricting where it may go, not
 * describing where it happens to be: `use-codex` must never land in
 * `.codex/skills` — it would tell Codex to delegate to itself — and
 * `frontend-design` is Claude-only. `targetPolicy: 'all-native'` and an
 * undeclared list both mean every skill-capable harness.
 */
function allowsHarness(builtin, harnessId) {
    if (!builtin?.harnesses?.length)
        return true;
    return builtin.harnesses.includes(harnessId);
}
/**
 * The bytes to copy: what Multicode ships for a built-in, otherwise the first
 * harness that already holds the skill — which is how a skill installed from a
 * source, or written by hand in one CLI, reaches the others.
 */
async function resolveOrigin(input) {
    const { io, builtin, skillId } = input;
    if (builtin) {
        const dir = join(input.builtinSourceRoot(), skillId);
        const bundled = await io.inspect(dir).catch(() => null);
        if (bundled?.exists) {
            return { dir, path: dir, contentHash: bundled.contentHash, builtin, managed: false };
        }
    }
    for (const target of input.targets) {
        const existing = await io.inspect(target.absoluteDir).catch(() => null);
        if (!existing?.exists)
            continue;
        return {
            dir: target.absoluteDir,
            path: target.path,
            contentHash: existing.contentHash,
            builtin: null,
            managed: existing.managed,
        };
    }
    return null;
}
async function attachOne(input) {
    const { io, target, origin, skillId } = input;
    const base = describe(target);
    // The harness the bytes came from is already correct, and copying a
    // directory onto itself would delete it first.
    if (target.absoluteDir === origin.dir)
        return { ...base, status: 'unchanged' };
    let writing = false;
    try {
        const existing = await io.inspect(target.absoluteDir);
        // Someone else's bytes under a name we happen to want. Reported, never
        // overwritten: a hand-authored skill is not ours to replace.
        if (existing.exists && !existing.managed)
            return { ...base, status: 'skipped', reason: 'not-ours' };
        if (existing.exists && existing.contentHash === origin.contentHash) {
            return { ...base, status: 'unchanged' };
        }
        writing = true;
        await io.write({
            sourceDir: origin.dir,
            destinationDir: target.absoluteDir,
            marker: originMarker(origin, skillId),
        });
        return { ...base, status: 'written' };
    }
    catch (error) {
        // A write that died part-way leaves a directory with no marker, which the
        // check above would read as the user's and refuse to touch ever again —
        // the failure would be permanent. The half-copy is ours, so it goes. Only
        // after a write actually started: an unreadable directory we never touched
        // is somebody else's, whatever the error was.
        if (writing)
            await io.remove(target.absoluteDir).catch(() => { });
        return { ...base, status: 'failed', message: formatError(error) };
    }
}
function originMarker(origin, skillId) {
    if (origin.builtin) {
        return { kind: 'builtin', skill: origin.builtin, sourceHash: origin.contentHash };
    }
    // A copy that already carries provenance passes it on with the bytes; one
    // that carries none would otherwise be indistinguishable from a directory the
    // user wrote, and could never be removed again.
    return origin.managed ? undefined : { kind: 'attached', skillId, copiedFrom: origin.path };
}
function describe(target) {
    return {
        harnessId: target.harnessId,
        pluginIds: target.pluginIds,
        path: target.path,
        restartRequired: target.restartRequired,
    };
}
async function isManagedCopy(dir) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(join(dir, MANAGED_SKILL_MANIFEST_FILE), 'utf-8'));
    }
    catch {
        // No marker, or one that does not parse: not something Multicode wrote.
        return false;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return false;
    const marker = parsed;
    return (marker.source === 'multicode-builtin'
        || marker.source === ATTACHED_MARKER_SOURCE
        || (typeof marker.sourceId === 'string' && marker.sourceId !== ''));
}
function isInside(parent, child) {
    const rel = relative(parent, child);
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
