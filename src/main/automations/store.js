import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { translateRetiredAutonomy, withoutWriteUpOnlyMarker } from '../../shared/automations/contracts';
export const AUTOMATIONS_STORE_DIRECTORY = '.multi-code/automations';
export const AUTOMATION_RUN_HISTORY_LIMIT = 50;
const AUTOMATION_STATUSES = new Set(['enabled', 'paused', 'blocked']);
const AUTOMATION_RUN_STATUSES = new Set([
    'queued',
    'running',
    'completed',
    'failed',
    'blocked',
    'skipped',
]);
const SAFE_FILE_ID = /^[A-Za-z0-9._-]+$/;
export class AutomationsStore {
    workspaceRoot;
    options;
    rootPath;
    constructor(workspaceRoot, options = {}) {
        this.workspaceRoot = workspaceRoot;
        this.options = options;
        this.rootPath = join(workspaceRoot, AUTOMATIONS_STORE_DIRECTORY);
    }
    async createDefinition(definition) {
        const target = this.definitionPath(definition.id);
        if (!target.ok)
            return target;
        const validation = this.validateDefinition(definition, target.path);
        if (!validation.ok)
            return validation;
        if (await pathExists(target.path)) {
            return {
                ok: false,
                error: this.problem('already_exists', target.path, `Automation definition "${definition.id}" already exists.`),
            };
        }
        return this.writeDefinition(definition, target.path);
    }
    async updateDefinition(definition) {
        const target = this.definitionPath(definition.id);
        if (!target.ok)
            return target;
        const validation = this.validateDefinition(definition, target.path);
        if (!validation.ok)
            return validation;
        if (!(await pathExists(target.path))) {
            return {
                ok: false,
                error: this.problem('missing', target.path, `Automation definition "${definition.id}" does not exist.`),
            };
        }
        return this.writeDefinition(definition, target.path);
    }
    async deleteDefinition(automationId) {
        const target = this.definitionPath(automationId);
        if (!target.ok)
            return target;
        const runDirectory = this.runsDirectory(automationId);
        if (!runDirectory.ok)
            return runDirectory;
        try {
            await unlink(target.path);
            await rm(runDirectory.path, { recursive: true, force: true });
            return { ok: true };
        }
        catch (error) {
            const code = error?.code;
            return {
                ok: false,
                error: this.problem(code === 'ENOENT' ? 'missing' : 'write_failed', target.path, error instanceof Error ? error.message : `Failed to delete automation definition "${automationId}".`),
            };
        }
    }
    async getDefinition(automationId) {
        const target = this.definitionPath(automationId);
        if (!target.ok)
            return target;
        return this.readDefinitionFile(target.path);
    }
    async listDefinitions() {
        const directory = this.definitionsDirectory();
        const files = await listJsonFiles(directory);
        if (!files.ok) {
            const error = files.errors[0];
            if (error?.code === 'missing')
                return { ok: true, values: [] };
            return { ok: false, errors: [this.problem(error?.code ?? 'read_failed', directory, error?.message ?? 'Failed to read definitions.')] };
        }
        const definitions = [];
        const errors = [];
        for (const fileName of files.values) {
            const result = await this.readDefinitionFile(join(directory, fileName));
            if (result.ok)
                definitions.push(result.value);
            else
                errors.push(result.error);
        }
        if (errors.length > 0)
            return { ok: false, errors };
        return { ok: true, values: definitions.sort((left, right) => left.id.localeCompare(right.id)) };
    }
    async recordRun(run) {
        const definitionTarget = this.definitionPath(run.automationId);
        if (!definitionTarget.ok)
            return definitionTarget;
        const runTarget = this.runPath(run.automationId, run.id);
        if (!runTarget.ok)
            return runTarget;
        const validation = this.validateRun(run, runTarget.path);
        if (!validation.ok)
            return validation;
        const definition = await this.readDefinitionFile(definitionTarget.path);
        if (!definition.ok)
            return { ok: false, error: definition.error };
        const written = await this.writeRun(run, runTarget.path);
        if (!written.ok)
            return written;
        const pruned = await this.pruneRunHistory(run.automationId);
        if (!pruned.ok)
            return { ok: false, error: pruned.error };
        return written;
    }
    async getRun(automationId, runId) {
        const target = this.runPath(automationId, runId);
        if (!target.ok)
            return target;
        return this.readRunFile(target.path);
    }
    async listRuns(automationId) {
        return this.listRunsStrict(automationId);
    }
    async listRunsStrict(automationId) {
        const directoryResult = this.runsDirectory(automationId);
        if (!directoryResult.ok)
            return { ok: false, errors: [directoryResult.error] };
        const directory = directoryResult.path;
        const files = await listJsonFiles(directory);
        if (!files.ok) {
            const error = files.errors[0];
            if (error?.code === 'missing')
                return { ok: true, values: [] };
            return { ok: false, errors: [this.problem(error?.code ?? 'read_failed', directory, error?.message ?? 'Failed to read runs.')] };
        }
        const runs = [];
        const errors = [];
        for (const fileName of files.values) {
            const result = await this.readRunFile(join(directory, fileName));
            if (result.ok)
                runs.push(result.value);
            else
                errors.push(result.error);
        }
        if (errors.length > 0)
            return { ok: false, errors };
        return { ok: true, values: runs.sort(compareRunsNewestFirst) };
    }
    async listReadableRunsForWrite(automationId) {
        const directoryResult = this.runsDirectory(automationId);
        if (!directoryResult.ok)
            return { ok: false, errors: [directoryResult.error] };
        const directory = directoryResult.path;
        const files = await listJsonFiles(directory);
        if (!files.ok) {
            const error = files.errors[0];
            if (error?.code === 'missing')
                return { ok: true, values: [] };
            return { ok: false, errors: [this.problem(error?.code ?? 'read_failed', directory, error?.message ?? 'Failed to read runs.')] };
        }
        const runs = [];
        for (const fileName of files.values) {
            const result = await this.readRunFile(join(directory, fileName));
            if (result.ok)
                runs.push(result.value);
        }
        return { ok: true, values: runs.sort(compareRunsNewestFirst) };
    }
    async readState() {
        const target = this.statePath();
        const parsed = await this.readJson(target);
        if (!parsed.ok) {
            if (parsed.error.code === 'missing')
                return { ok: true, value: null };
            return parsed;
        }
        const validation = this.validateState(parsed.value, target);
        if (!validation.ok)
            return validation;
        const normalized = normalizeStoreState(validation.value);
        const normalizedValidation = this.validateState(normalized, target);
        if (!normalizedValidation.ok)
            return normalizedValidation;
        return { ok: true, value: normalized };
    }
    async writeState(state) {
        const target = this.statePath();
        const validation = this.validateState(state, target);
        if (!validation.ok)
            return validation;
        const written = await this.writeJson(target, state);
        if (!written.ok)
            return written;
        return { ok: true, value: state };
    }
    definitionsDirectory() {
        return join(this.rootPath, 'definitions');
    }
    runsRootDirectory() {
        return join(this.rootPath, 'runs');
    }
    runsDirectory(automationId) {
        const safeId = this.safeId(automationId);
        if (!safeId.ok)
            return safeId;
        return this.containedPath(this.runsRootDirectory(), automationId);
    }
    statePath() {
        return join(this.rootPath, 'state.json');
    }
    definitionPath(automationId) {
        const safeId = this.safeId(automationId);
        if (!safeId.ok)
            return safeId;
        return this.containedPath(this.definitionsDirectory(), `${automationId}.json`);
    }
    runPath(automationId, runId) {
        const safeAutomationId = this.safeId(automationId);
        if (!safeAutomationId.ok)
            return safeAutomationId;
        const safeRunId = this.safeId(runId);
        if (!safeRunId.ok)
            return safeRunId;
        const directory = this.runsDirectory(automationId);
        if (!directory.ok)
            return directory;
        return this.containedPath(directory.path, `${runId}.json`);
    }
    safeId(id) {
        if (SAFE_FILE_ID.test(id) && id !== '.' && id !== '..')
            return { ok: true };
        return {
            ok: false,
            error: {
                code: 'invalid_id',
                path: AUTOMATIONS_STORE_DIRECTORY,
                message: 'Automation store ids must be non-empty file names containing only letters, numbers, dot, underscore, or hyphen, and cannot be dot segments.',
            },
        };
    }
    containedPath(directory, childName) {
        const parent = resolve(directory);
        const target = resolve(directory, childName);
        const relativePath = relative(parent, target);
        if (relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
            return { ok: true, path: target };
        }
        return {
            ok: false,
            error: this.problem('invalid_id', target, 'Automation store id resolves outside its expected directory.'),
        };
    }
    // The one place a definition reaches disk, and so the one place the read-time
    // legacy marker is stripped — including from the value handed back, because
    // once the record is rewritten the legacy key is gone from the file too.
    async writeDefinition(definition, path) {
        const persisted = withoutWriteUpOnlyMarker(definition);
        const written = await this.writeJson(path, persisted);
        if (!written.ok)
            return written;
        return { ok: true, value: persisted };
    }
    async writeRun(run, path) {
        const written = await this.writeJson(path, run);
        if (!written.ok)
            return written;
        return { ok: true, value: run };
    }
    async writeJson(path, value) {
        try {
            await atomicWriteJson(path, value);
            return { ok: true, value };
        }
        catch (error) {
            return {
                ok: false,
                error: this.problem('write_failed', path, error instanceof Error ? error.message : 'Failed to write automations store file.'),
            };
        }
    }
    async readDefinitionFile(path) {
        const parsed = await this.readJson(path);
        if (!parsed.ok)
            return parsed;
        const validated = this.validateDefinition(parsed.value, path);
        if (!validated.ok)
            return validated;
        return { ok: true, value: translateRetiredAutonomy(validated.value) };
    }
    async readRunFile(path) {
        const parsed = await this.readJson(path);
        if (!parsed.ok)
            return parsed;
        return this.validateRun(parsed.value, path);
    }
    async readJson(path) {
        let raw;
        try {
            raw = await readFile(path, 'utf8');
        }
        catch (error) {
            const code = error?.code;
            return {
                ok: false,
                error: this.problem(code === 'ENOENT' ? 'missing' : 'read_failed', path, error instanceof Error ? error.message : 'Failed to read automations store file.'),
            };
        }
        try {
            return { ok: true, value: JSON.parse(raw) };
        }
        catch (error) {
            return {
                ok: false,
                error: this.problem('invalid_json', path, error instanceof Error ? `Automations store file is not valid JSON: ${error.message}` : 'Automations store file is not valid JSON.'),
            };
        }
    }
    validateDefinition(value, path) {
        if (isAutomationDefinition(value))
            return { ok: true, value };
        return { ok: false, error: this.problem('invalid_payload', path, 'Automation definition payload is malformed.') };
    }
    validateRun(value, path) {
        if (isAutomationRun(value))
            return { ok: true, value };
        return { ok: false, error: this.problem('invalid_payload', path, 'Automation run payload is malformed.') };
    }
    validateState(value, path) {
        if (!isAutomationStoreState(value)) {
            return { ok: false, error: this.problem('invalid_payload', path, 'Automation state payload is malformed.') };
        }
        for (const automationId of Object.keys(value.nextRunAtByAutomationId)) {
            const safeId = this.safeId(automationId);
            if (!safeId.ok) {
                return { ok: false, error: this.problem('invalid_payload', path, `Automation state contains invalid id "${automationId}".`) };
            }
        }
        for (const automationId of Object.keys(value.triggerEventDedupByAutomationId ?? {})) {
            const safeId = this.safeId(automationId);
            if (!safeId.ok) {
                return { ok: false, error: this.problem('invalid_payload', path, `Automation trigger-event state contains invalid id "${automationId}".`) };
            }
        }
        for (const automationId of Object.keys(value.triggerBlockedReasonByAutomationId ?? {})) {
            const safeId = this.safeId(automationId);
            if (!safeId.ok) {
                return { ok: false, error: this.problem('invalid_payload', path, `Automation trigger-blocked state contains invalid id "${automationId}".`) };
            }
        }
        return { ok: true, value };
    }
    async pruneRunHistory(automationId) {
        const runs = await this.listReadableRunsForWrite(automationId);
        if (!runs.ok)
            return { ok: false, error: aggregateProblems(runs.errors) };
        const limit = this.options.runHistoryLimit ?? AUTOMATION_RUN_HISTORY_LIMIT;
        if (runs.values.length <= limit)
            return { ok: true };
        for (const staleRun of runs.values.slice(limit)) {
            const target = this.runPath(staleRun.automationId, staleRun.id);
            if (!target.ok)
                return target;
            try {
                await unlink(target.path);
            }
            catch (error) {
                return {
                    ok: false,
                    error: this.problem('write_failed', target.path, error instanceof Error ? error.message : `Failed to prune stale automation run "${staleRun.id}".`),
                };
            }
        }
        return { ok: true };
    }
    problem(code, path, message) {
        return { code, path: this.projectRelativePath(path), message };
    }
    projectRelativePath(path) {
        return relative(this.workspaceRoot, path).split(/[\\/]/).join('/') || basename(path);
    }
}
async function atomicWriteJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function pathExists(path) {
    try {
        await access(path, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function listJsonFiles(directory) {
    let entries;
    try {
        entries = await readdir(directory);
    }
    catch (error) {
        const code = error?.code;
        return {
            ok: false,
            errors: [
                {
                    code: code === 'ENOENT' ? 'missing' : 'read_failed',
                    path: directory,
                    message: error instanceof Error ? error.message : 'Failed to read automations store directory.',
                },
            ],
        };
    }
    return { ok: true, values: entries.filter((entry) => entry.endsWith('.json')).sort() };
}
function aggregateProblems(errors) {
    if (errors.length === 1)
        return errors[0];
    return {
        code: 'invalid_payload',
        path: AUTOMATIONS_STORE_DIRECTORY,
        message: `${errors.length} automations store files are malformed or unreadable.`,
    };
}
function isAutomationDefinition(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.id === 'string'
        && typeof value.name === 'string'
        && isAutomationStatus(value.status)
        && isKindConfig(value.trigger)
        && (value.condition === undefined || isKindConfig(value.condition))
        && isKindConfig(value.action)
        && isOptionalString(value.ownerModuleId)
        && isNullableString(value.nextRunAt)
        && isNullableString(value.lastRunAt)
        && isNullableString(value.lastRunId)
        && typeof value.createdAt === 'string'
        && typeof value.updatedAt === 'string');
}
function isAutomationRun(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.id === 'string'
        && typeof value.automationId === 'string'
        && isAutomationRunStatus(value.status)
        && typeof value.dueAt === 'string'
        && isNullableString(value.startedAt)
        && isNullableString(value.completedAt)
        && isOptionalString(value.blockedReason)
        && isOptionalString(value.workspaceId)
        && isOptionalString(value.agentId)
        && isOptionalString(value.executionId)
        && isOptionalString(value.promptFingerprint)
        && isOptionalStringArray(value.touchedFiles)
        && isOptionalStringArray(value.commandsRan)
        && isOptionalString(value.summary));
}
function isAutomationStoreState(value) {
    return (isRecord(value)
        && isNextRunAtCache(value.nextRunAtByAutomationId)
        && (value.triggerEventDedupByAutomationId === undefined
            || isTriggerEventDedupCache(value.triggerEventDedupByAutomationId))
        && (value.triggerBlockedReasonByAutomationId === undefined
            || isTriggerBlockedReasonCache(value.triggerBlockedReasonByAutomationId))
        && (value.lock === null || isAutomationStoreLock(value.lock)));
}
function isNextRunAtCache(value) {
    return isRecord(value) && Object.values(value).every((entry) => isNullableString(entry));
}
function isTriggerEventDedupCache(value) {
    return (isRecord(value)
        && Object.values(value).every((entry) => isRecord(entry) && Object.values(entry).every((seenAt) => typeof seenAt === 'string')));
}
function isTriggerBlockedReasonCache(value) {
    return isRecord(value) && Object.values(value).every((entry) => isNullableString(entry));
}
function normalizeStoreState(value) {
    const legacyRepoEventDedup = value.repoEventDedupByAutomationId;
    if (!isTriggerEventDedupCache(legacyRepoEventDedup))
        return value;
    const mergedTriggerEventDedupByAutomationId = {};
    for (const [automationId, events] of Object.entries(legacyRepoEventDedup)) {
        mergedTriggerEventDedupByAutomationId[automationId] = { ...events };
    }
    for (const [automationId, events] of Object.entries(value.triggerEventDedupByAutomationId ?? {})) {
        mergedTriggerEventDedupByAutomationId[automationId] = {
            ...mergedTriggerEventDedupByAutomationId[automationId],
            ...events,
        };
    }
    return {
        nextRunAtByAutomationId: value.nextRunAtByAutomationId,
        triggerEventDedupByAutomationId: mergedTriggerEventDedupByAutomationId,
        triggerBlockedReasonByAutomationId: value.triggerBlockedReasonByAutomationId,
        lock: value.lock,
    };
}
function isAutomationStoreLock(value) {
    return (isRecord(value)
        && typeof value.ownerId === 'string'
        && typeof value.acquiredAt === 'string'
        && typeof value.expiresAt === 'string');
}
function isKindConfig(value) {
    return isRecord(value) && typeof value.kind === 'string' && Object.hasOwn(value, 'config');
}
function isAutomationStatus(value) {
    return typeof value === 'string' && AUTOMATION_STATUSES.has(value);
}
function isAutomationRunStatus(value) {
    return typeof value === 'string' && AUTOMATION_RUN_STATUSES.has(value);
}
function isNullableString(value) {
    return typeof value === 'string' || value === null;
}
function isOptionalString(value) {
    return value === undefined || typeof value === 'string';
}
function isOptionalStringArray(value) {
    return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function compareRunsNewestFirst(left, right) {
    const timeDelta = runTimestamp(right) - runTimestamp(left);
    if (timeDelta !== 0)
        return timeDelta;
    return right.id.localeCompare(left.id);
}
function runTimestamp(run) {
    const parsed = Date.parse(run.completedAt ?? run.startedAt ?? run.dueAt);
    return Number.isFinite(parsed) ? parsed : 0;
}
