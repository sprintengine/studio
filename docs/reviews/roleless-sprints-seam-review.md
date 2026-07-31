# Seam review — the coordinator-seat contract across Python and TS

Sprint `roleless-sprints`, task T11. Audits the contracts *between* T1–T9, which
no single task's acceptance covers, and audits the delivered work against the
four explicit non-goals in `backlog/epics/roleless-sprints.md`.

**Verdict: changes requested.** The seat contract itself is sound — the Python
and TS seat resolvers agree on every case in an executed differential matrix,
including the legacy one — and no role-name literal survives in the four paths
the plan names (dispatch, wake, revival, bootstrap). But the epic's stated
failure mode, *a role-name literal deciding a routing question*, survives on two
paths the plan did not enumerate, and both of them only misbehave on the roleless
kind this epic makes the default:

- **F1** — a roleless run's `architect`-kind `needs_input` work is never triaged.
- **F2** — the wake path re-serialises ordinary work onto the roleless
  coordinator, which is the symptom MC-2050 exists to remove.

Eight findings below, F1–F8, none fixed here (this task's contract is audit, not
repair). Each carries severity, impact, the smallest fix, an owner role, and the
verification that would close it. F1, F2, F4, and F5 are the ones that change
behaviour on the default sprint kind.

---

## What was read, per seam

The audit is organised by the four seams the task names. Everything below was
read in source, not inferred from a task card.

| Seam | Python | TS | Verdict |
|---|---|---|---|
| The seat | `sprintengine_core/tool/plans.py:338` `resolve_coordinator_seat`, `:364` `actor_is_coordinator` | `src/shared/sprintengine/state.ts:1738` `sprintEngineCoordinatorSeat`, `:1779` `isSprintEngineCoordinatorAgent` | **Agree** — executed matrix, 8 seat cases × 8 actor ids, byte-identical |
| Absent on the wire | `sprintengine_core/store.py:776`/`:798-802`, `state.py:773` `worker_role` | `state.ts:1725` `role?`, `run-types.ts:741` (task) / `:560` (agent) | **Holds** — `''` never conflated with absent |
| `configuredRoles: []` | `state.py:175` `configured_role_set` | `state.ts:1741` | **Holds engine-side**; two app surfaces still read `[]` as unconfigured — **F6** |
| The coordination question | `plans.py:397` `task_is_coordination` | `state.ts:1756` `isSprintEngineCoordinationTask` | **Disagree** on 2 of 11 cases — **F3**; neither reads `role` or `kind` ✅ |

### The seat resolvers agree — executed, not argued

A differential harness ran both implementations over one shared matrix and
diffed the JSON. The Python half calls `resolve_coordinator_seat` /
`actor_is_coordinator` directly; the TS half is bundled with esbuild and calls
`sprintEngineCoordinatorSeat` / `isSprintEngineCoordinatorAgent`. Python's `None`
is normalised to TS's `undefined` at the boundary and nowhere else.

Seat cases, all agreeing:

| Case | `configuredRoles` | Both sides answer |
|---|---|---|
| architect run | `['architect','developer']` | `{role: architect, agentId: architect}` |
| roleless run | `[]` | `{role: absent, agentId: coordinator}` |
| specialists, no architect | `['developer','tester']` | `{role: absent, agentId: coordinator}` |
| legacy, key absent | *(no key)* | `{role: architect, agentId: architect}` |
| legacy, key not a list | `'architect'` | `{role: architect, agentId: architect}` |
| legacy, key null | `null` | `{role: architect, agentId: architect}` |
| whitespace-only roles | `['  ','']` | `{role: absent, agentId: coordinator}` |
| padded architect | `[' architect ']` | `{role: architect, agentId: architect}` |

`actor_is_coordinator` / `isSprintEngineCoordinatorAgent` were then asked the
same eight actor ids (`architect`, `architect-2`, `coordinator`, `agent-1`,
`developer-1`, `''`, `'  '`, `architectx`) against every seat case — 64
comparisons, all identical. The two id shapes that matter both behave: a named
seat answers for `architect-2`, and a minted roleless worker (`agent-1`) is
**never** mistaken for the roleless seat, which is the mistake that would have
made a worker read as the coordinator.

