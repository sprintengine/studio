// The roadmap orchestrator's main-process driver: the reconciler that walks the
// single instance roadmap's lanes and drives the shared plan-sourced creation
// flow, merge primitive, and notification channel through real effects. It is the
// sibling of the pool supervisor (`sprint-runtime.ts`) one level up — that
// reconciles agent sessions within one run; this reconciles runs within a roadmap
// lane.
//
// INSTANCE-GLOBAL (MC-1688): there is ONE roadmap per Multicode. It is a normal
// file under a designated HOME PROJECT's `backlog/roadmaps/` (D1); its lane entries
// may reference backlog items in ANY project the instance knows, addressed by a
// `projects:` alias map (D2). The driver reads the one roadmap from the home
// project, lists backlog items per referenced+resolvable project, and starts each
// sprint in the ENTRY's own project root. An alias whose path is not among the
// known workspace roots parks the lane `unknown_project` for a re-map — never a
// silent drop.
//
// It owns NO timer of its own: `reconcile()` is invoked from the automations
// engine's existing evaluation tick, plus on demand after a human command. Watching
// is derivation, never a new poller: each reconcile reads the run projection and PR
// merge state through the existing front doors and re-derives lane state from
// backlog + run records so a kill/restart reaches the same conclusion.
//
// All decisions live in the pure reducer (`../shared/sprintengine/roadmap-orchestrator`);
// this file is only effects: load inputs, execute the actions the reducer emits,
// persist the returned lane runtime, notify on park.
import { reconcileRoadmap, } from '../shared/sprintengine/roadmap-orchestrator';
import { DEFAULT_ROADMAP_POLICY, epicMemberLookup, flattenLaneUnits, isRoadmapPermissionPreset, nextEligible, parseRoadmap, qualifiedRef, resolveRoadmapPermissionPreset, roadmapItemKey, roadmapRefSlug, splitQualifiedRef, } from '../shared/backlog/roadmap';
import { addEntry, addLane, authoredRef, buildRoadmapEntry, composeRoadmapSaveContent, draftContainsRef, draftFromRoadmap, moveEntry, newRoadmapFileContent, normalizeRoadmapPath, removeEntry, roadmapProjectAlias, } from '../shared/backlog/roadmapAuthoring';
import { serializeBacklogFrontmatterFields } from '../shared/backlog/frontmatter';
import { slugify } from '../shared/paths';
import { buildRoadmapBoardModel, skipRoadmapEntry, } from '../shared/sprintengine/roadmap-surface';
import { basename } from 'node:path';
// A roadmap file is orchestrated when it is a roadmap whose status is active
// (not idea/completed/archived). `ready`/`in_progress`/`needs_input` all run.
const ACTIVE_ROADMAP_STATUSES = new Set(['ready', 'in_progress', 'needs_input']);
// Human-readable park copy for the user notification (plain language, per the
// epic's copy guardrail — no "lane"/"reconciler"/"eligibility" in user text).
const PARK_NOTICE = {
    run_failed: 'A sprint failed. The horizon is paused until you take a look.',
    run_canceled: 'A sprint was canceled. The horizon is paused.',
    needs_input: 'A sprint is waiting on your input. The horizon is paused.',
    pr_closed: 'A pull request was closed without merging. The horizon is paused.',
    merge_failed: 'A merge could not complete. The horizon is paused.',
    start_failed: 'The next sprint could not start. The horizon is paused.',
    eligibility_contradiction: 'The horizon references an item that no longer exists. It is paused.',
    unknown_project: 'The horizon points at a project that can no longer be found. It is paused until you re-point it.',
    // A manual pause is a human action, not an incident — it never notifies (the
    // driver only calls notifyPark for the failure reasons), so this copy is a
    // defensive default the notify path never reaches.
    paused: 'The horizon is paused.',
};
export function createRoadmapOrchestrator(ports) {
    // Serialize reconciles so an engine tick and a human command never interleave
    // read-modify-write of the same lane runtime.
    let reconciling = null;
    // Human approvals to consume on the next reconcile, keyed `roadmapRef\0lane`.
    const approvals = new Map();
    // Human resume requests to clear a parked lane, same key.
    const resumes = new Set();
    function laneKey(roadmapRef, lane) {
        return `${roadmapRef} ${lane}`;
    }
    async function reconcile() {
        if (reconciling)
            return reconciling;
        reconciling = reconcileOnce().finally(() => {
            reconciling = null;
        });
        return reconciling;
    }
    async function reconcileOnce() {
        const entry = await loadActiveRoadmap();
        if (!entry)
            return;
        // Apply human resumes first: a resumed lane drops its dead run + parked flag,
        // so it must NOT count toward the busy set below (it is about to re-plan).
        clearResumedLanes(entry);
        // A lane holding an active run (running, parked, or awaiting merge) occupies
        // its project root until the human resumes / it advances.
        const busyRepos = new Set();
        for (const runtime of entry.laneRuntimes.values()) {
            if (runtime.activeRepoId && (runtime.activeItemRef || runtime.parked))
                busyRepos.add(runtime.activeRepoId);
        }
        try {
            await reconcileRoadmapEntry(entry, busyRepos);
        }
        catch (error) {
            ports.logDiagnostic({
                level: 'warning',
                title: 'Roadmap reconcile skipped',
                message: `${entry.roadmapRef}: ${errorMessage(error)}`,
            });
        }
    }
    // Load the single active instance roadmap from the home project, or null when
    // none is configured/active. The active roadmap is the newest roadmap-flagged
    // file (highest backlog id, then latest path); extras are surfaced as a warning.
    async function loadActiveRoadmap() {
        const homeRoot = ports.getHomeProjectRoot();
        if (!homeRoot)
            return null;
        let homeItems;
        try {
            homeItems = await ports.listBacklogItems(homeRoot);
        }
        catch (error) {
            ports.logDiagnostic({ level: 'warning', title: 'Roadmap scan skipped', message: `${homeRoot}: ${errorMessage(error)}` });
            return null;
        }
        const candidates = homeItems.filter((item) => item.isRoadmap && ACTIVE_ROADMAP_STATUSES.has(item.status));
        if (candidates.length === 0)
            return null;
        const active = pickActiveRoadmap(candidates);
        if (candidates.length > 1) {
            ports.notify({
                severity: 'warning',
                title: 'More than one horizon',
                body: `Only "${active.title ?? active.relativePath}" is active. Archive the extra horizon files so the plan is unambiguous.`,
            });
        }
        const content = await ports.readRoadmapFile(homeRoot, active.relativePath);
        if (content === null)
            return null;
        const roadmap = parseRoadmap(content);
        const { resolvableProjects, projectRootByKey } = await resolveProjects(homeRoot, roadmap);
        const items = await collectItems(homeItems, projectRootByKey);
        const itemStates = items.map((item) => ({
            ref: item.relativePath,
            status: item.status,
            projectKey: item.projectKey,
            ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
            // Epic membership rides the universe (MC-2031): an epic step's members are
            // resolved from these pointers, never from anything stored in the plan.
            ...(item.epic ? { epic: item.epic } : {}),
        }));
        const laneRuntimes = await ports.readLaneRuntime(active.relativePath, ports.listWorkspaceRoots());
        return { homeRoot, roadmapRef: active.relativePath, roadmap, itemStates, items, resolvableProjects, projectRootByKey, laneRuntimes };
    }
    // Map the roadmap's `projects:` aliases to workspace roots. The home project
    // (null) is always resolvable; an alias resolves only when its absolute path is
    // among the known workspace roots — otherwise the lane parks `unknown_project`.
    async function resolveProjects(homeRoot, roadmap) {
        const knownRoots = new Set(ports.listWorkspaceRoots().map(normalizeRoot));
        knownRoots.add(normalizeRoot(homeRoot));
        const projectRootByKey = new Map([[null, homeRoot]]);
        for (const project of roadmap.projects) {
            // First declaration wins (a duplicate alias is a validation issue).
            if (projectRootByKey.has(project.alias))
                continue;
            if (knownRoots.has(normalizeRoot(project.path)))
                projectRootByKey.set(project.alias, project.path);
        }
        return { resolvableProjects: new Set(projectRootByKey.keys()), projectRootByKey };
    }
    // Gather the backlog universe across every resolvable project, tagging each item
    // with its project key. The home project's items are reused from the scan already
    // done; each alias project is listed once.
    async function collectItems(homeItems, projectRootByKey) {
        const tagged = homeItems.map((item) => ({ ...item, projectKey: null }));
        for (const [projectKey, root] of projectRootByKey) {
            if (projectKey === null)
                continue;
            let items;
            try {
                items = await ports.listBacklogItems(root);
            }
            catch (error) {
                ports.logDiagnostic({ level: 'warning', title: 'Roadmap project scan skipped', message: `${root}: ${errorMessage(error)}` });
                continue;
            }
            for (const item of items)
                tagged.push({ ...item, projectKey });
        }
        return tagged;
    }
    const projectRootOf = (entry, projectKey) => entry.projectRootByKey.get(projectKey) ?? entry.homeRoot;
    async function reconcileRoadmapEntry(entry, busyRepos) {
        // Observe the live run behind each lane's active handle. Builds both the reducer
        // observations and the `runLinks` merged-state map nextEligible reads: a
        // completed-but-unmerged worktree frontier must read as not-merged, which only
        // an explicit worktree runLink expresses (a merged predecessor reads merged via
        // its terminal status).
        const observations = new Map();
        const runLinks = new Map();
        const recordObservation = (key, runRef, snapshot, repoId) => {
            observations.set(key, {
                itemRef: key,
                statePath: runRef.statePath,
                teamSlug: runRef.teamSlug,
                mode: snapshot.mode,
                lifecycle: snapshot.lifecycle,
                ...(snapshot.prAllMerged !== undefined ? { prAllMerged: snapshot.prAllMerged } : {}),
                ...(snapshot.prClosedUnmerged !== undefined ? { prClosedUnmerged: snapshot.prClosedUnmerged } : {}),
                repoId,
            });
            runLinks.set(key, {
                mode: snapshot.mode,
                ...(snapshot.mode === 'worktree' ? { prMerged: snapshot.prAllMerged === true } : {}),
            });
        };
        for (const runtime of entry.laneRuntimes.values()) {
            const key = runtime.activeItemRef;
            if (!key)
                continue;
            const { projectKey, relativePath } = splitQualifiedRef(key);
            const root = projectRootOf(entry, projectKey);
            const runRef = await resolveActiveRunRef(root, runtime, relativePath);
            if (!runRef)
                continue;
            const snapshot = await ports.observeRun(runRef);
            if (snapshot)
                recordObservation(key, runRef, snapshot, projectRootOf(entry, projectKey));
        }
        // Adoption pass — the crash-safe re-derivation. A lane whose persisted handle
        // was lost (fresh install, deleted sidecar) but whose frontier item still has
        // a live execution link RE-ADOPTS that run instead of starting a duplicate.
        for (const eligibility of nextEligible(entry.roadmap, entry.itemStates, runLinks, entry.resolvableProjects)) {
            const runtime = entry.laneRuntimes.get(eligibility.lane);
            if (runtime?.activeItemRef || runtime?.parked)
                continue;
            const frontier = eligibility.frontier;
            if (!frontier || eligibility.reason === 'eligible')
                continue;
            const root = entry.projectRootByKey.get(frontier.projectKey);
            if (!root)
                continue; // unresolvable project — the reducer parks it.
            const runRef = await ports.resolveExecutionLink(root, frontier.relativePath);
            if (!runRef)
                continue;
            const snapshot = await ports.observeRun(runRef);
            if (!snapshot || !isAdoptable(snapshot))
                continue;
            recordObservation(frontier.key, runRef, snapshot, root);
            entry.laneRuntimes.set(eligibility.lane, {
                lane: eligibility.lane,
                ...(runtime ?? {}),
                activeItemRef: frontier.key,
                activeStatePath: runRef.statePath,
                activeTeamSlug: runRef.teamSlug,
                activeRepoId: root,
            });
            busyRepos.add(root);
        }
        const approvedRefs = drainApprovals(entry);
        const result = reconcileRoadmap({
            roadmap: entry.roadmap,
            items: entry.itemStates,
            resolvableProjects: entry.resolvableProjects,
            runLinks,
            observations,
            laneRuntimes: entry.laneRuntimes,
            approvedRefs,
            repoBusy: (repoId) => busyRepos.has(repoId),
            repoForLane: (_lane, unit) => projectRootOf(entry, unit.projectKey),
            now: ports.now().toISOString(),
        });
        for (const action of result.actions) {
            await executeAction(entry, action, result.laneRuntimes, busyRepos);
        }
        await ports.writeLaneRuntime(entry.roadmapRef, result.laneRuntimes);
    }
    async function executeAction(entry, action, laneRuntimes, busyRepos) {
        const runtime = laneRuntimes.get(action.lane) ?? { lane: action.lane };
        switch (action.kind) {
            case 'start': {
                const root = projectRootOf(entry, action.projectKey);
                const item = entry.items.find((candidate) => candidate.projectKey === action.projectKey && candidate.relativePath === action.relativePath);
                // The roster and the agent runtime arrive RESOLVED on the action
                // (MC-1883 / MC-2145) — the step's own annotation or the roadmap's,
                // decided once by `resolveEntryRoster`/`resolveEntryAgent` in the
                // reducer. The driver must not re-derive the two-tier fallback here.
                const started = await executeStart(root, action.relativePath, item?.isEpic ?? false, action.roster, action.agent, resolveRoadmapPermissionPreset(entry.roadmap.policy));
                if (!started.ok) {
                    // An unknown roster name fails the start here (the delegate refuses it
                    // rather than staffing a fallback). Park + notify + a diagnostic, so a
                    // failed start is visible in the UI and not only in a console warning —
                    // and the lane does NOT advance past the step it could not staff.
                    laneRuntimes.set(action.lane, parkedRuntime(runtime, 'start_failed', qualifiedRef(action.projectKey, action.relativePath), started.message, ports.now()));
                    ports.logDiagnostic({
                        level: 'error',
                        title: 'Horizon step could not start',
                        message: `${action.itemRef}${action.roster ? ` (roster "${action.roster}")` : ''}: ${started.message ?? 'the sprint could not be created.'}`,
                    });
                    notifyPark('start_failed', started.message);
                    return;
                }
                busyRepos.add(runtime.activeRepoId ?? root);
                laneRuntimes.set(action.lane, {
                    ...runtime,
                    activeItemRef: qualifiedRef(action.projectKey, action.relativePath),
                    activeStatePath: started.runRef.statePath,
                    activeTeamSlug: started.runRef.teamSlug,
                    activeRepoId: runtime.activeRepoId ?? root,
                    // Frozen at start: editing the horizon's roster later must not rewrite
                    // what a mid-flight step reports it was staffed with.
                    ...(action.roster ? { activeRoster: action.roster } : {}),
                });
                return;
            }
            case 'queue_approval':
                ports.notify({
                    severity: 'info',
                    title: 'Horizon ready to continue',
                    body: 'The next piece of work is ready to start when you are.',
                });
                return;
            case 'merge': {
                const merged = await ports.mergePullRequest(action.statePath);
                if (!merged.ok) {
                    const detail = mergeFailureDetail(merged);
                    laneRuntimes.set(action.lane, parkedRuntime(runtime, 'merge_failed', action.itemRef, detail, ports.now()));
                    notifyPark('merge_failed', detail);
                    return;
                }
                // The merge IS the delivery. Recording it here rather than waiting for the
                // next reconcile's `clear_active` is what makes "the step merged" and "its
                // backlog items read completed" one event instead of two a tick apart —
                // and the write is idempotent, so the later `clear_active` agrees (MC-1904).
                await recordStepDelivered(entry, action.itemRef, {
                    statePath: action.statePath,
                    teamSlug: runtime.activeTeamSlug ?? '',
                });
                return;
            }
            case 'park':
                notifyPark(action.reason, action.detail);
                return;
            case 'clear_active':
                // Only a DELIVERED run marks its work done. A run that merely vanished from
                // observations carries no itemRef and shipped nothing.
                if (action.delivered && action.itemRef) {
                    await recordStepDelivered(entry, action.itemRef, action.statePath ? { statePath: action.statePath, teamSlug: action.teamSlug ?? '' } : undefined);
                }
                return;
        }
    }
    // Record a delivered step's backlog items as completed, on the MAIN checkout
    // (MC-1904). An epic step marks its LIVE MEMBERS, never the epic file — an
    // epic's status derives from its members (`nextEligible`'s effectiveState), so
    // writing it directly would paper over the derivation instead of feeding it. An
    // item step (and an epic with no members) marks itself.
    //
    // Honesty constraint: a member whose tasks did not all finish is left alone. The
    // run's brief is the whole step, so the default is delivered; the run's terminal
    // task state overrides that only where it actually maps an item to tasks.
    async function recordStepDelivered(entry, itemRef, runRef) {
        const targets = deliveredTargets(entry, itemRef);
        if (targets.length === 0) {
            // The handle names nothing the plan still carries. Say so rather than
            // returning quietly: a delivery that marks nothing is exactly the silent
            // no-op this item exists to remove.
            ports.logDiagnostic({
                level: 'warning',
                title: 'Roadmap completion write skipped',
                message: `${itemRef} delivered but is no longer a step in this horizon; nothing was marked completed.`,
            });
            return;
        }
        const outcomes = runRef ? await readItemOutcomes(runRef) : new Map();
        for (const target of targets) {
            const relativePath = normalizeRoadmapPath(target.relativePath);
            if (outcomes.get(relativePath) === 'skipped')
                continue;
            try {
                await ports.setBacklogStatus(projectRootOf(entry, target.projectKey), target.relativePath, 'completed');
            }
            catch (error) {
                // One item's write failing must not cost the others theirs; the next
                // reconcile's `clear_active` retries the whole set.
                ports.logDiagnostic({
                    level: 'warning',
                    title: 'Roadmap completion write skipped',
                    message: `${target.relativePath}: ${errorMessage(error)}`,
                });
            }
        }
    }
    async function readItemOutcomes(runRef) {
        try {
            const raw = await ports.readRunItemOutcomes(runRef);
            return new Map([...raw].map(([path, outcome]) => [normalizeRoadmapPath(path), outcome]));
        }
        catch {
            // No task mapping readable: fall back to the documented default (the run's
            // brief was the whole step), exactly as a run whose tasks name no sources.
            return new Map();
        }
    }
    // The backlog items a delivered handle should mark completed.
    //
    // A STEP handle (the normal case) resolves to the step's live members, or to the
    // step itself when it has none. A handle naming a MEMBER resolves to that member
    // alone: a lane runtime written under the old child-granularity keys its
    // `activeItemRef` on a member, and the reducer deliberately keeps such a handle
    // (`plannedKeysOf` includes members) — so matching only top-level steps here
    // would have silently marked nothing for exactly the runs that migration guard
    // exists to carry.
    //
    // Empty means the handle names nothing the plan still carries; the caller reports
    // that rather than doing nothing quietly.
    function deliveredTargets(entry, itemRef) {
        const membersOf = epicMemberLookup(entry.itemStates);
        for (const lane of entry.roadmap.lanes) {
            for (const unit of flattenLaneUnits(lane)) {
                const members = membersOf(unit);
                if (unit.key === itemRef) {
                    return members.length > 0
                        ? members.map((member) => ({ projectKey: member.projectKey ?? null, relativePath: member.ref }))
                        : [{ projectKey: unit.projectKey, relativePath: unit.relativePath }];
                }
                for (const member of members) {
                    if (roadmapItemKey(member) === itemRef) {
                        return [{ projectKey: member.projectKey ?? null, relativePath: member.ref }];
                    }
                }
            }
        }
        return [];
    }
    // Idempotent start keyed on the execution link: if the item already has a live
    // run, adopt it instead of creating a second. Otherwise create through the shared
    // plan-sourced flow, then resolve the link the creation wrote.
    async function executeStart(workspaceRoot, itemRelativePath, isEpic, roster, agent, permissionPreset) {
        const existing = await ports.resolveExecutionLink(workspaceRoot, itemRelativePath);
        if (existing) {
            // Adopting a LIVE run cannot change its agents' permission preset — bypass
            // is spawn-time-only (MC-1808). A run started gated stays gated until it is
            // cancelled and relaunched; there is deliberately no mid-session flip here.
            const snapshot = await ports.observeRun(existing);
            if (snapshot && isAdoptable(snapshot))
                return { ok: true, runRef: existing };
        }
        const created = await ports.startSprint({
            workspaceRoot,
            itemRelativePath,
            isEpic,
            permissionPreset,
            ...(roster ? { roster } : {}),
            ...(agent ? { agent } : {}),
        });
        if (!created.ok)
            return { ok: false, message: created.message };
        const runRef = await ports.resolveExecutionLink(workspaceRoot, itemRelativePath);
        if (!runRef) {
            return { ok: false, message: 'Sprint started but no execution link was recorded.' };
        }
        return { ok: true, runRef };
    }
    async function resolveActiveRunRef(workspaceRoot, runtime, itemRelativePath) {
        if (runtime.activeStatePath && runtime.activeTeamSlug) {
            return { statePath: runtime.activeStatePath, teamSlug: runtime.activeTeamSlug };
        }
        return ports.resolveExecutionLink(workspaceRoot, itemRelativePath);
    }
    function drainApprovals(entry) {
        const approved = new Set();
        const prefix = `${entry.roadmapRef} `;
        for (const [key, ref] of approvals) {
            if (key.startsWith(prefix)) {
                approved.add(ref);
                approvals.delete(key);
            }
        }
        return approved;
    }
    function clearResumedLanes(entry) {
        for (const [lane, runtime] of entry.laneRuntimes) {
            const key = laneKey(entry.roadmapRef, lane);
            if (!resumes.has(key))
                continue;
            resumes.delete(key);
            // Resume re-plans a NEW sprint from the same item: drop the parked flag AND
            // the dead active handle so eligibility starts fresh — it never unsticks the
            // failed run.
            const { parked, activeItemRef, activeStatePath, activeTeamSlug, activeRepoId, activeRoster, ...rest } = runtime;
            entry.laneRuntimes.set(lane, rest);
        }
    }
    function notifyPark(reason, detail) {
        ports.notify({
            severity: reason === 'needs_input' ? 'info' : 'warning',
            title: 'Horizon paused',
            body: detail ? `${PARK_NOTICE[reason]} (${detail})` : PARK_NOTICE[reason],
        });
    }
    // --- Human + agent commands (over IPC from the surface, MC-1620; over the
    //     automation surface from an agent, MC-1693) ---
    // Record an agent-invoked action to the append-only audit log. Human (`'user'`)
    // actions are not logged — the board already attributes them. Best-effort: a
    // logging failure never fails the action that already succeeded.
    async function auditIfAgent(entry) {
        if (entry.actor !== 'automation')
            return;
        await ports.appendAudit(entry.roadmapRef, entry).catch(() => undefined);
    }
    async function approveStart(roadmapRef, lane, actor = 'user') {
        const runtimes = await ports.readLaneRuntime(roadmapRef);
        const runtime = runtimes.get(lane);
        if (!runtime?.pendingApprovalRef) {
            return { ok: false, message: 'No pending approval for this lane.' };
        }
        approvals.set(laneKey(roadmapRef, lane), runtime.pendingApprovalRef);
        await auditIfAgent({ at: ports.now().toISOString(), actor, action: 'approve', roadmapRef, lane, ref: runtime.pendingApprovalRef });
        await reconcile();
        return { ok: true };
    }
    async function mergeLane(roadmapRef, lane, actor = 'user') {
        const runtimes = await ports.readLaneRuntime(roadmapRef);
        const runtime = runtimes.get(lane);
        if (!runtime?.activeStatePath) {
            return { ok: false, message: 'No run to merge for this lane.' };
        }
        const merged = await ports.mergePullRequest(runtime.activeStatePath);
        if (!merged.ok)
            return { ok: false, message: mergeFailureDetail(merged) };
        await auditIfAgent({ at: ports.now().toISOString(), actor, action: 'merge', roadmapRef, lane, ...(runtime.activeItemRef ? { ref: runtime.activeItemRef } : {}) });
        await reconcile();
        return { ok: true };
    }
    async function resumeLane(roadmapRef, lane, actor = 'user', options = {}) {
        await auditIfAgent({ at: ports.now().toISOString(), actor, action: 'resume', roadmapRef, lane });
        const runtime = (await ports.readLaneRuntime(roadmapRef)).get(lane);
        // A MANUAL pause is not a failure: resume continues the lane exactly where it
        // was, so it must NOT abandon the still-live run. Only clear the parked flag.
        if (runtime?.parked?.reason === 'paused') {
            await clearPark(roadmapRef, lane);
            await reconcile();
            return { ok: true };
        }
        // A MERGE park is not a dead run either — the work is done and waiting on a
        // merge that was refused. Resume retries THE MERGE (MC-1909). Abandoning here
        // is what discarded a completed, delivered 17-task run on the first horizon.
        if (runtime?.parked?.reason === 'merge_failed' && runtime.activeStatePath) {
            const merged = await ports.mergePullRequest(runtime.activeStatePath);
            if (!merged.ok) {
                const detail = mergeFailureDetail(merged);
                await reparkMergeFailure(roadmapRef, lane, runtime.parked.itemRef, detail);
                notifyPark('merge_failed', detail);
                return { ok: false, message: detail };
            }
            await clearPark(roadmapRef, lane);
            await reconcile();
            return { ok: true };
        }
        // Every other park re-plans a NEW sprint from the same step, which throws away
        // whatever the parked run produced. That is right for a run that DIED and wrong
        // for one that finished, so a completed run needs the consequence spelled out
        // and acknowledged before the abandon (MC-1909).
        const abandonKey = runtime?.activeItemRef;
        if (abandonKey && runtime?.activeRepoId) {
            const { relativePath } = splitQualifiedRef(abandonKey);
            if (!options.replanDeliveredRun && (await runHasDelivered(runtime))) {
                return {
                    ok: false,
                    confirm: 'replan_delivered_run',
                    message: 'This sprint finished its work — resuming would throw it away and plan a new sprint for the same step from scratch. ' +
                        'Merge it instead, or confirm that you want to start over.',
                };
            }
            await ports.abandonRun(runtime.activeRepoId, relativePath, runtime.activeTeamSlug);
        }
        resumes.add(laneKey(roadmapRef, lane));
        await reconcile();
        return { ok: true };
    }
    // True when the lane's parked run actually completed its tasks — the state a
    // resume must not silently discard. An unreadable/absent run is not delivered:
    // the abandon path is exactly what recovers those.
    async function runHasDelivered(runtime) {
        if (!runtime.activeStatePath || !runtime.activeTeamSlug)
            return false;
        const snapshot = await ports.observeRun({ statePath: runtime.activeStatePath, teamSlug: runtime.activeTeamSlug });
        return snapshot?.lifecycle === 'completed';
    }
    // Drop a lane's park flag, leaving every other handle in place.
    async function clearPark(roadmapRef, lane) {
        const runtimes = await ports.readLaneRuntime(roadmapRef);
        const current = runtimes.get(lane);
        if (!current?.parked)
            return;
        const { parked, ...rest } = current;
        runtimes.set(lane, rest);
        await ports.writeLaneRuntime(roadmapRef, runtimes);
    }
    // Re-stamp a merge park with the reason THIS attempt failed, so a retry that hits
    // a new error does not leave the old one on screen.
    async function reparkMergeFailure(roadmapRef, lane, itemRef, detail) {
        const runtimes = await ports.readLaneRuntime(roadmapRef);
        const current = runtimes.get(lane) ?? { lane };
        runtimes.set(lane, parkedRuntime(current, 'merge_failed', itemRef, detail, ports.now()));
        await ports.writeLaneRuntime(roadmapRef, runtimes);
    }
    // Hold a lane at the human's request: set a `paused` park so the reducer stops
    // advancing/merging/starting-next for this lane, without touching the running
    // sprint. A no-op if the lane is already parked (resume is the only exit).
    async function pauseLane(roadmapRef, lane, actor = 'user') {
        const runtimes = await ports.readLaneRuntime(roadmapRef);
        const runtime = runtimes.get(lane) ?? { lane };
        if (runtime.parked)
            return { ok: true };
        const itemRef = runtime.activeItemRef ?? runtime.pendingApprovalRef ?? '';
        const { pendingApprovalRef, ...rest } = runtime;
        runtimes.set(lane, { ...rest, parked: { reason: 'paused', itemRef, at: ports.now().toISOString() } });
        await ports.writeLaneRuntime(roadmapRef, runtimes);
        await auditIfAgent({ at: ports.now().toISOString(), actor, action: 'pause', roadmapRef, lane, ...(itemRef ? { ref: itemRef } : {}) });
        return { ok: true };
    }
    // Read the single instance roadmap's per-lane steering state for the board. An
    // array is returned for the surface's existing shape — zero or one entry.
    async function readRoadmapStates() {
        const entry = await loadActiveRoadmap();
        if (!entry)
            return [];
        return [
            {
                roadmapRef: entry.roadmapRef,
                title: entry.roadmap.title,
                lanes: entry.roadmap.lanes.map((lane) => {
                    const runtime = entry.laneRuntimes.get(lane.title);
                    return {
                        lane: lane.title,
                        ...(runtime?.activeItemRef ? { activeItemRef: runtime.activeItemRef } : {}),
                        ...(runtime?.activeTeamSlug ? { activeTeamSlug: runtime.activeTeamSlug } : {}),
                        ...(runtime?.activeStatePath ? { activeStatePath: runtime.activeStatePath } : {}),
                        ...(runtime?.activeRoster ? { activeRoster: runtime.activeRoster } : {}),
                        ...(runtime?.parked ? { parked: runtime.parked } : {}),
                        ...(runtime?.pendingApprovalRef ? { pendingApprovalRef: runtime.pendingApprovalRef } : {}),
                    };
                }),
            },
        ];
    }
    // --- Agent read + plan surface (roadmap.* automation tools, MC-1693) ---
    // The board projection the global surface renders, built in main for the agent
    // read: the same shared builder over the loaded roadmap + backlog scan + lane
    // runtime. Null when no roadmap is configured/active (the tool reports that).
    async function readBoard() {
        const entry = await loadActiveRoadmap();
        if (!entry)
            return null;
        const infoByKey = new Map();
        for (const item of entry.items) {
            infoByKey.set(qualifiedRef(item.projectKey, normalizeRoadmapPath(item.relativePath)), {
                title: item.title ?? roadmapRefSlug(item.relativePath),
                status: item.status,
            });
        }
        const membersOf = epicMemberLookup(entry.itemStates);
        const resolver = {
            itemInfo: (projectKey, relativePath) => infoByKey.get(qualifiedRef(projectKey, normalizeRoadmapPath(relativePath))),
            projectName: (projectKey) => projectDisplayName(entry, projectKey),
            resolvableProjects: entry.resolvableProjects,
            epicMembers: (projectKey, epicRelativePath) => membersOf({ kind: 'epic', ref: epicRelativePath, projectKey }).map((member) => member.ref),
        };
        const lanes = buildRoadmapBoardModel(entry.roadmap, resolver, laneRuntimeViewMap(entry));
        return { roadmapRef: entry.roadmapRef, title: entry.roadmap.title, lanes };
    }
    // Add a step to the plan: an item, or an epic as one step (a bare reference —
    // its members resolve live on every read), from the home project or any open
    // workspace. Malformed or unresolvable refs are rejected with a message and the
    // file is never touched (acceptance #2).
    async function addStep(input) {
        const loaded = await loadForEdit();
        if ('error' in loaded)
            return { ok: false, message: loaded.error };
        const { entry, content } = loaded;
        const relativePath = normalizeRoadmapPath(input.ref);
        if (!/^backlog\/.+\.(md|html?)$/i.test(relativePath)) {
            return { ok: false, message: `"${input.ref}" is not a backlog item path (expected e.g. backlog/foo.md).` };
        }
        const target = await resolveTargetProject(entry, input.projectPath);
        if ('error' in target)
            return { ok: false, message: target.error };
        const items = await ports.listBacklogItems(target.root);
        const item = items.find((candidate) => normalizeRoadmapPath(candidate.relativePath) === relativePath);
        if (!item) {
            return { ok: false, message: `No backlog item at ${relativePath} in ${projectDisplayName(entry, target.projectKey)}.` };
        }
        const stored = authoredRef(target.projectKey, relativePath);
        if (draftContainsRef(entry.roadmap.lanes, stored)) {
            return { ok: false, message: `${stored} is already in the roadmap.` };
        }
        const newEntry = buildRoadmapEntry(target.projectKey, relativePath);
        const baseline = draftFromRoadmap(entry.roadmap);
        const draft = draftFromRoadmap(entry.roadmap);
        if (target.alias && target.projectKey && !draft.projects.some((project) => project.alias === target.alias)) {
            draft.projects = [...draft.projects, { alias: target.alias, path: target.root }];
        }
        const laneIndex = resolveLaneIndexForAdd(draft, input.lane);
        if (typeof laneIndex !== 'number')
            return { ok: false, message: laneIndex.error };
        draft.lanes = addEntry(draft.lanes, laneIndex, newEntry);
        const written = await writePlan(entry, content, baseline, draft, {
            at: ports.now().toISOString(),
            actor: input.actor ?? 'automation',
            action: 'add_step',
            roadmapRef: entry.roadmapRef,
            ref: stored,
            lane: draft.lanes[laneIndex]?.title,
        });
        if (!written.ok)
            return written;
        return { ok: true, ref: stored };
    }
    async function removeStep(input) {
        const loaded = await loadForEdit();
        if ('error' in loaded)
            return { ok: false, message: loaded.error };
        const { entry, content } = loaded;
        const stored = normalizeRoadmapPath(input.ref);
        const located = locateEntry(entry.roadmap.lanes, stored);
        if (!located)
            return { ok: false, message: `${stored} is not in the roadmap.` };
        const baseline = draftFromRoadmap(entry.roadmap);
        const draft = draftFromRoadmap(entry.roadmap);
        draft.lanes = removeEntry(draft.lanes, located.laneIndex, located.entryIndex);
        return writePlan(entry, content, baseline, draft, {
            at: ports.now().toISOString(),
            actor: input.actor ?? 'automation',
            action: 'remove_step',
            roadmapRef: entry.roadmapRef,
            ref: stored,
        });
    }
    async function reorderStep(input) {
        const loaded = await loadForEdit();
        if ('error' in loaded)
            return { ok: false, message: loaded.error };
        const { entry, content } = loaded;
        const stored = normalizeRoadmapPath(input.ref);
        const located = locateEntry(entry.roadmap.lanes, stored);
        if (!located)
            return { ok: false, message: `${stored} is not in the roadmap.` };
        const baseline = draftFromRoadmap(entry.roadmap);
        const draft = draftFromRoadmap(entry.roadmap);
        const toLaneIndex = input.toLane ? draft.lanes.findIndex((lane) => lane.title === input.toLane) : located.laneIndex;
        if (toLaneIndex < 0)
            return { ok: false, message: `No track named "${input.toLane}".` };
        draft.lanes = moveEntry(draft.lanes, { lane: located.laneIndex, index: located.entryIndex }, { lane: toLaneIndex, index: Math.max(0, Math.trunc(input.toIndex)) });
        return writePlan(entry, content, baseline, draft, {
            at: ports.now().toISOString(),
            actor: input.actor ?? 'automation',
            action: 'reorder',
            roadmapRef: entry.roadmapRef,
            ref: stored,
            lane: draft.lanes[toLaneIndex]?.title,
        });
    }
    // Skip a step: remove it from the plan (a source-of-truth file edit that appends an
    // inert audit comment), so the frontier advances past it. Never archives the backlog
    // item (that would read as dangling and PARK). Requires a reason, like the UI.
    async function skipStep(input) {
        const loaded = await loadForEdit();
        if ('error' in loaded)
            return { ok: false, message: loaded.error };
        const { entry, content } = loaded;
        const stored = normalizeRoadmapPath(input.ref);
        const newContent = skipRoadmapEntry(content, stored, input.reason, ports.now().toISOString().slice(0, 10));
        if (newContent === content) {
            return { ok: false, message: `${stored} is not in the roadmap (nothing was skipped).` };
        }
        await ports.writeRoadmapFile(entry.homeRoot, entry.roadmapRef, newContent);
        await auditIfAgent({
            at: ports.now().toISOString(),
            actor: input.actor ?? 'automation',
            action: 'skip',
            roadmapRef: entry.roadmapRef,
            ref: stored,
            detail: input.reason,
        });
        await reconcile();
        return { ok: true };
    }
    // Make one roadmap file the single active plan (epic 1687 D1): promote the target
    // to `ready`, then demote every OTHER active-status roadmap to `idea`. The order is
    // load-bearing — the target is made active BEFORE any demote, so a write failure
    // mid-operation can only ever leave TWO active files (a recoverable warning
    // loadActiveRoadmap resolves by newest id), never ZERO. Frontmatter-only writes;
    // the body stays byte-stable. Reconciles so the orchestrator adopts the new plan.
    async function activateRoadmap(input) {
        const homeRoot = ports.getHomeProjectRoot();
        if (!homeRoot)
            return { ok: false, message: 'No home project is configured.' };
        const targetRef = normalizeRoadmapPath(input.roadmapRef);
        let roadmaps;
        try {
            roadmaps = (await ports.listBacklogItems(homeRoot)).filter((item) => item.isRoadmap);
        }
        catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        const target = roadmaps.find((item) => normalizeRoadmapPath(item.relativePath) === targetRef);
        if (!target)
            return { ok: false, message: 'That horizon file no longer exists.' };
        try {
            // Promote first: the one write that must land before anything is demoted.
            if (!ACTIVE_ROADMAP_STATUSES.has(target.status)) {
                await writeRoadmapStatusFile(homeRoot, target.relativePath, 'ready');
            }
            for (const candidate of roadmaps) {
                if (normalizeRoadmapPath(candidate.relativePath) === targetRef)
                    continue;
                if (ACTIVE_ROADMAP_STATUSES.has(candidate.status)) {
                    await writeRoadmapStatusFile(homeRoot, candidate.relativePath, 'idea');
                }
            }
        }
        catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        await reconcile();
        return { ok: true };
    }
    // Create a new DRAFT roadmap (status idea, so nothing runs until it is made active):
    // atomically write the file in the home project, or — when no home is set yet — in
    // the caller's chosen OPEN project (the IPC handler then adopts that as the home).
    // Refuses to overwrite an existing file (fallback discipline). Returns the written
    // project root so the handler knows which project to set as home.
    async function createRoadmap(input) {
        const name = input.name.trim();
        if (!name)
            return { ok: false, message: 'A horizon name is required.' };
        const homeRoot = ports.getHomeProjectRoot();
        // A configured home wins — the roadmap is instance-global; otherwise the caller's
        // project must be an open workspace, never a silent fallback.
        const projectRoot = homeRoot ?? input.projectRoot;
        if (!homeRoot) {
            const known = new Set(ports.listWorkspaceRoots().map(normalizeRoot));
            if (!known.has(normalizeRoot(input.projectRoot))) {
                return { ok: false, message: 'Open the project first, then create a horizon in it.' };
            }
        }
        const relativePath = `backlog/roadmaps/${roadmapDatePrefix(ports.now())}-${slugify(name)}.md`;
        if ((await ports.readRoadmapFile(projectRoot, relativePath)) !== null) {
            return { ok: false, message: 'A horizon with that name already exists here. Pick a different name.' };
        }
        try {
            await ports.writeRoadmapFile(projectRoot, relativePath, newRoadmapFileContent(name));
        }
        catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        return { ok: true, roadmapRef: normalizeRoadmapPath(relativePath), projectRoot };
    }
    // Delete a roadmap file (MC-1917). The plan is the only thing removed: the backlog
    // items it lined up are untouched, and sprints it already started or delivered keep
    // their runs, branches and pull requests. Refuses while a sprint is actually running
    // on it — deleting the plan under a live run would strand that run with nothing left
    // to reconcile it against, and there is no undo for the file. The lane-runtime
    // sidecar is cleared alongside the file so a later horizon reusing the same ref can
    // never inherit this one's parks and pending approvals.
    async function deleteRoadmap(input) {
        const homeRoot = ports.getHomeProjectRoot();
        if (!homeRoot)
            return { ok: false, message: 'No home project is configured.' };
        const targetRef = normalizeRoadmapPath(input.roadmapRef);
        let roadmaps;
        try {
            roadmaps = (await ports.listBacklogItems(homeRoot)).filter((item) => item.isRoadmap);
        }
        catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        const target = roadmaps.find((item) => normalizeRoadmapPath(item.relativePath) === targetRef);
        // Already gone is the caller's intent, not a failure.
        if (!target)
            return { ok: true };
        // Fail CLOSED: if the sidecar cannot be read we do not know whether a sprint is
        // live, and this is the one roadmap op with no undo. Refuse and say so rather
        // than treat "couldn't check" as "nothing is running".
        let runtimes;
        try {
            runtimes = await ports.readLaneRuntime(targetRef);
        }
        catch (error) {
            return {
                ok: false,
                message: `Couldn’t check whether a sprint is running on this horizon, so it was not deleted: ${errorMessage(error)}`,
            };
        }
        const running = Array.from(runtimes.values()).filter((runtime) => Boolean(runtime.activeStatePath));
        if (running.length > 0) {
            const lanes = running.map((runtime) => runtime.lane).join(', ');
            return {
                ok: false,
                message: running.length === 1
                    ? `A sprint is running on the “${lanes}” track. Pause the horizon and let it finish, or cancel that sprint, then delete this horizon.`
                    : `Sprints are running on the ${lanes} tracks. Pause the horizon and let them finish, or cancel those sprints, then delete this horizon.`,
            };
        }
        try {
            await ports.deleteRoadmapFile(homeRoot, target.relativePath);
        }
        catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        // Best-effort: the file is already gone, so a stale sidecar must never turn a
        // successful delete into a reported failure.
        await ports.writeLaneRuntime(targetRef, new Map()).catch(() => undefined);
        await reconcile();
        return { ok: true };
    }
    // Write a roadmap file's frontmatter status, body byte-stable. Throws when the file
    // cannot be read, so activateRoadmap aborts before it demotes anything.
    async function writeRoadmapStatusFile(homeRoot, relativePath, status) {
        const content = await ports.readRoadmapFile(homeRoot, relativePath);
        if (content === null)
            throw new Error(`The roadmap file ${relativePath} could not be read.`);
        const next = serializeBacklogFrontmatterFields(content, { status });
        if (next !== content)
            await ports.writeRoadmapFile(homeRoot, relativePath, next);
    }
    // Load the active roadmap plus its raw on-disk content, for a plan edit. The
    // content is the exact bytes composeRoadmapSaveContent/skipRoadmapEntry edit.
    async function loadForEdit() {
        const entry = await loadActiveRoadmap();
        if (!entry)
            return { error: 'No active roadmap is configured.' };
        const content = await ports.readRoadmapFile(entry.homeRoot, entry.roadmapRef);
        if (content === null)
            return { error: 'The roadmap file could not be read.' };
        return { entry, content };
    }
    // Resolve the target project for a plan add: the home project (unqualified refs)
    // when no path or the home path is given, else an OPEN workspace root. An existing
    // alias for that path is reused; a new one is minted (registered on save). A path
    // that is not an open workspace is rejected — never a silent home fallback.
    async function resolveTargetProject(entry, projectPath) {
        if (!projectPath || normalizeRoot(projectPath) === normalizeRoot(entry.homeRoot)) {
            return { projectKey: null, root: entry.homeRoot };
        }
        const normalized = normalizeRoot(projectPath);
        const knownRoots = new Set(ports.listWorkspaceRoots().map(normalizeRoot));
        knownRoots.add(normalizeRoot(entry.homeRoot));
        if (!knownRoots.has(normalized)) {
            return { error: `Project "${projectPath}" is not an open workspace.` };
        }
        for (const project of entry.roadmap.projects) {
            if (normalizeRoot(project.path) === normalized)
                return { projectKey: project.alias, root: project.path };
        }
        const taken = new Set(entry.roadmap.projects.map((project) => project.alias));
        const alias = roadmapProjectAlias(basename(projectPath) || 'project', taken);
        return { projectKey: alias, root: projectPath, alias };
    }
    // Compose the plan edit, guard that it still parses, atomically write it, audit the
    // agent action, then reconcile so the change takes effect. A no-op edit (identical
    // bytes) succeeds without a write.
    async function writePlan(entry, content, baseline, draft, audit) {
        const newContent = composeRoadmapSaveContent(content, baseline, draft);
        if (newContent === content)
            return { ok: true };
        // Never leave the file invalid: the canonical serializer always parses, but guard
        // against a structural loss (steps expected, none recovered) before writing.
        const reparsed = parseRoadmap(newContent);
        const expectedEntries = draft.lanes.some((lane) => lane.entries.length > 0);
        if (expectedEntries && reparsed.lanes.every((lane) => lane.entries.length === 0)) {
            return { ok: false, message: 'The edit would produce an invalid roadmap; nothing was written.' };
        }
        await ports.writeRoadmapFile(entry.homeRoot, entry.roadmapRef, newContent);
        await auditIfAgent(audit);
        await reconcile();
        return { ok: true };
    }
    // --- Horizon authoring for the agent surface (MC-1901) ---------------------
    // Set policy scalars on the active horizon. FRONTMATTER-ONLY by construction:
    // it goes through the same `composeRoadmapSaveContent` the editor saves with,
    // and a policy-only diff takes the frontmatter branch that preserves the body
    // byte-for-byte. Nothing here touches lanes, so the plan cannot be perturbed
    // by a staffing change.
    //
    // Permission changes apply to sprints NOT YET STARTED — bypass is spawn-time
    // only (MC-1808), so a live agent's preset is never flipped mid-session.
    async function configureHorizon(input) {
        const loaded = await loadForEdit();
        if ('error' in loaded)
            return { ok: false, message: loaded.error };
        const { entry, content } = loaded;
        const validated = validateHorizonPolicy(input.policy);
        if ('error' in validated)
            return { ok: false, message: validated.error };
        const baseline = draftFromRoadmap(entry.roadmap);
        const draft = draftFromRoadmap(entry.roadmap);
        draft.policy = { ...draft.policy, ...validated.policy };
        const written = await writePlan(entry, content, baseline, draft, {
            at: ports.now().toISOString(),
            actor: input.actor ?? 'automation',
            action: 'configure',
            roadmapRef: entry.roadmapRef,
        });
        if (!written.ok)
            return written;
        return { ok: true, policy: draft.policy };
    }
    // Create a horizon with its ordered steps and policy in ONE validated write,
    // then make it the active horizon so it is steerable.
    //
    // SAFETY (MC-1901, from a live incident): a file write is not consent to spawn
    // agents. `advance` is FORCED to 'approve' unless the caller passes an explicit
    // `start: true` — otherwise a `ready` + `auto` horizon is adopted by the live
    // orchestrator and starts a sprint on its next tick, with nobody having agreed
    // to it. The forcing happens here, at the one place that writes the file, not
    // in the tool layer, so no future caller can route around it.
    async function createHorizon(input) {
        const validated = validateHorizonPolicy(input.policy ?? {});
        if ('error' in validated)
            return { ok: false, message: validated.error };
        // Validate EVERY step before creating anything. Without this, a typo in the
        // third of four steps leaves a half-built horizon on disk that is ALREADY
        // ACTIVE — and the previously-active horizon already demoted. Refusing up
        // front keeps a bad call a no-op instead of a mess someone has to unpick.
        const homeRoot = ports.getHomeProjectRoot();
        if (homeRoot && (input.steps?.length ?? 0) > 0) {
            let known;
            try {
                known = await ports.listBacklogItems(homeRoot);
            }
            catch (error) {
                return { ok: false, message: errorMessage(error) };
            }
            const paths = new Set(known.map((item) => normalizeRoadmapPath(item.relativePath)));
            for (const step of input.steps ?? []) {
                const relativePath = normalizeRoadmapPath(step);
                if (!/^backlog\/.+\.(md|html?)$/i.test(relativePath)) {
                    return { ok: false, message: `"${step}" is not a backlog item path (expected e.g. backlog/foo.md). Nothing was created.` };
                }
                if (!paths.has(relativePath)) {
                    return { ok: false, message: `No backlog item at ${relativePath}. Nothing was created.` };
                }
            }
        }
        const created = await createRoadmap({ projectRoot: input.projectRoot ?? '', name: input.name });
        if (!created.ok)
            return created;
        // Activate BEFORE the plan edit so `loadForEdit` finds it: the plan/policy
        // writers all operate on the ACTIVE horizon. Nothing can start yet — the
        // file created above carries the V1 default `advance: approve`.
        const activated = await activateRoadmap({ roadmapRef: created.roadmapRef });
        if (!activated.ok)
            return { ok: false, message: activated.message ?? 'The horizon was created but could not be activated.' };
        // A file write is not consent to spawn. Only `start: true` may unlock 'auto'.
        const advance = input.start === true ? validated.policy.advance ?? 'auto' : 'approve';
        const added = [];
        for (const step of input.steps ?? []) {
            const outcome = await addStep({ ref: step, actor: input.actor ?? 'automation' });
            if (!outcome.ok) {
                return {
                    ok: false,
                    message: `The horizon was created at ${created.roadmapRef}, but step "${step}" was rejected: ${outcome.message ?? 'unknown error'}. Fix the ref and add it with horizon.add_step.`,
                };
            }
            added.push(outcome.ref ?? step);
        }
        const configured = await configureHorizon({
            policy: { ...validated.policy, advance },
            actor: input.actor ?? 'automation',
        });
        if (!configured.ok)
            return { ok: false, message: configured.message ?? 'The horizon was created but its policy could not be written.' };
        return {
            ok: true,
            roadmapRef: created.roadmapRef,
            advance,
            steps: added,
            policy: configured.policy ?? { ...DEFAULT_ROADMAP_POLICY, advance },
        };
    }
    // Validate policy values against their enums so an agent cannot write a
    // frontmatter scalar the parser would silently drop. An unrecognised value is
    // an explicit error, never a quiet fallback to the default.
    function validateHorizonPolicy(policy) {
        const next = {};
        if (policy.advance !== undefined) {
            if (policy.advance !== 'approve' && policy.advance !== 'auto') {
                return { error: `advance must be "approve" or "auto", got "${String(policy.advance)}".` };
            }
            next.advance = policy.advance;
        }
        if (policy.merge !== undefined) {
            if (policy.merge !== 'manual' && policy.merge !== 'auto') {
                return { error: `merge must be "manual" or "auto", got "${String(policy.merge)}".` };
            }
            next.merge = policy.merge;
        }
        if (policy.concurrency !== undefined) {
            if (!Number.isInteger(policy.concurrency) || policy.concurrency < 1) {
                return { error: `concurrency must be a positive integer, got ${String(policy.concurrency)}.` };
            }
            next.concurrency = policy.concurrency;
        }
        if (policy.permissions !== undefined) {
            if (!isRoadmapPermissionPreset(policy.permissions)) {
                return { error: `permissions must be "default", "auto_workspace" or "bypass_all", got "${String(policy.permissions)}".` };
            }
            next.permissions = policy.permissions;
        }
        // Key PRESENCE clears the scalar (setRoadmapPolicy's contract), so an
        // explicitly-cleared roster must ride the diff as a present undefined.
        if ('roster' in policy)
            next.roster = policy.roster?.trim() ? policy.roster.trim() : undefined;
        return { policy: next };
    }
    // Lane-only steer for the agent surface: derive the instance roadmap ref so the
    // tool names only a lane, then forward to the same steer method the board IPC uses.
    async function steerLane(lane, action, actor, options = {}) {
        const entry = await loadActiveRoadmap();
        if (!entry)
            return { ok: false, message: 'No active roadmap is configured.' };
        switch (action) {
            case 'approve':
                return approveStart(entry.roadmapRef, lane, actor);
            case 'merge':
                return mergeLane(entry.roadmapRef, lane, actor);
            case 'pause':
                return pauseLane(entry.roadmapRef, lane, actor);
            case 'resume':
                return resumeLane(entry.roadmapRef, lane, actor, options);
        }
    }
    // Locate a stored (authored) entry ref across the lanes — the lane + position the
    // plan transforms address.
    function locateEntry(lanes, ref) {
        for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
            const entryIndex = lanes[laneIndex].entries.findIndex((entry) => entry.ref === ref);
            if (entryIndex >= 0)
                return { laneIndex, entryIndex };
        }
        return null;
    }
    // The lane index a new step lands in: a named track (rejected when absent), else the
    // last track — creating a first track when the plan has none. Mutates the draft when
    // it must add a track.
    function resolveLaneIndexForAdd(draft, laneTitle) {
        if (laneTitle) {
            const index = draft.lanes.findIndex((lane) => lane.title === laneTitle);
            if (index < 0)
                return { error: `No track named "${laneTitle}".` };
            return index;
        }
        if (draft.lanes.length === 0) {
            draft.lanes = addLane(draft.lanes);
            return 0;
        }
        return draft.lanes.length - 1;
    }
    // A friendly project display name for the board's per-step tag: the project root's
    // folder name (home = the home project's folder). The renderer surface has the real
    // workspace names; a basename is the honest main-side approximation.
    function projectDisplayName(entry, projectKey) {
        return basename(projectRootOf(entry, projectKey)) || (projectKey ?? 'this project');
    }
    // The per-lane runtime overlay the board builder reads, projected from the loaded
    // entry's persisted lane runtime (dropping the internal activeRepoId).
    function laneRuntimeViewMap(entry) {
        const map = new Map();
        for (const [lane, runtime] of entry.laneRuntimes) {
            map.set(lane, {
                lane,
                ...(runtime.activeItemRef ? { activeItemRef: runtime.activeItemRef } : {}),
                ...(runtime.activeTeamSlug ? { activeTeamSlug: runtime.activeTeamSlug } : {}),
                ...(runtime.activeStatePath ? { activeStatePath: runtime.activeStatePath } : {}),
                ...(runtime.activeRoster ? { activeRoster: runtime.activeRoster } : {}),
                ...(runtime.parked ? { parked: runtime.parked } : {}),
                ...(runtime.pendingApprovalRef ? { pendingApprovalRef: runtime.pendingApprovalRef } : {}),
            });
        }
        return map;
    }
    return {
        reconcile,
        approveStart,
        mergeLane,
        resumeLane,
        pauseLane,
        readRoadmapStates,
        readBoard,
        addStep,
        removeStep,
        reorderStep,
        skipStep,
        activateRoadmap,
        createRoadmap,
        deleteRoadmap,
        createHorizon,
        configureHorizon,
        steerLane,
    };
}
// The date prefix for a new roadmap file name (local date, matching the surface's
// author-facing filename convention). Derived from the injected clock so tests pin it.
function roadmapDatePrefix(now) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
// The single active roadmap: the newest roadmap-flagged file (highest backlog id,
// then the latest project-relative path, so date-prefixed filenames tiebreak
// chronologically). Deterministic so restart picks the same one.
function pickActiveRoadmap(candidates) {
    return [...candidates].sort((a, b) => {
        const idA = a.numericId ?? -1;
        const idB = b.numericId ?? -1;
        if (idA !== idB)
            return idB - idA;
        return b.relativePath.localeCompare(a.relativePath);
    })[0];
}
function normalizeRoot(root) {
    return root.replace(/\\/g, '/').replace(/\/+$/, '');
}
// What a merge-park says, in one line: which project, which branch, and the
// engine's own reason. Before MC-1909 a merge park carried only "a merge could not
// complete", which is unactionable on an unwatched horizon.
function mergeFailureDetail(outcome) {
    const target = outcome.repo && outcome.branch ? `${outcome.repo} (${outcome.branch})` : (outcome.repo ?? outcome.branch);
    const reason = outcome.message?.trim();
    if (target && reason)
        return `${target}: ${reason}`;
    return reason || (target ? `${target}: the merge was refused.` : 'The merge was refused.');
}
function parkedRuntime(runtime, reason, itemRef, detail, now) {
    const { pendingApprovalRef, ...rest } = runtime;
    return { ...rest, parked: { reason, itemRef, at: now.toISOString(), ...(detail ? { detail } : {}) } };
}
// A run is worth adopting into a lane only while it still holds the frontier:
// actively working, blocked on the human, or a worktree run whose PR has not yet
// merged. A completed+merged (or shared-completed) run has delivered.
function isAdoptable(snapshot) {
    if (snapshot.lifecycle === 'executing' || snapshot.lifecycle === 'needs_input_user')
        return true;
    if (snapshot.lifecycle === 'completed' && snapshot.mode === 'worktree') {
        return snapshot.prAllMerged !== true;
    }
    return false;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
