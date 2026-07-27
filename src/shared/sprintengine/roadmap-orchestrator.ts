// The roadmap orchestrator's decision core: a pure, node-free reducer that walks
// a parsed roadmap (MC-1618's substrate) plus the observed run/PR state and emits
// the ACTIONS a lane should take — start the next item, queue a "start next?"
// approval, merge a delivered PR, park the lane, or clear a finished run — along
// with the lane runtime state to persist.
//
// It is the sibling of the pool supervisor's planner (`auto-run.ts`): state in,
// actions out, no IO. The main-process driver (`src/main/roadmap-orchestrator.ts`)
// builds the inputs from disk (backlog + run projections + PR status), executes
// the actions through real effects, and persists the returned runtime — mirroring
// how `sprint-runtime.ts` drives `auto-run-cycle.ts`. Keeping the decisions here
// makes every park/advance/approve/concurrency rule exhaustively unit-testable
// without a running engine.
//
// Node-free by construction (tsconfig.web-safe): it imports only the T3 roadmap
// substrate and shared run constants, never `src/main` or renderer.

import {
  flattenLaneUnits,
  nextEligible,
  qualifiedRef,
  resolveEntryRoster,
  resolveEpicChildRef,
  type ProjectKey,
  type Roadmap,
  type RoadmapItemState,
  type RoadmapLane,
  type RoadmapRunState,
  type RoadmapLaneEligibility,
  type RoadmapUnitRef,
} from '../backlog/roadmap'

// Why a lane is parked. Machine-readable so the surface (MC-1620) can render a
// truthful "Paused" reason and a human decides whether to resume. A parked lane
// never advances on its own — resume is always a human action.
export type RoadmapParkReason =
  // The orchestrated run failed (an agent run ended in failure).
  | 'run_failed'
  // The orchestrated run was canceled (by a human or the engine).
  | 'run_canceled'
  // A task in the run is blocked on the human operator (needs_input kind=user).
  | 'needs_input'
  // The delivering pull request was closed without merging.
  | 'pr_closed'
  // An automatic merge attempt was refused or failed (conflict, out-of-order,
  // gh error). Set by the driver from the merge primitive's own verdict.
  | 'merge_failed'
  // Creating the sprint failed. Set by the driver when the creation flow errors.
  | 'start_failed'
  // The lane's frontier references a backlog item that no longer exists — an
  // authoring contradiction the orchestrator must not paper over.
  | 'eligibility_contradiction'
  // The lane's frontier uses a project alias whose path is not among the known
  // workspace roots — the instance cannot resolve it. Parks for a re-map (edit the
  // frontmatter `projects:` line), never a silent drop (Fallback Discipline, D2).
  | 'unknown_project'
  // A human paused the lane from the steering surface (MC-1620). Unlike every
  // reason above this is not a failure: resume continues the lane in place (it does
  // NOT abandon the running sprint or re-plan), so the reducer stops advancing the
  // lane while it holds but the live run keeps running in its own workspace.
  | 'paused'

// The lifecycle of an orchestrated run, derived by the driver from the run
// projection. Distinct from the raw task statuses: it is the coarse signal the
// orchestrator advances or parks on.
export type RoadmapRunLifecycle =
  // Tasks remain; work is in progress. The lane watches and does nothing.
  | 'executing'
  // A task is blocked on the human operator. The lane parks (needs_input).
  | 'needs_input_user'
  // Every task is done. For a shared run this means delivered; for a worktree
  // run the PR merge state decides whether the lane advances or waits.
  | 'completed'
  // The run failed. The lane parks (run_failed).
  | 'failed'
  // The run was canceled. The lane parks (run_canceled).
  | 'canceled'

// The driver's observation of the run currently linked to a lane's frontier
// item. Built fresh each reconcile from the run projection + PR status, so a run
// deleted out from under the orchestrator simply stops appearing (the lane then
// re-derives from eligibility). Keyed in `observations` by the unit's
// `qualifiedRef` (the same key the lane runtime's `activeItemRef` holds).
export type RoadmapRunObservation = {
  itemRef: string
  statePath: string
  teamSlug: string
  mode: 'worktree' | 'shared'
  lifecycle: RoadmapRunLifecycle
  // Worktree runs only: every declared repo's PR merged (rollup.allMerged).
  prAllMerged?: boolean
  // Worktree runs only: at least one declared repo's PR was closed unmerged.
  prClosedUnmerged?: boolean
  // The repo this run occupies for the concurrency guard (its primary repo id).
  repoId: string
}