The three cases the acceptance names explicitly — a roleless run, an architect
run, and a legacy run with no `configuredRoles` — are rows 2, 1, and 4.

### Absent on the wire

Checked and holding on all four halves of the rule:

- **Omitted key in YAML.** `sync_state_to_store` (`store.py:776`) spreads the
  `role` key only when the task carries a non-empty one, and `configuredRoles` is
  written when non-`None` and `pop`ped otherwise (`:800-802`) — so an explicit
  `[]` survives a round trip and an absent key stays absent. This is the whole
  basis of the legacy/roleless distinction and it is correctly persisted.
- **`undefined` in TS.** `role?: SprintEngineRoleId` on both `SprintEngineTask`
  (`run-types.ts:741`) and `SprintEngineRuntimeAgent` (`:560`).
  `buildSprintEngineAgentRoster`
  (`state.ts:1913`) goes out of its way to emit `{id, label}` rather than
  `{id, label, role: undefined}`, with the reason stated in place.
- **`''` still means "could not establish".** `worker_role`
  (`state.py:773-813`) returns `''` for both "unknown" and "known to have none",
  and says so — it is display typing, never authority. The load-bearing part is
  that `is_roleless_agent_id` short-circuits *before* the minted-id guess, and
  that the guess reads `configured is None` rather than truthiness (`:805-806`),
  so a roleless run does not borrow the registry's role list. Correct.
- **No stand-in role anywhere.** `SPRINT_ENGINE_ROLELESS_KEY = '(roleless)'`
  (`state.ts:1708`) is documented as a map key only, and grep confirms it is
  never assigned to a `role` field.

### `configuredRoles: []` means one thing — engine-side

Every Python caller of `configured_role_set` tests `is None`, never truthiness:
`ensure_role_in_roster` (`state.py:215`), `worker_role` (`:805`), the product-gate
inference (`commands/run.py:416`), and both roster commands (`commands/roster.py:39`,
`:83`). `resolve_coordinator_seat`'s `or set()` (`plans.py:360`) is safe — it sits
behind an `isinstance(..., list)` guard, so the fallback and the empty set are the
same value — but it is the one place the file's own rule is written in the
forbidden shape. Not a defect; noted so a future edit does not read it as licence.

App-side, two surfaces still read `[]` as unconfigured — **F6**.

### The coordination question does not consult `role` or `kind`

Confirmed structurally and by execution. Python's `task_is_coordination` receives
a **task id**, not a task, so it cannot read either field. TS's
`isSprintEngineCoordinationTask` is typed `Pick<SprintEngineTask, 'id'>`; the
matrix passed it tasks deliberately wearing `role: 'architect'` and
`kind: 'integration_review'` and the answers were unchanged. The plan's claim
that the gate carries `kind: None` like ordinary work is borne out by the
predicate needing no exception for it.

They disagree on *which artifact counts* — **F3**.

---

## The four explicit non-goals

| Non-goal | Verdict | Evidence |
|---|---|---|
| Does not rename the `architect` `needs_input` wire value | **Held** | `VALID_NEEDS_INPUT_KINDS = {"architect","user"}` (`constants.py:48`) unchanged; `PLANNER_ROUTED_NEEDS_INPUT_KINDS = {"architect"}` (`:81`) unchanged; `LEGACY_NEEDS_INPUT_KIND_MAP = {"planner": "architect"}` still folds the alias inward; TS mirror `sprintEngineNeedsInputKinds = ['architect','user']` (`state.ts:703`) unchanged. `cmd_triage_needs_input` now resolves the seat instead of forcing the role, which changes *who resolves the lane*, not its name — exactly what the non-goal permits. |
| Does not give the roleless agent a persona | **Held in the engine, contradicted by the skill** | No `souls/general*` or `souls/coordinator*` exists — `souls/` holds no role files at all. `generic_role_swarm_prompt` (`prompts.py:134-153`) states no identity and says so in place. `coordinator_brief_block` (`plans.py:412-443`) is instructions, not character, and its docstring pins that. **But** the orchestration skill every roleless agent carries still describes the pre-epic pool — **F4**. That is a stale *model*, not a persona, so the non-goal itself holds. |
| Does not reopen reviewer coverage | **Held** | `VALID_TASK_PHASES` / `DEFAULT_RUN_PHASES` are still `("review",)`; the epic's diff touches neither. No reviewer role was added or restored; `resources/specialist-pack/` is unchanged by this epic. The roleless coordinator brief plans the final verification task as *ordinary work with its own owner, not coordination* (`plans.py:441-442`), which is the existing convention kept rather than a new gate. |
| Does not add a role-name literal anywhere in dispatch | **Held as written; defeated in spirit** | Nothing was **added**. `isSprintEnginePlanningRole` is deleted from both definitions (only a tombstone comment remains at `initial-spawns.ts:16`), and a line-scoped grep of dispatch, wake, revival, bootstrap, and `initial-spawns.ts` returns no `'architect'` / `'general'` literal. But two **pre-existing** literals on the coordinator-engagement surface were left live, and both fail only for a roleless seat — **F1**, **F5**. The KG sentence *"no role-name literal survives in dispatch, wake, revival, or bootstrap"* is true as scoped and should not be read as covering the whole surface. |

