import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { emptySprintEngineTokenTotals, mergeModelUsageInto, reduceModelUsageTotals, } from '../../shared/sprintengine-token-usage';
import { readTokenLedger } from './ledger';
import { readSessionTokenUsage } from './read-session';
export async function computeSprintEngineTokenUsageReport(statePath, deps = {}) {
    const readUsage = deps.readUsage ?? readSessionTokenUsage;
    const computedAt = (deps.now ?? defaultNow)();
    const [ledgerSessions, projection] = await Promise.all([
        readTokenLedger(statePath),
        readProjection(statePath),
    ]);
    // ── Per-agent: merge each agent's sessions; sessions read concurrently ──
    const resolved = await Promise.all(ledgerSessions.map(async (session) => ({
        session,
        usage: await resolveSessionUsage(session, readUsage, deps),
    })));
    const agents = new Map();
    for (const { session, usage } of resolved) {
        const agent = agents.get(session.agentId) ?? {
            role: session.role,
            cli: session.cli || 'unknown',
            measured: false,
            perModel: new Map(),
        };
        if (session.role && !agent.role)
            agent.role = session.role;
        if (usage) {
            agent.measured = true;
            mergeModelUsageInto(agent.perModel, usage);
        }
        agents.set(session.agentId, agent);
    }
    // Roster agents with no ledgered session still count toward coverage: they
    // did run (they are on the roster) but nothing measurable was recorded.
    for (const entry of projection.roster) {
        if (agents.has(entry.agentId))
            continue;
        agents.set(entry.agentId, {
            role: entry.role,
            cli: cliForRosterAgent(entry, projection.tasks),
            measured: false,
            perModel: new Map(),
        });
    }
    // One taskId <-> agentId ownership relation, built once: a task's owners are
    // every id that ever owned it; an agent's task set is the inverse.
    const ownersByTask = buildOwnersByTask(projection);
    const taskIdsByAgent = new Map();
    for (const [taskId, owners] of ownersByTask) {
        for (const agentId of owners) {
            const list = taskIdsByAgent.get(agentId) ?? [];
            list.push(taskId);
            taskIdsByAgent.set(agentId, list);
        }
    }
    const perAgent = [...agents.entries()].map(([agentId, agent]) => {
        const perModel = [...agent.perModel.values()];
        return {
            agentId,
            role: agent.role ?? projection.rosterByAgentId.get(agentId)?.role,
            cli: agent.cli,
            taskIds: taskIdsByAgent.get(agentId) ?? [],
            measured: agent.measured,
            perModel,
            total: reduceModelUsageTotals(perModel),
        };
    });
    const agentByAgentId = new Map(perAgent.map((agent) => [agent.agentId, agent]));
    // ── Per-task: the owning agents' summed usage, only while exactly splittable ──
    const perTask = {};
    for (const task of projection.tasks) {
        const primaryAgentId = task.lastImplementedByAgentId ?? task.ownerAgentId ?? ownersByTask.get(task.id)?.[0] ?? null;
        const owners = (ownersByTask.get(task.id) ?? [])
            .map((agentId) => agentByAgentId.get(agentId))
            .filter((agent) => Boolean(agent));
        const ownerOwnsMultipleTasks = owners.some((agent) => agent.taskIds.length > 1);
        const allMeasured = owners.length > 0 && owners.every((agent) => agent.measured);
        if (!allMeasured || ownerOwnsMultipleTasks) {
            perTask[task.id] = {
                taskId: task.id,
                agentId: primaryAgentId,
                measured: false,
                perModel: [],
                total: emptySprintEngineTokenTotals(),
                ...(ownerOwnsMultipleTasks ? { ownerOwnsMultipleTasks: true } : {}),
            };
            continue;
        }
        const perModel = new Map();
        for (const owner of owners)
            mergeModelUsageInto(perModel, owner.perModel);
        const rows = [...perModel.values()];
        perTask[task.id] = {
            taskId: task.id,
            agentId: primaryAgentId,
            measured: true,
            perModel: rows,
            total: reduceModelUsageTotals(rows),
        };
    }
    // ── Run total + coverage ──
    const runPerModel = new Map();
    let measuredAgents = 0;
    const unmeasured = [];
    for (const agent of perAgent) {
        if (agent.measured) {
            measuredAgents += 1;
            mergeModelUsageInto(runPerModel, agent.perModel);
        }
        else {
            unmeasured.push({ agentId: agent.agentId, cli: agent.cli });
        }
    }
    const runRows = [...runPerModel.values()];
    return {
        run: {
            perModel: runRows,
            total: reduceModelUsageTotals(runRows),
            coverage: { measuredAgents, unmeasuredAgents: unmeasured.length, unmeasured },
        },
        perAgent,
        perTask,
        computedAt,
    };
}
// Richer truthful source for one session: the live adapter read and the
// durable sample snapshot the same cumulative counter, so whichever carries
// more tokens is the more complete truth. A live read of a partially-pruned
// transcript (measured but shrunken) must not beat a fuller teardown sample.
async function resolveSessionUsage(session, readUsage, deps) {
    const live = await readUsage(session.cli, session.cliSessionId, deps);
    const sample = session.lastSample?.measured ? session.lastSample.perModel : null;
    if (!live.measured)
        return sample;
    if (!sample)
        return live.perModel;
    return completeness(live.perModel) >= completeness(sample) ? live.perModel : sample;
}
// How much of the cumulative counter a snapshot carries. Every component, cache
// reads included — this is "which read saw more of the session", not the
// reported total (which excludes reads), and a snapshot that saw more turns
// must win even when the extra turns were all cache hits.
function completeness(rows) {
    const totals = reduceModelUsageTotals(rows);
    return totals.total + totals.cacheRead;
}
// Every agent id that ever owned each task: the task record's implementer /
// live owner plus the roster's durable ownedTaskIds sets. Order is stable
// (task fields first, then roster order) so the primary owner is deterministic.
function buildOwnersByTask(projection) {
    const owners = new Map();
    const add = (taskId, agentId) => {
        if (!agentId)
            return;
        const list = owners.get(taskId) ?? [];
        if (!list.includes(agentId))
            list.push(agentId);
        owners.set(taskId, list);
    };
    for (const task of projection.tasks) {
        add(task.id, task.lastImplementedByAgentId);
        add(task.id, task.ownerAgentId);
    }
    for (const entry of projection.roster) {
        for (const taskId of entry.ownedTaskIds)
            add(taskId, entry.agentId);
    }
    return owners;
}
// Best-effort CLI label for a roster agent with no ledgered session: the CLI
// stamped on its owned task (item 1448), else unknown.
function cliForRosterAgent(entry, tasks) {
    for (const task of tasks) {
        if (task.cli && entry.ownedTaskIds.includes(task.id))
            return task.cli;
    }
    return 'unknown';
}
async function readProjection(statePath) {
    const empty = { tasks: [], roster: [], rosterByAgentId: new Map() };
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path.join(path.dirname(statePath), 'projection.json'), 'utf8'));
    }
    catch {
        return empty; // no projection / unreadable -> ledger-only report
    }
    if (!parsed || typeof parsed !== 'object')
        return empty;
    const record = parsed;
    const tasks = Array.isArray(record.tasks)
        ? record.tasks.flatMap((task) => {
            if (!task || typeof task !== 'object')
                return [];
            const row = task;
            const id = typeof row.id === 'string' ? row.id : '';
            if (!id)
                return [];
            return [
                {
                    id,
                    ownerAgentId: typeof row.ownerAgentId === 'string' && row.ownerAgentId ? row.ownerAgentId : null,
                    lastImplementedByAgentId: typeof row.lastImplementedByAgentId === 'string' && row.lastImplementedByAgentId
                        ? row.lastImplementedByAgentId
                        : null,
                    cli: typeof row.cli === 'string' && row.cli ? row.cli : null,
                },
            ];
        })
        : [];
    const roster = [];
    if (record.roster && typeof record.roster === 'object' && !Array.isArray(record.roster)) {
        for (const [agentId, value] of Object.entries(record.roster)) {
            if (!agentId || !value || typeof value !== 'object')
                continue;
            const entry = value;
            roster.push({
                agentId,
                role: typeof entry.role === 'string' && entry.role ? entry.role : undefined,
                ownedTaskIds: Array.isArray(entry.ownedTaskIds)
                    ? entry.ownedTaskIds.filter((id) => typeof id === 'string' && id.length > 0)
                    : [],
            });
        }
    }
    return { tasks, roster, rosterByAgentId: new Map(roster.map((entry) => [entry.agentId, entry])) };
}
function defaultNow() {
    return new Date().toISOString();
}