// Persisted per-lane runtime — the only durable orchestrator state. Everything
// else re-derives from backlog + run records on restart (crash-safe by
// derivation). `activeItemRef` is the idempotency handle: a lane with an active
// ref adopts the existing run instead of starting a second.
export type RoadmapLaneRuntime = {
  lane: string
  // The unit's `qualifiedRef` whose run this lane is currently executing/watching,
  // if any — the identity that matches `observations` and eligibility units.
  activeItemRef?: string
  activeStatePath?: string
  activeTeamSlug?: string
  activeRepoId?: string
  // The saved-roster name the ACTIVE run was actually started with (MC-1883),
  // frozen at start. Distinct from `RoadmapPolicy.roster` and from the step's
  // `@roster=`, both of which the author can edit mid-flight: this is history,
  // not configuration. Undefined = started with the built-in default.
  //
  // RUN identity is `activeTeamSlug`; this is AGENT CONFIGURATION. Do not merge.
  activeRoster?: string
  // Set while parked. Cleared only by a human resume (a driver command).
  parked?: { reason: RoadmapParkReason; itemRef: string; at: string; detail?: string }
  // The eligible ref a "start next?" approval is outstanding for (advance:
  // approve). Cleared when the human approves (the ref joins `approvedRefs`) or
  // the frontier moves on.
  pendingApprovalRef?: string
}

// The action a lane should take this reconcile. The driver turns each into a
// real effect; `park`/`clear_active` are pure state transitions the reducer also
// reflects in the returned runtime, so a driver replaying actions and a driver
// trusting the returned runtime agree.
export type RoadmapOrchestratorAction =
  // Launch the shared plan-sourced creation flow for the target unit (worktree
  // mode, startRunner). `itemRef` is the raw ref (display); `projectKey` +
  // `relativePath` tell the driver which project root to start the run in and
  // which backlog file to source. The driver records the execution link + fans out
  // epic children.
  //
  // `roster` is the step's RESOLVED saved-roster name (MC-1883): the step's own
  // `@roster=` if it has one, else the roadmap's policy roster, else undefined
  // (the built-in No-roles default). Resolved HERE, where the unit and the policy
  // are both in hand, through the single `resolveEntryRoster` — the driver
  // forwards it and never re-derives the fallback, so what the board shows and
  // what the run is staffed with cannot drift.
  | { kind: 'start'; lane: string; itemRef: string; projectKey: ProjectKey; relativePath: string; roster?: string }
  // Raise a "start next?" approval for `itemRef` (advance: approve). Idempotent:
  // emitted once, then the lane waits until the ref is approved.
  | { kind: 'queue_approval'; lane: string; itemRef: string }
  // Merge the delivered PR(s) of the frontier run (merge: auto, PR not yet
  // merged). The driver calls the per-repo merge primitive, which enforces order
  // and is idempotent; a refusal parks the lane (merge_failed).
  | { kind: 'merge'; lane: string; itemRef: string; statePath: string }
  // Park the lane with a machine-readable reason and notify. Terminal until a
  // human resume.
  | { kind: 'park'; lane: string; reason: RoadmapParkReason; itemRef: string; detail?: string }
  // Drop the lane's active ref so the next reconcile advances to the following
  // unit. Two very different things end a lane's hold on a run and both land here,
  // so the action says which: `delivered` means the run DELIVERED (a shared run
  // completed, or a worktree run whose pull request(s) merged) and carries the run
  // that delivered it, which is what lets the driver record the step's backlog
  // items as completed (MC-1904). Without it the run simply vanished from
  // observations — nothing shipped, and nothing may be marked as if it had.
  | {
      kind: 'clear_active'
      lane: string
      itemRef?: string
      delivered?: boolean
      statePath?: string
      teamSlug?: string
    }