### The grep, and its output

```
$ grep -rn "isSprintEnginePlanningRole" --include="*.ts" --include="*.tsx" src/
src/shared/sprintengine/initial-spawns.ts:16:// `isSprintEnginePlanningRole` lived here and answered "may this agent start the
```

Line-scoped over the four named paths in `src/shared/sprintengine/auto-run.ts`
(dispatch 2330-2545, wake 540-600, revival 1195-1245, bootstrap 2000-2050) and
over `initial-spawns.ts` whole:

```
$ ... | grep -n "'architect'\|'general'"
-- dispatch    (no matches)
-- wake        (no matches)
-- revival     (no matches)
-- bootstrap   (no matches)
-- initial-spawns.ts  (no matches)
```

Python, both halves of the old model gone:

```
$ grep -rn "resolve_planning_role\|PLANNING_ROLE_IDS" --include="*.py" sprintengine_core/ sprintengine_mcp/ tests/
sprintengine_core/tool/state.py:171:# otherwise). There is deliberately no PLANNING_ROLE_IDS constant — it used to double
```

Widening the same grep past the four named paths is what surfaced F1 and F5:

```
$ grep -rn "role === 'architect'\|role: 'architect'" --include="*.ts" src/shared/sprintengine/ | grep -v '\.test\.'
state.ts:1742          seat resolution — CORRECT, this is the seat definition
state.ts:1744          seat resolution — CORRECT
agent-prompt.ts:65     commandMode fallback — see F8
agent-prompt.ts:185    architect-only prompt line — benign, copy for a named seat
auto-run.ts:1838       retirement skip                       — F1
auto-run-cycle.ts:1692 autonomousPlanningOverride            — F5
auto-run-cycle.ts:1985 triage engagement                     — F1
auto-run-cycle.ts:2058 triage spawn role                     — F1
auto-run-cycle.ts:2403 log-filter only                       — benign
```

---

## Findings

F1–F8 below are filed as run findings `T11-F1` … `T11-F8`, same numbering.

### F1 — A roleless run's architect-kind `needs_input` work is never triaged *(high)*

`signalPlannerForNeedsInputTriage` (`src/shared/sprintengine/auto-run-cycle.ts:1985`)
finds the agent to engage by role name:

```ts
const architect = roster.find((candidate) => candidate.role === 'architect')
if (!architect) return 'none'
```

A roleless run's roster carries no such row, so the function bails before it ever
asks the seat. Three sites compound it:

- `auto-run.ts:1838` — the idle-retirement skip is `runtimeAgent.role === 'architect'
  && hasArchitectTriageWork`, so the roleless coordinator is **not** protected from
  retirement while triage work is pending.
- `auto-run-cycle.ts:2058` — the triage spawn hardcodes `role: 'architect'`.
- `auto-run.ts:2175` — `buildArchitectNeedsInputTriagePrompt` hardcodes
  `{"id": "architect"}` as the triage tool payload, an id that does not exist on a
  roleless run. (Python's join-time directive, `commands/run.py:804`, interpolates
  the real `args.id` and is correct.)

**Impact.** A `needs_input` task carries an `ownerAgentId`, so
`isSprintEngineTaskLaunchable` is false for it and no dispatch, wake, or revival
path re-engages anyone. Once the coordinator's session ends — which F1's own
retirement gap makes likely — an `architect`-kind blocker on a roleless run is
**permanently stuck**. The only surviving route is a coordinator terminal that
happens to still be alive calling `task.next`, which returns the directive from
`commands/run.py:798`; that path correctly asks `actor_is_coordinator`.

