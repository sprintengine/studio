import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { MobileSprintEngineCommandError } from './command-error';
import { resolveSprintEngineArtifactFilePath } from './artifact-path';
import { normalizeSprintEngineTasks, } from './task-normalizer';
/**
 * Read the normalized Sprint Engine state used by mobile command readiness
 * checks. The folder-store projection (`projection.json`) is the source of
 * truth. The projection's canonical `workers` view (active leases + live
 * sessions, MC-1591) is read as `sprintEngineAgents` so downstream readers see
 * one shape; the pre-lease `projection.roster` bridge is no longer consulted.
 */
export async function readRawSprintEngineState(state) {
    const projectionPath = join(dirname(state.statePath), 'projection.json');
    try {
        const projectionContent = await readFile(projectionPath, 'utf8');
        const projection = JSON.parse(projectionContent);
        return {
            tasks: Array.isArray(projection.tasks) ? projection.tasks : [],
            artifacts: Array.isArray(projection.artifacts) ? projection.artifacts : [],
            sprintEngineAgents: projection.workers && typeof projection.workers === 'object' && !Array.isArray(projection.workers)
                ? projection.workers
                : {},
        };
    }
    catch (error) {
        throw new MobileSprintEngineCommandError('internal_error', `Sprint projection could not be read from projection.json: ${error instanceof Error ? error.message : String(error)}`, false);
    }
}
export async function findSprintEngineArtifact(state, artifactId) {
    const parsed = await readRawSprintEngineState(state);
    const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
    const artifact = artifacts.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
            return [];
        const record = candidate;
        if (record.id !== artifactId)
            return [];
        return [{
                id: artifactId,
                ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path } : {}),
            }];
    })[0];
    if (!artifact) {
        throw new MobileSprintEngineCommandError('artifact_not_found', 'Requested artifact was not found in the sprint state.', false);
    }
    if (artifact.path) {
        resolveSprintEngineArtifactFilePath(state, artifact.path);
    }
    return artifact;
}
// Returns a task whose role is PROVEN present: the roleless guard below throws
// before any return, so the caller (`task.start`) gets a `string` it can hand to
// the session orchestrator without re-checking.
export async function findReadySprintEngineTask(state, taskId, role) {
    const parsed = await readRawSprintEngineState(state);
    const tasks = normalizeSprintEngineTasks(parsed.tasks);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task was not found in the sprint state.', false);
    }
    // A roleless task (MC-2057) cannot be started by role: `task.start` is
    // "ensure a session for this task's role", and there is no role to ensure one
    // for. Refuse with what is actually true rather than with a role mismatch —
    // and note this task is now REACHED rather than dropped by the normalizer, so
    // the caller no longer gets a misleading "not found".
    const taskRole = task.role;
    if (taskRole === undefined) {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task has no role, so it cannot be started by role.', false);
    }
    if (taskRole !== role) {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task role does not match the mobile command role.', false);
    }
    if (task.ownerAgentId) {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task is already owned by an agent.', false);
    }
    if (task.status !== 'todo') {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Requested task is not ready to start.', false);
    }
    const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    const incompleteDependency = task.dependsOn.find((dependencyId) => tasksById.get(dependencyId)?.status !== 'done');
    if (incompleteDependency) {
        throw new MobileSprintEngineCommandError('task_not_ready', `Requested task is blocked by dependency ${incompleteDependency}.`, false);
    }
    // `taskRole` is the narrowed proof the guard above established; spreading it
    // back on is what lets the return type promise a required `role`.
    return { ...task, role: taskRole };
}
export async function assertKnownActiveSprintEngineAgent(state, agentId) {
    const parsed = await readRawSprintEngineState(state);
    const sprintEngineAgents = parsed.sprintEngineAgents && typeof parsed.sprintEngineAgents === 'object' ? parsed.sprintEngineAgents : {};
    const agent = sprintEngineAgents[agentId];
    if (agent?.status === 'done') {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent is already done.', false);
    }
    if (agent)
        return;
    const ownedTask = normalizeSprintEngineTasks(parsed.tasks).find((task) => task.ownerAgentId === agentId);
    if (!ownedTask || ownedTask.status === 'done') {
        throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent is not active in this sprintengine.', false);
    }
}