export type RoadmapReconcileInput = {
  roadmap: Roadmap
  // Every backlog item the roadmap's resolvable projects contain, each tagged with
  // its `projectKey` — the universe `nextEligible` resolves eligibility against.
  items: ReadonlyArray<RoadmapItemState>
  // The project keys the instance can map to a known workspace root (home = null
  // is always resolvable). A frontier whose project is absent parks
  // `unknown_project` rather than reading as a plain dangling ref (D2).
  resolvableProjects: ReadonlySet<ProjectKey>
  // Merge state per unit `qualifiedRef` for `nextEligible` (worktree → PR merged;
  // else terminal status). The driver derives this from run links + PR rollup.
  runLinks: ReadonlyMap<string, RoadmapRunState>
  // The driver's live observation of each lane's active run, keyed by the unit's
  // `qualifiedRef`.
  observations: ReadonlyMap<string, RoadmapRunObservation>
  // Persisted lane runtime from the last reconcile, keyed by lane title.
  laneRuntimes: ReadonlyMap<string, RoadmapLaneRuntime>
  // Unit `qualifiedRef`s the human has approved to start (advance: approve). A key
  // stays approved until its run starts; the driver drops it once activeItemRef is
  // set.
  approvedRefs: ReadonlySet<string>
  // Concurrency guard: true when the repo (a project root) already has an active
  // orchestrated run across ALL lanes. The driver computes it over the global set.
  repoBusy: (repoId: string) => boolean
  // The repo a unit's run occupies — its project root, so each project runs at
  // most one orchestrated sprint at a time. Used only for the concurrency guard.
  repoForLane: (lane: string, unit: RoadmapUnitRef) => string
  // ISO timestamp for park stamps (injected so the reducer stays pure).
  now: string
}

export type RoadmapReconcileResult = {
  actions: RoadmapOrchestratorAction[]
  laneRuntimes: Map<string, RoadmapLaneRuntime>
}

// Reconcile one roadmap: for every lane, decide the single action it should take
// and the runtime to persist. The reducer is deterministic and side-effect free;
// the same inputs always yield the same actions, which is what makes the driver's
// kill/restart idempotent.
export function reconcileRoadmap(input: RoadmapReconcileInput): RoadmapReconcileResult {
  const eligibilityByLane = new Map<string, RoadmapLaneEligibility>()
  for (const eligibility of nextEligible(input.roadmap, input.items, input.runLinks, input.resolvableProjects)) {
    eligibilityByLane.set(eligibility.lane, eligibility)
  }

  const actions: RoadmapOrchestratorAction[] = []
  const nextRuntimes = new Map<string, RoadmapLaneRuntime>()

  // Repos this reconcile has already committed to starting a sprint in. A lane
  // that claims a repo blocks a later lane in the same roadmap+repo from starting
  // a second sprint in the same pass — the concurrency guard applied within one
  // reconcile snapshot, on top of the driver's cross-roadmap `repoBusy`.
  const claimedRepos = new Set<string>()
  const repoBusy = (repoId: string): boolean => input.repoBusy(repoId) || claimedRepos.has(repoId)

  for (const lane of input.roadmap.lanes) {
    // Lane runtime is keyed by TRACK TITLE, so a plan edit that swaps a lane's
    // steps leaves the old handles behind: an active/parked/pending ref naming a
    // step no longer in this lane is an orphan — drop it, or the track stays
    // chained to a sprint for work the author deliberately removed (its run, if
    // still live, keeps running unmanaged; cancel it from the Sprints door).
    const previous = dropUnplannedHandles(lane, input.laneRuntimes.get(lane.title) ?? { lane: lane.title })
    const decision = reconcileLane({
      lane: lane.title,
      eligibility: eligibilityByLane.get(lane.title),
      runtime: previous,
      observations: input.observations,
      approvedRefs: input.approvedRefs,
      policy: input.roadmap.policy,
      repoBusy,
      repoForLane: input.repoForLane,
      now: input.now,
    })
    if (decision.action) actions.push(decision.action)
    if (decision.action?.kind === 'start' && decision.runtime.activeRepoId) {
      claimedRepos.add(decision.runtime.activeRepoId)
    }
    nextRuntimes.set(lane.title, decision.runtime)
  }

  return { actions, laneRuntimes: nextRuntimes }
}

// Every unit key this lane's CURRENT plan can legitimately reference — the
// entries themselves plus each epic entry's snapshotted members (a lane runtime
// persisted under the old per-child granularity holds a member key; that run
// still belongs to the planned step, so it must not read as an orphan).
function plannedKeysOf(lane: RoadmapLane): Set<string> {
  const planned = new Set<string>()
  for (const unit of flattenLaneUnits(lane)) {
    planned.add(unit.key)
    for (const child of unit.children) {
      const resolved = resolveEpicChildRef(child, unit.projectKey)
      planned.add(qualifiedRef(resolved.projectKey, resolved.relativePath))
    }
  }
  return planned
}

