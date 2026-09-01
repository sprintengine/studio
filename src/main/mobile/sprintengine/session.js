import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { MobileSprintEngineCommandError, } from './command';
// Bundled-role display labels used for the mobile startup prompt. This map is
// a humanization fallback only — unknown registry-keyed role ids resolve via
// `humanizeMobileSprintEngineRoleId` so custom Sprint Engine roles
// (e.g. `marketer`, `growth-engineer`) get a sensible title-cased label
// instead of indexing this bundled-role table directly.
const bundledSprintEngineRoleLabels = {
    architect: 'Architect',
    product: 'Product Strategist',
    developer: 'Developer',
    frontend: 'Frontend Engineer',
    ui_ux_reviewer: 'UI/UX Reviewer',
    tester: 'Tester',
    security: 'Security Specialist',
    performance: 'Performance Engineer',
    production_readiness_reviewer: 'Production Readiness Reviewer',
};
function mobileSprintEngineRoleLabel(role) {
    const bundled = bundledSprintEngineRoleLabels[role];
    if (bundled)
        return bundled;
    const cleaned = role.trim().replace(/[_-]+/g, ' ').trim();
    if (!cleaned)
        return role;
    return cleaned
        .split(/\s+/u)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ');
}
export class DesktopMobileSprintEngineSessionOrchestrator {
    options;
    maxProcessAliveAgentTerminals;
    now;
    constructor(options) {
        this.options = options;
        this.maxProcessAliveAgentTerminals = Math.max(1, options.maxProcessAliveAgentTerminals ?? 8);
        this.now = options.now ?? (() => new Date());
    }
    async startTask(request) {
        const sessions = await this.options.adapters.listTerminals();
        const processAliveSprintEngineSessions = sessions.filter((session) => session.processAlive
            && session.kind === 'agent'
            && session.sprintEngineStatePath === request.statePath);
        if (processAliveSprintEngineSessions.length >= this.maxProcessAliveAgentTerminals) {
            throw new MobileSprintEngineCommandError('task_not_ready', 'Desktop has reached the live sprint terminal limit.', true);
        }
        const state = await readMobileSprintEngineProjection(request.teamDirectory);
        // Fresh worker id per task start (a display label — the engine binds it to
        // the task at claim). Never reuse a recent worker's id: fresh-session-per-
        // leased-task is the pool default and keeps per-task token attribution
        // honest (MC-1592/MC-1594).
        const agentId = mintWorkerId(state, request.role, processAliveSprintEngineSessions);
        const executionCwd = request.workspaceRoot;
        const executionMode = 'current_workspace';
        const sessionId = randomUUID();
        const spawn = await this.options.adapters.spawnAgentTerminal({
            sessionId,
            cwd: executionCwd,
            sprintEngineStatePath: request.statePath,
            agentId,
            role: request.role,
            cli: 'codex',
            initialPrompt: buildStartupPrompt({
                role: request.role,
                agentId,
                taskId: request.taskId,
                label: mobileSprintEngineRoleLabel(request.role),
                goal: state.goal,
                workspaceRoot: request.workspaceRoot,
                executionCwd,
                statePath: request.statePath,
            }),
            executionMode,
        });
        if (!spawn.ok) {
            throw new MobileSprintEngineCommandError('desktop_unavailable', spawn.message, true);
        }
        return {
            sessionId: spawn.sessionId,
            agentId,
            executionMode,
        };
    }
    async sendFollowUp(request) {
        const text = normalizeFollowUpTextForTerminal(request.text);
        const sessions = await this.options.adapters.listTerminals();
        const session = sessions.find((candidate) => candidate.processAlive
            && candidate.kind === 'agent'
            && candidate.sprintEngineStatePath === request.statePath
            && candidate.agentId === request.agentId);
        if (!session) {
            throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent does not have a live desktop terminal.', true);
        }
        const message = [
            '',
            `Mobile follow-up from ${request.deviceId}:`,
            text,
            '',
        ].join('\n');
        await this.options.adapters.writeTerminal(session.sessionId, `${message}\r`);
        return {
            sessionId: session.sessionId,
            agentId: request.agentId,
            acceptedAt: this.now().toISOString(),
        };
    }
    async setAutomationMode(request) {
        const apply = this.options.adapters.setSprintEngineAutomationMode;
        if (!apply) {
            // Only reachable when the orchestrator was built without the adapter
            // (test harnesses). Production wiring always provides the main-owned
            // automation write path, so this never rejects for a real device.
            throw new MobileSprintEngineCommandError('command_not_supported', 'Setting the automation mode is not supported by this desktop build.', false);
        }
        const result = await apply({
            sprintEngineId: request.sprintEngineId,
            statePath: request.statePath,
            workspaceRoot: request.workspaceRoot,
            mode: request.mode,
            deviceId: request.deviceId,
        });
        if (!result.ok) {
            throw new MobileSprintEngineCommandError('internal_error', result.message, result.retryable);
        }
        return { mode: request.mode, appliedAt: this.now().toISOString() };
    }
}
function normalizeFollowUpTextForTerminal(value) {
    if (/[\u0000-\u001F\u007F]/u.test(value)) {
        throw new MobileSprintEngineCommandError('invalid_payload', 'Follow-up text must be a single message without terminal control characters.', false);
    }
    const text = value.trim();
    if (!text) {
        throw new MobileSprintEngineCommandError('invalid_payload', 'Follow-up text is required.', false);
    }
    return text;
}
async function readMobileSprintEngineProjection(teamDirectory) {
    // Sprint Engine's canonical UI/MCP read is `projection.json`. The mobile
    // startup prompt only needs the goal string plus the worker ids already in
    // use (the `workers` view, MC-1591 — the pre-lease `roster` bridge is not
    // consulted); anything richer flows through MCP, not run-store internals.
    const projectionPath = join(teamDirectory, 'projection.json');
    let projection;
    try {
        projection = JSON.parse(await readFile(projectionPath, 'utf8'));
    }
    catch (error) {
        throw new MobileSprintEngineCommandError('internal_error', `Sprint projection could not be read from projection.json: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    const run = projection.run && typeof projection.run === 'object' && !Array.isArray(projection.run)
        ? projection.run
        : {};
    const workers = projection.workers && typeof projection.workers === 'object' && !Array.isArray(projection.workers)
        ? projection.workers
        : {};
    return {
        goal: typeof run.goal === 'string' ? run.goal : '',
        workerIds: Object.keys(workers),
    };
}
function mintWorkerId(state, role, processAliveSessions) {
    const usedIds = [
        ...state.workerIds,
        ...processAliveSessions.flatMap((session) => session.agentId ? [session.agentId] : []),
    ];
    return nextAgentId(role, usedIds);
}
function nextAgentId(role, usedIds) {
    if (role !== 'developer' && !usedIds.includes(role))
        return role;
    let nextIndex = 1;
    for (const agentId of usedIds) {
        const index = agentIdSortValue(agentId, role);
        if (Number.isFinite(index))
            nextIndex = Math.max(nextIndex, index + 1);
    }
    let candidate = `${role}-${nextIndex}`;
    while (usedIds.includes(candidate)) {
        nextIndex += 1;
        candidate = `${role}-${nextIndex}`;
    }
    return candidate;
}
function agentIdSortValue(agentId, role) {
    if (agentId === role)
        return 1;
    const match = agentId.match(new RegExp(`^${escapeRegExp(role)}-(\\d+)$`, 'u'));
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
function buildStartupPrompt(input) {
    const joinPayload = JSON.stringify({
        role: input.role,
        agentId: input.agentId,
    }, null, 2);
    // The phone started this session for one specific task, so the claim is
    // hinted at it (`task.claim`) rather than pulling whatever is next; the
    // queue pull stays as the fallback when the tapped task got claimed first.
    const claimPayload = JSON.stringify({
        taskId: input.taskId,
        id: input.agentId,
    }, null, 2);
    const fallbackClaimPayload = JSON.stringify({
        role: input.role,
        id: input.agentId,
    }, null, 2);
    void input.goal;
    void input.workspaceRoot;
    return [
        `${input.label}: ${input.label} - Fetch the canonical Sprint Engine instructions from the managed Sprint Engine MCP server.`,
        `Worker cwd: ${input.executionCwd}`,
        `Shared sprint state: ${input.statePath}`,
        `You are assigned role: ${input.role}. Only claim and work sprint tasks whose role exactly matches ${input.role}, and own each one from claim to done. Sprint work runs through the managed Sprint Engine MCP server in this terminal.`,
        'Register this agent with `sprintengine.agent.join`:',
        ['```json', joinPayload, '```'].join('\n'),
        `This session was started for task ${input.taskId}. Claim it with \`sprintengine.task.claim\`:`,
        ['```json', claimPayload, '```'].join('\n'),
        'If that claim reports the task is not ready (someone claimed it first), fall back to `sprintengine.task.next`:',
        ['```json', fallbackClaimPayload, '```'].join('\n'),
        'The claim returns your task, or your active one to resume. Work what it returns. If it returns no claim, reply that no work was claimed and stop — the caller/runtime owns later continuation. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.',
    ].join('\n\n');
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
