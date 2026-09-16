from __future__ import annotations
import json
import re
from pathlib import Path

from helpers import (
    assert_artifact_status,
    assert_board_column,
    assert_event_type,
    assert_task_status,
    create_team,
    get_artifact,
    get_task,
    read_state,
    task,
    write_state,
)


APPROVED_AUTO_APPROVAL_KINDS = {
    "architect_plan",
    "branding",
    "code_review",
    "cross_platform_review",
    "design_notes",
    "html_mockup",
    "performance_review",
    "production_readiness_review",
    "product_strategy",
    "requirements",
    "security_review",
    "spec_review",
    "validation_report",
}


def write_team_file(fixture, relative_path: str, content: str = "# Artifact\n") -> None:
    path = fixture.team_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def add_ready_artifact(fixture, artifact_id: str, task_id: str, kind: str, path: str, title: str) -> None:
    write_team_file(fixture, path)
    fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "producer",
        "--artifact-id",
        artifact_id,
        "--task-id",
        task_id,
        "--kind",
        kind,
        "--title",
        title,
        "--path",
        path,
        "--created-by",
        "producer",
        "--ready",
    )


def collect_fixture_auto_approval_intents(fixture, enabled: bool) -> list[str]:
    if not enabled:
        return []

    artifact_ids: list[str] = []
    state = read_state(fixture.state_path)
    for artifact in state["artifacts"]:
        task_record = next(task_record for task_record in state["tasks"] if task_record["id"] == artifact["taskId"])
        if (
            artifact["kind"] in APPROVED_AUTO_APPROVAL_KINDS
            and artifact["status"] in {"ready_for_review", "changes_requested"}
            and artifact["path"].strip()
            and str(task_record.get("ownerAgentId") or "").strip()
        ):
            artifact_ids.append(artifact["id"])
    return artifact_ids