// Strip runtime handles that reference steps no longer in the lane's plan. A
// park stamped with no itemRef (a dangling/unknown-project park) is kept — we
// cannot tell which step it referenced, and resume is its documented exit.
function dropUnplannedHandles(lane: RoadmapLane, runtime: RoadmapLaneRuntime): RoadmapLaneRuntime {
  const planned = plannedKeysOf(lane)
  let next = runtime
  if (next.activeItemRef && !planned.has(next.activeItemRef)) {
    next = clearedActive(next)
  }
  if (next.parked?.itemRef && !planned.has(next.parked.itemRef)) {
    const { parked, ...rest } = next
    next = rest
  }
  if (next.pendingApprovalRef && !planned.has(next.pendingApprovalRef)) {
    next = clearPending(next)
  }
  return next
}

type LaneReconcileArgs = {
  lane: string
  eligibility: RoadmapLaneEligibility | undefined
  runtime: RoadmapLaneRuntime
  observations: ReadonlyMap<string, RoadmapRunObservation>
  approvedRefs: ReadonlySet<string>
  policy: Roadmap['policy']
  repoBusy: (repoId: string) => boolean
  repoForLane: (lane: string, unit: RoadmapUnitRef) => string
  now: string
}

type LaneDecision = { action: RoadmapOrchestratorAction | null; runtime: RoadmapLaneRuntime }

function reconcileLane(args: LaneReconcileArgs): LaneDecision {
  const { lane, runtime } = args

  // A parked lane is terminal until a human resume (a driver command clears
  // `parked`); the reconcile never auto-unparks. This is the "never retry a dead
  // run" guarantee.
  if (runtime.parked) {
    return { action: null, runtime }
  }

  // If a run is active for this lane, its lifecycle drives the decision. The
  // active ref is the idempotency handle: while it is set we watch that run and
  // never start another.
  if (runtime.activeItemRef) {
    const observation = args.observations.get(runtime.activeItemRef)
    if (observation) {
      return decideForActiveRun({ ...args, observation })
    }
    // The active run vanished from observations (deleted, or its store is gone).
    // Drop the handle and let the next reconcile re-derive from eligibility
    // rather than parking — a missing run is recoverable, a wrong conclusion is
    // not. Idempotent start will re-adopt or re-create as eligibility dictates.
    return { action: { kind: 'clear_active', lane }, runtime: clearedActive(runtime) }
  }

  return decideFromEligibility(args)
}

function decideForActiveRun(args: LaneReconcileArgs & { observation: RoadmapRunObservation }): LaneDecision {
  const { lane, runtime, observation } = args

  switch (observation.lifecycle) {
    case 'failed':
      return park(lane, runtime, 'run_failed', observation.itemRef, args.now)
    case 'canceled':
      return park(lane, runtime, 'run_canceled', observation.itemRef, args.now)
    case 'needs_input_user':
      // Keep the active handle: resume re-plans a NEW sprint from the same item
      // (T7), and the reason names the block. Parking with the handle intact lets
      // the surface point at the stuck run.
      return park(lane, runtime, 'needs_input', observation.itemRef, args.now)
    case 'executing':
      // Work in progress — watch, do nothing.
      return { action: null, runtime }
    case 'completed':
      return decideForCompletedRun(args)
    default:
      return { action: null, runtime }
  }
}

function decideForCompletedRun(args: LaneReconcileArgs & { observation: RoadmapRunObservation }): LaneDecision {
  const { lane, runtime, observation, policy } = args

  // A shared (non-worktree) run has no PR: completion IS delivery (MC-1439). The
  // frontier item is now terminal, so clear the handle and let the next reconcile
  // advance to the following unit.
  if (observation.mode === 'shared') {
    return { action: delivered(lane, observation), runtime: clearedActive(runtime) }
  }

  // Worktree run: the PR merge state decides.
  if (observation.prAllMerged) {
    return { action: delivered(lane, observation), runtime: clearedActive(runtime) }
  }
  if (observation.prClosedUnmerged) {
    return park(lane, runtime, 'pr_closed', observation.itemRef, args.now)
  }
  // Completed but awaiting merge. Auto-merge if the policy allows; otherwise the
  // lane waits on the human (the surface renders "Waiting on you"). The driver's
  // merge primitive enforces order and idempotency; a refusal parks merge_failed.
  if (policy.merge === 'auto') {
    return {
      action: { kind: 'merge', lane, itemRef: observation.itemRef, statePath: observation.statePath },
      runtime,
    }
  }
  return { action: null, runtime }
}

