import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, } from '../../../shared/automations/contracts';
import { deriveSprintEngineRepoMergeRollup, isCanceledSprintEngineRun, isCompletedSprintEngineRun, normalizeSprintEngineProjection, } from '../../../shared/sprintengine/state';
import { SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID, } from '../actions/sprint-engine';
export { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND };
// Sprint chaining fires on LANDED (MC-1438, decided): a worktree-backed run has
// landed when every declared project's pull request is merged; a non-worktree
// run's work is already on the checkout branch, so completion IS landed. Both
// legs read the run's projection.json — the sanctioned read surface — through
// the Sprint Engine front doors, and share the canonical completion/cancel
// predicates with the renderer so a run is judged identically everywhere.
// The idempotent `vcs pr-status` refresh talks to GitHub, so a watched team is
// refreshed at most once per this window; between refreshes the poll reads
// whatever merge state the projection already carries (the renderer's own PR
// sweeps also advance it).
const PULL_REQUEST_REFRESH_THROTTLE_MS = 5 * 60_000;
// A non-worktree run is "landed" on completion, but task-completeness is
// transiently true while an architect plans incrementally (task 1 done before
// task 2 exists). The chain is irreversible — a premature fire launches a sprint
// on half-finished work — so a landing must hold across this window before it
// fires; any not-landed observation resets it.
export const LANDED_CONFIRMATION_MS = 2 * 60_000;
const TEAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function createSprintEngineRunLandedTriggerProvider(frontDoors) {
    // Last PR-status refresh per watched run store, provider-lifetime (the registry
    // builds one provider per app session). Keyed by statePath so two automations
    // watching the same team share one throttle window.
    const lastPullRequestRefreshAt = new Map();
    // First observation of the current landing per watched store, for the
    // confirmation window. Provider-lifetime: an app restart re-arms the window,
    // which only delays an event whose id the persisted dedupe already absorbs.
    const landedObservedAt = new Map();
    return {
        kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
        requiredIntegrations: [SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID],
        configSchema: {
            type: 'object',
            required: ['kind', 'team'],
            properties: {
                kind: { const: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND },
                team: { type: 'string', minLength: 1 },
            },
        },
        validateConfig(config) {
            const validation = validateSprintEngineRunLandedTriggerConfig(config);
            return validation.ok ? { ok: true } : validation;
        },
        subscribe(input) {
            const validation = validateSprintEngineRunLandedTriggerConfig(input.config);
            if (!validation.ok)
                throw new Error(validation.error);
            return () => undefined;
        },
        async poll(input) {
            const validation = validateSprintEngineRunLandedTriggerConfig(input.config);
            if (!validation.ok)
                return { ok: false, blockedReason: validation.error };
            const team = validation.value.team;
            const statePath = join(input.workspaceRoot, '.multi-code', 'sprintengine', team, 'run.yaml');
            let state = await readRunState(frontDoors, statePath, team);
            if ('blockedReason' in state)
                return { ok: false, blockedReason: state.blockedReason };
            // A canceled run is decided, not finished — the chain never fires for it.
            if (isCanceledSprintEngineRun(state.value)) {
                landedObservedAt.delete(statePath);
                return { ok: true, events: [] };
            }
            if (!isCompletedSprintEngineRun(state.value)) {
                landedObservedAt.delete(statePath);
                return { ok: true, events: [] };
            }
            if (state.value.vcs?.mode === 'run_worktree') {
                let rollup = deriveSprintEngineRepoMergeRollup(state.value.vcs);
                if (!rollup?.allMerged) {
                    // Complete but not observed merged: ask GitHub (throttled), then re-read.
                    const lastRefreshAt = lastPullRequestRefreshAt.get(statePath) ?? 0;
                    if (input.now() - lastRefreshAt < PULL_REQUEST_REFRESH_THROTTLE_MS) {
                        return { ok: true, events: [] };
                    }
                    lastPullRequestRefreshAt.set(statePath, input.now());
                    const refreshed = await frontDoors.refreshPullRequestStatus({ statePath });
                    if (!refreshed.ok) {
                        // Surface the failure (gh missing/unauthenticated, network down) as a
                        // blocked poll — silently reporting "nothing landed" would leave the
                        // chain never firing with a healthy-looking trigger. The throttle
                        // stamp above still rate-limits retries against a broken gh.
                        return {
                            ok: false,
                            blockedReason: `Sprint run "${team}" pull-request status refresh failed: ${refreshed.message}`,
                        };
                    }
                    state = await readRunState(frontDoors, statePath, team);
                    if ('blockedReason' in state)
                        return { ok: false, blockedReason: state.blockedReason };
                    rollup = deriveSprintEngineRepoMergeRollup(state.value.vcs);
                }
                // Landed = every declared project's branch merged (MC-1613 rollup) — the
                // flat field alone would call a multi-project run landed too early.
                if (!rollup?.allMerged)
                    return { ok: true, events: [] };
            }
            // Confirmation window: only a landing that HOLDS fires (see
            // LANDED_CONFIRMATION_MS). The fingerprint covers the task set, so even a
            // premature fire that slips through cannot burn the true landing's dedupe
            // id — the finished run's larger task graph fingerprints differently.
            const fingerprint = runFingerprint(state.value);
            const observed = landedObservedAt.get(statePath);
            if (!observed || observed.fingerprint !== fingerprint) {
                landedObservedAt.set(statePath, { fingerprint, since: input.now() });
                return { ok: true, events: [] };
            }
            if (input.now() - observed.since < LANDED_CONFIRMATION_MS) {
                return { ok: true, events: [] };
            }
            // Stable per-landing identity: a deleted-and-recreated team dir starts a
            // new event log, so its fingerprint differs and the chain fires again,
            // while re-polls of the same finished run keep deduping on the same id.
            // Deliberate consequence: a run that was ALREADY landed when the automation
            // was created (empty per-automation dedupe) fires once on its first
            // confirmed poll — matching the repo-event trigger's replay-current-state
            // semantics.
            const eventId = `sprint-landed:${team}:${fingerprint}`;
            return {
                ok: true,
                events: [{
                        id: eventId,
                        occurredAt: new Date(input.now()).toISOString(),
                        payload: {
                            kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
                            team,
                            statePath,
                            goal: state.value.goal,
                            name: state.value.name,
                        },
                    }],
            };
        },
    };
}
async function readRunState(frontDoors, statePath, team) {
    const read = await frontDoors.readProjection({ statePath });
    if (!read.ok)
        return { blockedReason: `Sprint run "${team}" is unreadable: ${read.message}` };
    const state = normalizeSprintEngineProjection(read.data, team);
    if (!state)
        return { blockedReason: `Sprint run "${team}" has a malformed projection.` };
    return { value: state };
}
// Identity of the current LANDING in the watched team dir: the run (goal + first
// recorded event, written at creation and never rewritten) plus its task-id set.
// The task set matters — should a transient all-done graph ever fire early, the
// truly finished run has more tasks and therefore a different fingerprint, so a
// premature event can never dedupe-mask the genuine landing.
function runFingerprint(state) {
    const firstEvent = state.events[0];
    const taskIds = state.tasks.map((task) => task.id).sort();
    const hash = createHash('sha256');
    for (const part of [state.goal, firstEvent?.id ?? '', firstEvent?.timestamp ?? '', ...taskIds]) {
        hash.update(part);
        hash.update('\u0000');
    }
    return hash.digest('hex').slice(0, 16);
}
export function validateSprintEngineRunLandedTriggerConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { ok: false, error: 'Sprint-landed trigger config must be an object.' };
    }
    const record = config;
    if (record.kind !== SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND) {
        return { ok: false, error: `Sprint-landed trigger kind must be "${SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND}".` };
    }
    const team = typeof record.team === 'string' ? record.team.trim() : '';
    if (!team || !TEAM_PATTERN.test(team)) {
        return { ok: false, error: 'Sprint-landed trigger team must be a safe sprint team directory name.' };
    }
    return { ok: true, value: { kind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, team } };
}