def test_auto_approval_disabled_leaves_ready_artifacts_waiting(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-disabled",
        [
            task("T1", "Requirements gate", "product", "in_progress", owner="product-fixture"),
            task("T2", "Implementation", "developer", "todo", depends_on=["T1"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    intents = collect_fixture_auto_approval_intents(fixture, enabled=False)

    state = read_state(fixture.state_path)
    assert intents == []
    assert_artifact_status(state, "A1", "ready_for_review")
    assert_task_status(state, "T1", "needs_input")
    assert_board_column(state, "T2", "todo")


def test_auto_approval_selector_finds_ready_artifact_without_terminal_requirements(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-enabled",
        [
            task("T1", "Requirements gate", "product", "in_progress", owner="product-fixture"),
            task("T2", "Implementation", "developer", "todo", depends_on=["T1"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    intents = collect_fixture_auto_approval_intents(fixture, enabled=True)

    state = read_state(fixture.state_path)
    artifact = get_artifact(state, "A1")
    assert intents == ["A1"]
    assert_artifact_status(state, "A1", "ready_for_review")
    assert "approvedBy" not in artifact
    assert not any(entry["action"] == "approved" for entry in artifact["reviewHistory"])
    assert_task_status(state, "T1", "needs_input")
    assert_board_column(state, "T2", "todo")


def test_artifact_approval_mutates_state_events_and_projection(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-uses-sprintengine-state",
        [
            task("T1", "Requirements gate", "product", "in_progress", owner="product-fixture"),
            task("T2", "Implementation", "developer", "todo", depends_on=["T1"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")

    state = read_state(fixture.state_path)
    projection = json.loads((fixture.team_dir / "projection.json").read_text(encoding="utf-8"))
    artifact = get_artifact(state, "A1")
    assert approved["ok"] is True
    assert_artifact_status(state, "A1", "approved")
    assert artifact["approvedBy"] == "user"
    assert any(entry["action"] == "approved" for entry in artifact["reviewHistory"])
    assert_task_status(state, "T1", "done")
    assert_board_column(state, "T2", "ready")
    assert_event_type(state, "artifact_approved")
    assert_event_type(state, "agent_notification_requested")
    projection_artifact = next(candidate for candidate in projection["artifacts"] if candidate["id"] == "A1")
    projection_task = next(candidate for candidate in projection["tasks"] if candidate["id"] == "T1")
    assert projection_artifact["status"] == "approved"
    assert projection_task["status"] == "done"


def test_artifact_request_changes_records_rework_before_owner_wakeup(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "artifact-request-changes-rework-state",
        [
            task("T1", "Requirements gate", "product", "needs_input", owner="product-fixture"),
            task("T2", "Implementation", "developer", "todo", depends_on=["T1"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    requested = fixture.cli.run(
        "artifact",
        "request-changes",
        "--artifact-id",
        "A1",
        "--id",
        "user",
        "--feedback",
        "Tighten acceptance criteria before implementation.",
    )

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    notification = next(event for event in state["events"] if event.get("type") == "agent_notification_requested")
    assert requested["ok"] is True
    assert_artifact_status(state, "A1", "changes_requested")
    assert_task_status(state, "T1", "in_progress")
    # Feedback is captured as a comment so author/timestamp/body land in the
    # activity feed and the open_feedback queue.
    assert task_record["notes"] == []
    assert any(
        comment["type"] == "review_feedback"
        and "Tighten acceptance criteria" in comment["body"]
        and comment.get("data", {}).get("artifactId") == "A1"
        for comment in task_record["comments"]
    )
    assert notification["targetAgentId"] == "product-fixture"
    assert notification["notificationKind"] == "task_changes_requested_after_artifact_review"
    assert_event_type(state, "artifact_changes_requested")


def test_artifact_request_changes_uses_architect_feedback_when_actor_is_architect(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "artifact-request-changes-architect",
        [task("T1", "Requirements gate", "product", "needs_input", owner="product-fixture")],
    )
    state = read_state(fixture.state_path)
    state["agents"] = {
        "architect-fixture": {"role": "architect", "status": "idle", "currentTaskId": None},
        "product-fixture": {"role": "product", "status": "idle", "currentTaskId": "T1"},
    }
    write_state(fixture.state_path, state)
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")

    fixture.cli.run(
        "artifact",
        "request-changes",
        "--artifact-id",
        "A1",
        "--id",
        "architect-fixture",
        "--feedback",
        "Scope is wider than the current sprint allows.",
    )

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert any(
        comment["type"] == "architect_feedback"
        and "wider than the current sprint" in comment["body"]
        and comment["authorRole"] == "architect"
        for comment in task_record["comments"]
    )


def test_auto_approval_policy_allows_only_approved_artifact_kinds(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "auto-approval-kind-policy",
        [
            task("T1", "Code review gate", "security", "needs_input", owner="code-reviewer-fixture"),
            task("T2", "Unknown review gate", "tester", "needs_input", owner="tester-fixture"),
        ],
    )
    write_team_file(fixture, "code-review.md")
    write_team_file(fixture, "future-review.md")
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Code Review",
            "path": "code-review.md",
            "status": "ready_for_review",
            "createdBy": "code-reviewer-fixture",
            "taskId": "T1",
            "reviewHistory": [],
            "recommendedTasks": [],
        },
        {
            "id": "A2",
            "kind": "future_review",
            "title": "Future Review",
            "path": "future-review.md",
            "status": "ready_for_review",
            "createdBy": "tester-fixture",
            "taskId": "T2",
            "reviewHistory": [],
            "recommendedTasks": [],
        },
    ]
    write_state(fixture.state_path, state)

    assert collect_fixture_auto_approval_intents(fixture, enabled=True) == ["A1"]


def test_renderer_auto_approval_policy_matches_approved_artifact_kinds() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    # The review-gate vocabulary lives in the shared Sprint Engine state module
    # (consumed by both the renderer and the main-process reconciler).
    shared_state_source = (repo_root / "src/shared/sprintengine/state.ts").read_text(encoding="utf-8")
    match = re.search(r"const reviewGateArtifactKinds: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)", shared_state_source)
    assert match, "shared reviewGateArtifactKinds declaration not found"

    shared_kinds = set(re.findall(r"'([^']+)'", match.group(1)))
    assert shared_kinds == APPROVED_AUTO_APPROVAL_KINDS

    # The same vocabulary is duplicated in the python store contract and the
    # main-process auto-approval gate; drift in any copy silently breaks
    # artifact review for kinds the other layers accept.
    from sprintengine_core.tool.constants import VALID_ARTIFACT_KINDS

    assert VALID_ARTIFACT_KINDS == APPROVED_AUTO_APPROVAL_KINDS

    main_source = (repo_root / "src/main/sprintengine-artifacts.ts").read_text(encoding="utf-8")
    main_match = re.search(r"const autoApprovableArtifactKinds = new Set\(\[([\s\S]*?)\]\)", main_source)
    assert main_match, "main-process autoApprovableArtifactKinds declaration not found"
    assert set(re.findall(r"'([^']+)'", main_match.group(1))) == APPROVED_AUTO_APPROVAL_KINDS


def test_electron_auto_run_approves_through_sprint_engine_not_terminal() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    # The supervisor moved to the main-process reconciler: the shared cycle
    # decides, the main scheduler binds its ports (sprint-runtime-ownership).
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")
    runtime_source = (repo_root / "src/main/sprint-runtime.ts").read_text(encoding="utf-8")
    artifacts_source = (repo_root / "src/main/sprintengine-artifacts.ts").read_text(encoding="utf-8")

    # The cycle must not push approval through the agent terminal; it routes
    # auto-approval through the executor port surface.
    assert "sendArtifactApprovalToTerminal" not in cycle_source
    assert "Sent the user approval intent to the responsible agent terminal." not in cycle_source
    assert "ports.autoApproveSprintEngineArtifact(statePath, artifact.id)" in cycle_source
    assert "Artifact auto-approved through the sprint" in cycle_source
    # The main process is the only host that binds the port now: the renderer
    # auto-run shims were deleted on 2026-09-08 (nothing in the app imported
    # them), so `src/main/sprint-runtime.ts` is the single binding site.
    assert "autoApproveSprintEngineArtifact: (statePath, artifactId) =>" in runtime_source
    assert "deps.artifacts.autoApproveArtifact({ statePath, artifactId })" in runtime_source
    assert "action: 'approve-intent'" not in artifacts_source
    assert "await assertAutoApprovalAllowed(state, artifactId)" in artifacts_source
    assert "sprintengine.artifact.approve" in artifacts_source


def test_sprintengine_auto_approval_marks_architect_startup_as_autonomous() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")
    prompt_source = (repo_root / "src/shared/sprintengine/agent-prompt.ts").read_text(encoding="utf-8")
    terminal_view_source = (repo_root / "src/renderer/src/components/panels/TerminalView.tsx").read_text(encoding="utf-8")

    # Both spawn paths derive the override from the automation helpers instead
    # of reading autoApproveArtifacts directly: the reconciler's spawn path and
    # the manual TerminalView launch.
    # The reconciler asks the SEAT, not the role name (MC-2057): a roleless
    # coordinator is the planning seat of the default sprint kind, and under the
    # role comparison it was the one kind that never received the override.
    assert (
        "isSprintEngineCoordinatorAgent(nextRun.agentId, sprintEngineState)\n"
        "          && sprintEngineArtifactApprovalDesired(autoState)"
    ) in cycle_source
    assert "rosterAgent.role === 'architect'" in terminal_view_source
    assert (
        "deriveSprintEngineAutomationDesiredMode(workspace.sprintEngineAutoState) === 'run_agents_and_approve_artifacts'"
        in terminal_view_source
    )
    assert "## Autonomous Planning Override" in prompt_source
    # The MCP-only prompt rewrite reframed the trigger as the automation mode
    # name (still semantically "Approve all artifacts is on") and described the
    # division of responsibility between agent automation and artifact approval.
    assert "Sprint automation mode is Run agents + approve artifacts" in prompt_source
    assert "Agent automation controls spawning; artifact approval automation is the signal to skip normal grilling." in prompt_source
    assert "Do not pause for ordinary preference, naming, scope-shaping, or plan-review questions" in prompt_source


def test_electron_auto_run_prompts_idle_running_agents_for_ready_work() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")
    planner_source = (repo_root / "src/shared/sprintengine/auto-run.ts").read_text(encoding="utf-8")

    assert "function sendContinuationPromptsToIdleAgents" in cycle_source
    # Reconciler: every re-engagement decision (wake, dispatch, restart,
    # respawn, retirement) lives in the pure planner; the cycle only executes
    # the plan.
    assert "planSprintEngineDispatch" in cycle_source
    assert "buildSprintEngineContinuationPrompt(task, agentId)" in planner_source
    assert "Sprint Engine roster runner found a wake candidate for a ready" in planner_source
    # Claim-first dispatch: the continuation prompt hands the agent the claim
    # tool directly; the directive hop is headless-CLI only and must not
    # appear in supervisor prompt sources.
    assert "sprintengine.task.next" in planner_source
    assert "sprintengine.agent.next_directive" not in planner_source
    assert "sprintengine join --role" not in planner_source, (
        "MCP-native autonomous prompts must not embed `sprintengine join` CLI invocations."
    )
    # One all-paths reconcile call per supervise cycle; the per-path wrappers
    # (sendContinuationPromptsToIdleAgents and friends) are test-surface shims.
    assert "paths: ['notification', 'dispatch', 'task_wake', 'active_assignment', 'restart', 'respawn', 'idle_retire']" in cycle_source
    assert "continuation-prompt-sent" in planner_source


def test_sprintengine_agent_prompts_do_not_continue_polling_after_claim() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    prompt_sources = [
        (repo_root / "src/shared/sprintengine/agent-prompt.ts").read_text(encoding="utf-8"),
        (repo_root / "src/shared/sprintengine/auto-run.ts").read_text(encoding="utf-8"),
        (repo_root / "src/renderer/src/components/panels/SprintEngineBoardPanel.tsx").read_text(encoding="utf-8"),
        (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8"),
    ]
    combined_source = "\n".join(prompt_sources)

    assert "Keep polling for ready" not in combined_source
    assert "then poll again" not in combined_source
    # Claim-first dispatch: agents never run their own polling loop. The studio
    # owns dispatch and continuation; the agent calls the claim tool named in
    # its prompt once and stops when no claim is returned — no client-side
    # sleep/backoff, no directive hop.
    assert "Studio owns dispatch and continuation" in combined_source
    assert "sprintengine.task.next" in combined_source
    assert "sprintengine.agent.next_directive" not in combined_source
    assert "sprintengine join --role" not in combined_source, (
        "MCP-native autonomous prompts must not embed `sprintengine join` CLI invocations."
    )
    assert "buildWorkerRespawnStartupPrompt" not in combined_source


def test_electron_auto_run_clears_stale_spawn_state_before_retrying() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")
    executor_source = (repo_root / "src/shared/sprintengine/auto-run-executor.ts").read_text(encoding="utf-8")

    # The reconciler checks the existing session via the executor's
    # safeTerminalStatus helper (which routes the catch-fallback through the
    # executor port) before declaring the session stale and clearing the
    # cliSessionId.
    assert "const status = await safeTerminalStatus(ports, latestAgent.cliSessionId)" in cycle_source
    assert "if (status.processAlive) return 'skipped'" in cycle_source
    assert "cliSessionId: undefined" in cycle_source
    assert "if (!agent.cliSessionId)" in cycle_source
    # Managed-agent identity left AgentKind (MC-2573); the reconciler skips
    # non-roster / non-namespaced agents via the module helper instead of a
    # kind-member compare.
    assert "isSprintEngineManagedAgent(agent" in cycle_source
    # safeTerminalStatus must keep the fallback shape (terminalStatus call wrapped
    # in try/catch returning processAlive: false) so transient IPC failures do
    # not crash the retry path.
    assert "export async function safeTerminalStatus" in executor_source
    assert "return await ports.terminalStatus(sessionId)" in executor_source
    assert "return { processAlive: false }" in executor_source


def test_electron_roster_runner_starts_roster_agents_without_task_named_workers() -> None:
    """Lazy-spawning contract, reconciler edition (MC-1592): run start
    bootstraps only the planner via the pure planner decision
    (`pickSprintEngineBootstrapCandidate`) plus the cycle IPC wrapper
    (`ensureSprintEngineBootstrapAgent`); every other spawn is work-driven —
    the desired-pool pass groups ready unowned work by the demand key and
    mints fresh worker ids per key. There are no per-task named workers, no
    blanket roster audit (`startMissingRosterAgents`), and no seat-like
    role-wide waits holding ready work back.
    """
    repo_root = Path(__file__).resolve().parents[2]
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")
    planner_source = (repo_root / "src/shared/sprintengine/auto-run.ts").read_text(encoding="utf-8")

    assert "async function ensureSprintEngineBootstrapAgent" in cycle_source
    assert "pickSprintEngineBootstrapCandidate(workspace, sprintEngineState, {" in cycle_source
    assert "export function pickSprintEngineBootstrapCandidate" in planner_source
    assert "buildSprintEngineAgentRosterForState(sprintEngineState)" in planner_source
    # Bootstrap spawns keep the roster agent id; the synthetic task id only
    # namespaces the spawn, it does not create a task-named worker.
    assert "taskId: `bootstrap-${planner.id}`" in planner_source
    # The pool pass is demand-keyed (computeSprintEngineDemand grouped by
    # sprintEngineDemandKey) and never waits on a role-wide seat.
    assert "export function computeSprintEngineDemand" in planner_source
    assert "export function sprintEngineDemandKey" in planner_source
    assert "candidate-pick-demand" in planner_source
    assert "candidate-pick-ready-task-waiting-for-planning-agent" not in planner_source, (
        "seat-like roleHasAgent-wait semantics were removed with the pool reconciler"
    )
    assert "async function startMissingRosterAgents" not in cycle_source
    assert "taskId: `roster-${agent.id}`" not in cycle_source
    assert "function buildAutoRunAgentId" not in cycle_source
    assert "buildAutoRunAgentId(task.role, task.id)" not in cycle_source


def test_electron_roster_runner_uses_local_automation_mode_only() -> None:
    """Regression: the reconciler must derive runner activity from local autoState
    only, never from the persisted CLI watch-polling flag in run.yaml. The old
    `ensureDurableAutoMode` bridge was removed because it caused the Manual
    radio to flick back to the previous automation mode whenever the run.yaml
    write completed slightly later than the React re-render.
    """
    repo_root = Path(__file__).resolve().parents[2]
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")

    assert "deriveAutomationMode(autoState)" in cycle_source
    assert "const runnerActive = automationMode !== 'manual'" in cycle_source
    assert "async function ensureDurableAutoMode" not in cycle_source, (
        "ensureDurableAutoMode was removed; see "
        "src/renderer/src/utils/sprintengineAutomation.ts for the rationale."
    )
    assert "sprintEngineState.runner?.mode" not in cycle_source, (
        "The cycle must not read the legacy runner.mode field. The new field is "
        "runner.cliWatchPolling, and the studio's reconciler reads neither — local "
        "autoState alone gates spawning."
    )


def test_electron_auto_approval_runs_without_roster_runner_enabled() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    cycle_source = (repo_root / "src/shared/sprintengine/auto-run-cycle.ts").read_text(encoding="utf-8")

    assert "const approvalActive = automationMode === 'run_agents_and_approve_artifacts'" in cycle_source
    assert "if ((!runnerActive && !approvalActive)" in cycle_source
    assert "if (approvalActive) {" in cycle_source
    assert "reason: 'artifact-approval-only'" in cycle_source