function decideFromEligibility(args: LaneReconcileArgs): LaneDecision {
  const { lane, runtime, eligibility, policy } = args
  if (!eligibility) {
    return { action: null, runtime }
  }

  switch (eligibility.reason) {
    case 'eligible': {
      const unit = eligibility.eligible
      if (unit === null) {
        // `eligible` always carries a unit; defensive only.
        return { action: null, runtime }
      }
      const repoId = args.repoForLane(lane, unit)
      // Concurrency guard: one active orchestrated sprint per repo (project root)
      // across ALL lanes. Wait rather than start a second sprint sharing a checkout.
      if (args.repoBusy(repoId)) {
        return { action: null, runtime }
      }
      const approved = policy.advance === 'auto' || args.approvedRefs.has(unit.key)
      if (approved) {
        // Optimistically claim the frontier so a concurrent lane in the same
        // reconcile sees the repo as busy; the driver fills in the run refs after
        // creation and clears the pending approval.
        //
        // The roster is FROZEN onto the runtime here, at start. A later edit to
        // the file's policy roster must not retroactively change what a running
        // step reports it was staffed with (MC-1883) — the board would otherwise
        // lie about a run nobody can restaff.
        const roster = resolveEntryRoster(unit, policy)
        return {
          action: {
            kind: 'start',
            lane,
            itemRef: unit.ref,
            projectKey: unit.projectKey,
            relativePath: unit.relativePath,
            ...(roster ? { roster } : {}),
          },
          runtime: {
            ...clearPending(runtime),
            activeItemRef: unit.key,
            activeRepoId: repoId,
            ...(roster ? { activeRoster: roster } : {}),
          },
        }
      }
      // advance: approve — raise the "start next?" gate once, then wait.
      if (runtime.pendingApprovalRef === unit.key) {
        return { action: null, runtime }
      }
      return {
        action: { kind: 'queue_approval', lane, itemRef: unit.ref },
        runtime: { ...runtime, pendingApprovalRef: unit.key },
      }
    }
    case 'dangling':
      // The frontier names an unknown backlog item — an authoring contradiction.
      return park(lane, runtime, 'eligibility_contradiction', eligibility.frontier?.key ?? '', args.now)
    case 'unknown_project':
      // The frontier's project alias is not resolvable to a known root — park for a
      // re-map (edit the frontmatter `projects:` line), never a silent drop (D2).
      return park(lane, runtime, 'unknown_project', eligibility.frontier?.key ?? '', args.now)
    case 'in_progress':
    case 'awaiting_merge':
    case 'blocked':
    case 'lane_complete':
    case 'empty':
    default:
      // Nothing to start: something is working, waiting on a merge we do not own,
      // blocked on prerequisites, or done. Clear a stale pending approval whose
      // key is no longer the eligible frontier.
      return { action: null, runtime: clearPendingIfStale(runtime, eligibility.eligible?.key ?? null) }
  }
}

// ---------------------------------------------------------------------------
// Runtime transitions
// ---------------------------------------------------------------------------

function park(
  lane: string,
  runtime: RoadmapLaneRuntime,
  reason: RoadmapParkReason,
  itemRef: string,
  now: string,
): LaneDecision {
  return {
    action: { kind: 'park', lane, reason, itemRef },
    runtime: { ...clearPending(runtime), parked: { reason, itemRef, at: now } },
  }
}

// The clear a DELIVERED run earns: it names the unit and the run that delivered
// it, so the driver can record the step's backlog items completed (MC-1904). The
// bare `clear_active` (a run that vanished from observations) deliberately carries
// none of this — nothing shipped there.
function delivered(lane: string, observation: RoadmapRunObservation): RoadmapOrchestratorAction {
  return {
    kind: 'clear_active',
    lane,
    itemRef: observation.itemRef,
    delivered: true,
    statePath: observation.statePath,
    teamSlug: observation.teamSlug,
  }
}

function clearedActive(runtime: RoadmapLaneRuntime): RoadmapLaneRuntime {
  // `activeRoster` is part of the ACTIVE handle and must clear with it — a lane
  // that has released its run would otherwise keep reporting the staffing of a
  // step that is no longer running.
  const { activeItemRef, activeStatePath, activeTeamSlug, activeRepoId, activeRoster, ...rest } = runtime
  return { ...rest }
}

function clearPending(runtime: RoadmapLaneRuntime): RoadmapLaneRuntime {
  const { pendingApprovalRef, ...rest } = runtime
  return { ...rest }
}

function clearPendingIfStale(runtime: RoadmapLaneRuntime, eligibleRef: string | null): RoadmapLaneRuntime {
  if (runtime.pendingApprovalRef && runtime.pendingApprovalRef !== eligibleRef) {
    return clearPending(runtime)
  }
  return runtime
}