**Confirmed by execution.** Probe over the real `buildSprintEngineAgentRosterForState`
and `getArchitectActionableNeedsInputTasks`:

```
roleless : roster [coordinator(role null), agent-1(role null)]
           architectActionableBlockers ["T4"]
           roster.find(role==='architect') -> null    triageWouldEngage false
architect: roster [architect(architect), developer-1(developer)]
           architectActionableBlockers ["T4"]
           roster.find(role==='architect') -> architect  triageWouldEngage true
```

**Provenance.** Pre-existing — a `general` run was equally invisible to this
guard. This epic does not introduce it; it promotes roleless to the default
sprint kind, which moves the gap onto the main path.

**Smallest fix.** Replace the role lookup with the seat, exactly as the other
four paths now do:

```ts
const seat = sprintEngineCoordinatorSeat(sprintEngineState)
const coordinator =
  roster.find((c) => c.id === seat.agentId)
  ?? roster.find((c) => isSprintEngineCoordinatorAgent(c.id, sprintEngineState))
```

Pass `role: seat.role` (not the literal) at `:2058`, thread the resolved agent id
into `buildArchitectNeedsInputTriagePrompt` instead of hardcoding `architect`, and
change `auto-run.ts:1838` to `isSprintEngineCoordinatorAgent(agentId, sprintEngineState)`.

**Owner.** `developer` (this is `auto-run-cycle.ts` / `auto-run.ts`, T4's surface).

**Verification.** A test asserting that a roleless run with one
`needsInput.kind: 'architect'` task plans a triage engagement targeting
`coordinator`, and that the coordinator is not retired while that task is
pending; plus the unchanged architect-run assertions.

---

### F2 — The routing rule is not applied on the wake path *(high)*

Dispatch asks `sprintEngineTaskRoutesToCoordinator`. Wake asks
`findSprintEngineWakeCandidateTaskForAgent` (`auto-run.ts:572`), which matches on
`candidate.role === role`, together with `sprintEngineWakeRestrictionTaskId`
(`:562`), which returns `null` — unrestricted — for the coordinator seat.

On a role-based run those two agree by construction: the seat's role is
`architect`, so role equality offers it exactly the architect work the routing
rule's second clause also routes to it. On a **roleless** run the coordinator and
every work task both carry *no* role, so `absent === absent` matches and the
unrestricted coordinator is offered ordinary work.

**Impact.** This is the epic's own failure mode returning through a second door:
work re-serialises onto the one persistent coordinator session, and that session
accumulates cross-task context — precisely what MC-1444 removed and what
`sprintEngineWakeRestrictionTaskId`'s own comment says it is guarding against for
*workers*. It is milder than the original MC-2050 bug (dispatch still fans out
concurrently), but it directly contradicts the epic's *"an unnamed [coordinator]
owns only the coordination job"*.

**Confirmed by execution.** Probe against the real functions, with the
architect-run contrast:

```
roleless : dispatch T1 routes to coordinator? false
           wake restriction: null   wake offers coordinator: "T1"   -> DIVERGENCE
architect: dispatch developer T1 routes to coordinator? false
           wake offers architect developer-T1: null                 -> agrees
```

**Provenance.** Introduced in effect by this epic: before it, a roleless run's
agents shared the role `general`, so the same code produced the same result but
that *was* the (broken) intended behaviour. Now dispatch and wake give different
answers to one question.

**Smallest fix.** In `sprintEngineWakeRestrictionTaskId`, return `null` only for a
seat whose role is **named**; a roleless coordinator should be restricted to
`lastOwnedTaskId` like any other agent. Equivalently, filter wake candidates for
the coordinator through `sprintEngineTaskRoutesToCoordinator` so one rule answers
on both paths.

**Owner.** `developer`.

**Verification.** Assert that on a roleless run an idle coordinator is offered no
wake candidate for an unowned ordinary task, and that an architect run's wake
behaviour is byte-identical to before.

---

### F3 — The two coordination-task predicates disagree *(medium)*

Python's `task_is_coordination` (`plans.py:397`) delegates to `find_plan_artifact`
(`:381`), which requires three things: `kind == 'architect_plan'`, `status !=
'superseded'`, **and** that the artifact's `path` resolves to the run's own
`plan.md`. TS's `isSprintEngineCoordinationTask` (`state.ts:1756`) checks only the
first two plus the `taskId` binding — the path condition is absent, matching the
plan's Decision 4 expression verbatim.

**Impact.** `kind: 'architect_plan'` is registrable by any agent through
`sprintengine.artifact.add` against any path, with no uniqueness constraint, and
`prompts.py:397` tells agents to use that kind for plan-approval work. A second
non-superseded `architect_plan` bound to a different task therefore makes the app
treat that task as coordination — routing it to the persistent seat and rendering
it as coordination on the board — while the engine does not. One question, two
answers, which is the failure this task exists to catch.

**Confirmed by execution.** Of the 11 coordination cases in the shared matrix, 9
agree and 2 diverge, both of them the path probe:

```
plan_kind_other_path : python false | ts true
two_plan_artifacts   : python false | ts true
```

The app-side artifact record does carry `path` (`SprintEngineArtifact.path` is
required, `run-types.ts:217`; populated at `src/main/sprintengine-artifacts.ts:988`),
so TS can apply the same condition — it simply does not.

**Smallest fix.** Add the path condition to the TS predicate, comparing against
the run's `plan.md` the way Python does. If deriving the plan path app-side is
unwanted, the alternative is to enforce one live `architect_plan` per run at
`artifact.add`; that is a larger change and should be an owner call.

**Owner.** `developer` (T3's surface, `src/shared/sprintengine/state.ts`).

**Verification.** Extend the differential matrix in this review to a permanent
test so the two predicates cannot drift again.

---

### F4 — The roleless orchestration skill still describes the pre-epic pool *(medium)*

`resources/sprintengine/skills/sprintengine_roleless_workflow/SKILL.md` was
**renamed** from `sprintengine_general_workflow` in T2 and its copy de-`General`-ed,
but its model was not re-authored. It still says:

- *"It is a pool: every agent shares one task graph and takes work by claiming it;
  **nothing is assigned**."*
- *"when the run needs a plan, **create the tasks yourself, then self-approve the
  plan artifact**."*

`SPRINTENGINE_ROLELESS_SKILLS` (`sprintengine_core/skill_layers.py:63`) hands this
to **every** roleless agent — the coordinator and every task-scoped worker alike.

**Impact.** Three ways it now contradicts the run it describes. (a) Work *is*
assigned: MC-2050 mints a task-scoped agent per task and dispatches to it. (b)
Planning and plan self-approval belong to the coordinator seat, and MC-2054 gave
the coordinator its own brief saying so — so two prompt layers now claim the same
behaviour, against the standing one-behaviour-one-layer policy. (c) A task-scoped
worker is told *"the pool does the whole job itself"*, which invites it to take on
cross-cutting work outside its task.

The immediate hazard is bounded — by the time workers are dispatched, a plan
exists — but the skill misdescribes the product's new default sprint kind to
every agent running it.

**Smallest fix.** Re-author the skill against the epic's model: one agent holds
the coordination job and produces the plan; every other task gets its own agent
that owns it claim-to-done; delete the planning and self-approval instructions
now owned by `coordinator_brief_block`.

**Owner.** `architect` — this is a prompt-layer ownership decision, not a
mechanical edit.

**Verification.** Read the rendered roleless join prompt for both a coordinator
and a task-scoped worker and confirm neither is told to plan unless it holds the
seat.

---

### F5 — A roleless run loses the Autonomous Planning Override *(medium)*

`auto-run-cycle.ts:1692`:

```ts
autonomousPlanningOverride: nextRun.role === 'architect' && sprintEngineArtifactApprovalDesired(autoState),
```

**Impact.** Under the *Run agents + approve artifacts* automation mode the block
at `agent-prompt.ts:189-196` is what tells the planning agent to proceed with
conservative defaults instead of pausing for plan-review questions. A roleless
coordinator never receives it, so the epic's new default sprint kind is the one
kind that cannot plan autonomously — it will stop and ask on exactly the
questions the mode exists to suppress.

**Provenance.** Pre-existing literal; newly load-bearing because the roleless
coordinator is now a real planning seat rather than a stand-in role.

**Smallest fix.** Gate on the seat:
`isSprintEngineCoordinatorAgent(nextRun.agentId, sprintEngineState) && sprintEngineArtifactApprovalDesired(autoState)`.

**Owner.** `developer`.

**Verification.** Assert the override block is present in the startup prompt of a
roleless run's coordinator under artifact-approval automation, and absent for a
task-scoped worker.

---

### F6 — `configuredRoles: []` is still read as unconfigured in two app surfaces *(low)*

The acceptance asks explicitly whether `[]` is read anywhere as
legacy/unconfigured after T2. Engine-side it is not. App-side, two reads remain:

- `src/renderer/src/components/panels/SprintEngineBoardPanel.tsx:662` —
  `canMutateRunRoster` requires `(configuredRoles?.length ?? 0) > 0`. Its comment
  reads *"a run that publishes no configured role set"*, but a roleless run
  publishes an explicit empty one. **Impact:** on a door mount with no resident
  workspace, a roleless run offers no roster mutation at all — a user cannot add a
  role to it. **Fix:** test presence (`Array.isArray(configuredRoles)`), not length.
- `src/renderer/src/components/panels/sprintEngineBoard/SprintEngineRosterView.tsx:312`
  — `configuredRoles.length > 0 ? configuredRoles : sprintEngineEnabledRoles(roleCounts)`.
  **Benign in practice**: a roleless run's `roleCounts` is `{}` so the fallback
  yields `[]` too, and the roleless group is excluded from role bands anyway
  (`:322`). Recorded because it is the same conflation and will bite if the
  fallback ever changes.

**Owner.** `frontend`. **Verification.** Mount a roleless run through the door and
confirm the roster can be mutated.

---

### F7 — A roleless run inits with `rosterConfigured: false` *(low)*

`sprintEngineInitArgs` (`src/main/sprintengine-artifacts.ts:588-592`) emits one
`--agent <role>:<id>` per seeded agent **only when the agent has a non-empty
role**. A roleless run seeds exactly one seat and it has no role, so **no
`--agent` reaches init**, and `commands/run.py:217`/`:333` set
`rosterConfigured = bool(args.agent)` (with `:346` flipping it true only when
`args.agent` is non-empty) → `false`.

This defeats a stated intent elsewhere: `buildSprintEngineRosterCommandArgs`
(`state.ts:2147`) deliberately emits `':coordinator'` with an empty prefix, with a
comment saying it does so *"so the run still records `rosterConfigured` exactly as
it does today"* — but that function feeds startup-prompt `rosterArgs`, and a
roleless coordinator is always in `join` mode, so its output never reaches an
`init` call. The two paths disagree about how a roleless seat crosses the wire.

**Impact.** Small and app-side only: engine-side the single consumer
(`commands/run.py:425`) sits in a branch a roleless run never reaches.
App-side it compounds F6's door-mount gate and mislabels the board button
(`SprintEngineBoardPanel.tsx:3293` renders *"Spawn a team agent"* instead of
*"Add an agent"*). Also note `buildSprintEngineRosterCommandArgs` returns `[]`
whenever `rosterConfigured` is false, so the roleless seat's `:coordinator` form
is unreachable in both directions.

**Smallest fix.** Emit `--agent :<agentId>` for a roleless seat in
`sprintEngineInitArgs`, matching `buildSprintEngineRosterCommandArgs`; or, if the
empty-prefix form is unwanted on the wire, delete it from
`buildSprintEngineRosterCommandArgs` and set `rosterConfigured` from
`configuredRoles` presence instead.

**Owner.** `developer`. **Verification.** Create a roleless run and assert
`run.yaml` records `rosterConfigured: true`.

---

### F8 — At most one task per run can be a coordination task *(medium, open question)*

`task_is_coordination` / `isSprintEngineCoordinationTask` answer true only for the
task the live `architect_plan` artifact binds to. Combined with the routing rule's
second clause being dead on a roleless run (`seat.role === undefined`), **exactly
one task in a roleless run ever routes to the coordinator.**

This is in tension with three places that assume plural:

- The epic's roleless bullet says the coordinating agent *"adjudicates the plan gate,
  triages blocked work, **signs off**"*. A sign-off task in a roleless run carries
  no role and is not plan-bound, so it dispatches to a fresh `agent-N` with none of
  the run's context.
- The routing-rule section says *"Only coordination task**s** reach it"*.
- `auto-run.ts:1205-1207` says revival *"keeps the id stable **across sequential
  coordination tasks**"* — a scenario the roleless predicate cannot produce.

**On the implementation note this task was given.** MC-1454 *does* still hold, and
was verified rather than assumed: on a role-based run every architect task routes
to the one warm architect seat (matrix row 1 plus the wake contrast in F2), and on
a roleless run it holds **vacuously**, because there is never a second coordination
task for the id to be stable across. The asymmetry in the routing rule is
implemented exactly as designed and is **not** reported as a defect — it is
correct and the code states its reasoning in place.

What is unresolved is narrower: whether the epic's *"signs off"* responsibility is
meant to reach the coordinator, and if so what marks that task as coordination.

**Recommended resolution.** An owner/architect ruling, not a code fix invented
here. Either (a) accept that a roleless run has exactly one coordination task and
correct the epic's and `auto-run.ts:1205`'s plural wording, or (b) introduce an
explicit coordination marker on the task so sign-off can carry it — noting the
plan deliberately rejected `kind` for this purpose because the gate carries none.

**Owner.** `architect`.

---

## Knowledge Graph

Configured at `knowledge/`. Six notes were updated by this epic
(`sprint-engine.md`, `-leases`, `-lifecycle`, `-mcp`, `-renderer`,
`workspace-shell.md`). Spot-checked against source: the schema-5 migration
description, the seat/`actor_is_coordinator` contract, the roleless gate copy and
brief, the app-side mirror including the `SPRINT_ENGINE_ROLELESS_KEY` and
`protectedSprintEngineRoleId` deletions — all accurate. **No KG gap is filed.**

One wording note for whoever fixes F1: `sprint-engine.md:61` says *"no role-name
literal survives in dispatch, wake, revival, or bootstrap"*. That is true as
scoped, and this review does not contradict it — but it should not be extended to
the coordinator-engagement surface, where F1 and F5 live. Worth a clause once
those land.

## Residual risk and what this review did not verify

- **T10's executed proof is not in evidence.** T11 does not depend on T10, and at
  review time T10 was still `in_progress` with an empty evidence record, so the
  epic's other review half — dispatch-ledger assertions for a roleless run, a
  role-based run, and a migrated store — is **unverified by this audit**. Every
  behavioural claim above rests on this review's own probes, not on T10.
- **No live sprint was run.** All divergence findings are executed against the
  real functions with synthesised state, not observed in `dispatch.jsonl`. F1 and
  F2 in particular predict runtime behaviour from the planner's inputs.
- **Not audited:** the wizard's chosen shape (the user's pick at T6), surface
  rendering beyond confirming no role literal reaches routing, and the migration
  itself (T2/T10's ground).

## Reproducing the executed checks

The three harnesses are throwaway and were not committed. Each is a few dozen
lines and is reconstructible from what is described above:

1. **Seat/coordination differential** — call `resolve_coordinator_seat`,
   `actor_is_coordinator`, `task_is_coordination` over the 8 seat cases, 8 actor
   ids, and 11 coordination cases tabulated above; dump sorted JSON. Bundle a TS
   twin over the same matrix with `esbuild --bundle --platform=node --format=cjs
   --packages=external`, normalising Python `None` to `undefined`. `diff` the two.
   Expected today: identical except `plan_kind_other_path` and
   `two_plan_artifacts`.
2. **Triage precondition** — `buildSprintEngineAgentRosterForState` +
   `getArchitectActionableNeedsInputTasks` on a roleless state with one
   `needsInput.kind: 'architect'` task; assert `roster.find(c => c.role ===
   'architect')` is undefined while blockers is non-empty.
3. **Wake divergence** — `sprintEngineTaskRoutesToCoordinator` vs
   `findSprintEngineWakeCandidateTaskForAgent` +
   `sprintEngineWakeRestrictionTaskId` for the `coordinator` id on a roleless run
   with one ready unowned roleless task; assert they disagree, and that the
   architect-run equivalent agrees.

Turning harness 1 into a permanent test is the recommended follow-up to F3.
