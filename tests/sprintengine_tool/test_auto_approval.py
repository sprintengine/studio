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
            task("T1", "Code review gate", "code_reviewer", "needs_input", owner="code-reviewer-fixture"),
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
    renderer_source = (repo_root / "src/renderer/src/utils/sprintengine.ts").read_text(encoding="utf-8")
    match = re.search(r"const reviewGateArtifactKinds: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)", renderer_source)
    assert match, "renderer reviewGateArtifactKinds declaration not found"

    renderer_kinds = set(re.findall(r"'([^']+)'", match.group(1)))
    assert renderer_kinds == APPROVED_AUTO_APPROVAL_KINDS

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
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )
    executor_source = (repo_root / "src/renderer/src/utils/sprintengineAutoRunExecutor.ts").read_text(
        encoding="utf-8"
    )
    artifacts_source = (repo_root / "src/main/sprintengine-artifacts.ts").read_text(encoding="utf-8")

    # Supervisor must not push approval through the agent terminal.
    assert "sendArtifactApprovalToTerminal" not in supervisor_source
    assert "Sent the user approval intent to the responsible agent terminal." not in supervisor_source
    # Post-T5 boundary: the supervisor routes auto-approval through the
    # executor port, and the executor binds the live IPC call. Behaviour test:
    # the supervisor calls the port, and the default-port factory wires the
    # window.api IPC.
    assert "defaultExecutorPorts.autoApproveSprintEngineArtifact(statePath, artifact.id)" in supervisor_source
    assert (
        "autoApproveSprintEngineArtifact: (statePath, artifactId) =>" in executor_source
        and "window.api.autoApproveSprintEngineArtifact(statePath, artifactId)" in executor_source
    )
    assert "Artifact auto-approved through Sprint Engine" in supervisor_source
    assert "action: 'approve-intent'" not in artifacts_source
    assert "await assertAutoApprovalAllowed(state, artifactId)" in artifacts_source
    assert "sprintengine.artifact.approve" in artifacts_source


def test_sprintengine_auto_approval_marks_architect_startup_as_autonomous() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )
    prompt_source = (repo_root / "src/renderer/src/utils/agentPrompt.ts").read_text(encoding="utf-8")
    terminal_view_source = (repo_root / "src/renderer/src/components/panels/TerminalView.tsx").read_text(encoding="utf-8")

    # Lazy-spawning rewrite: both spawn paths now derive the override from the
    # automation helpers instead of reading autoApproveArtifacts directly.
    assert "autonomousPlanningOverride: nextRun.role === 'architect' && sprintEngineArtifactApprovalDesired(autoState)" in supervisor_source
    assert "rosterAgent.role === 'architect'" in terminal_view_source
    assert (
        "deriveSprintEngineAutomationDesiredMode(workspace.sprintEngineAutoState) === 'run_agents_and_approve_artifacts'"
        in terminal_view_source
    )
    assert "## Autonomous Planning Override" in prompt_source
    # The MCP-only prompt rewrite reframed the trigger as the automation mode
    # name (still semantically "Approve all artifacts is on") and described the
    # division of responsibility between agent automation and artifact approval.
    assert "Sprint Engine automation mode is Run agents + approve artifacts" in prompt_source
    assert "Agent automation controls spawning; artifact approval automation is the signal to skip normal grilling." in prompt_source
    assert "Do not pause for ordinary preference, naming, scope-shaping, or plan-review questions" in prompt_source


def test_electron_auto_run_prompts_idle_running_agents_for_ready_work() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )
    auto_run_utils_source = (repo_root / "src/renderer/src/utils/sprintengineAutoRun.ts").read_text(encoding="utf-8")

    assert "function sendContinuationPromptsToIdleAgents" in supervisor_source
    # Reconciler: every re-engagement decision (wake, gate, dispatch, restart)
    # lives in the pure planner; the supervisor only executes the plan.
    assert "planSprintEngineDispatch" in supervisor_source
    assert "buildSprintEngineContinuationPrompt(task, agentId)" in auto_run_utils_source
    assert "Sprint Engine roster runner found a wake candidate for a ready" in auto_run_utils_source
    # Claim-first dispatch: the continuation prompt hands the agent the claim
    # tool directly; the directive hop is headless-CLI only and must not
    # appear in renderer prompt sources.
    assert "sprintengine.task.next" in auto_run_utils_source
    assert "sprintengine.agent.next_directive" not in auto_run_utils_source
    assert "sprintengine join --role" not in auto_run_utils_source, (
        "MCP-native autonomous prompts must not embed `sprintengine join` CLI invocations."
    )
    # One all-paths reconcile call per supervise cycle; the per-path wrappers
    # (sendContinuationPromptsToIdleAgents and friends) are test-surface shims.
    assert "paths: ['notification', 'dispatch', 'task_wake', 'gate', 'restart', 'respawn', 'idle_retire']" in supervisor_source
    assert "continuation-prompt-sent" in auto_run_utils_source


def test_sprintengine_agent_prompts_do_not_continue_polling_after_claim() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    prompt_sources = [
        (repo_root / "src/renderer/src/utils/agentPrompt.ts").read_text(encoding="utf-8"),
        (repo_root / "src/renderer/src/utils/sprintengineAutoRun.ts").read_text(encoding="utf-8"),
        (repo_root / "src/renderer/src/components/panels/SprintEngineBoardPanel.tsx").read_text(encoding="utf-8"),
        (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
            encoding="utf-8"
        ),
    ]
    combined_source = "\n".join(prompt_sources)

    assert "Keep polling for ready" not in combined_source
    assert "then poll again" not in combined_source
    # Claim-first dispatch: agents never run their own polling loop. Multicode
    # owns dispatch and continuation; the agent calls the claim tool named in
    # its prompt once and stops when no claim is returned — no client-side
    # sleep/backoff, no directive hop.
    assert "Multicode owns dispatch and continuation" in combined_source
    assert "sprintengine.task.next" in combined_source
    assert "sprintengine.agent.next_directive" not in combined_source
    assert "sprintengine join --role" not in combined_source, (
        "MCP-native autonomous prompts must not embed `sprintengine join` CLI invocations."
    )
    assert "buildWorkerRespawnStartupPrompt" not in combined_source


def test_electron_auto_run_clears_stale_spawn_state_before_retrying() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )
    executor_source = (repo_root / "src/renderer/src/utils/sprintengineAutoRunExecutor.ts").read_text(
        encoding="utf-8"
    )

    # Post-T5 boundary: the supervisor checks the existing session via the
    # executor's safeTerminalStatus helper (which routes the catch-fallback
    # through the executor port) before declaring the session stale and
    # clearing the cliSessionId.
    assert "const status = await safeTerminalStatus(defaultExecutorPorts, latestAgent.cliSessionId)" in supervisor_source
    assert "if (status.processAlive) return 'skipped'" in supervisor_source
    assert "cliSessionId: undefined" in supervisor_source
    assert "if (!agent.cliSessionId)" in supervisor_source
    assert "agent.kind !== 'sprintengine'" in supervisor_source
    # safeTerminalStatus must keep the fallback shape (terminalStatus call wrapped
    # in try/catch returning processAlive: false) so transient IPC failures do
    # not crash the retry path.
    assert "export async function safeTerminalStatus" in executor_source
    assert "return await ports.terminalStatus(sessionId)" in executor_source
    assert "return { processAlive: false }" in executor_source


def test_electron_roster_runner_starts_roster_agents_without_task_named_workers() -> None:
    """Lazy-spawning contract: run start bootstraps only the architect via the
    pure planner decision (`pickSprintEngineBootstrapCandidate`) plus the
    supervisor IPC wrapper (`ensureSprintEngineBootstrapAgent`); every other
    spawn is work-driven through the capped planner. Agents keep roster
    identities — there are no per-task named workers. The old blanket roster
    audit (`startMissingRosterAgents`) must not return.
    See future-plans/2026-06-10-sprintengine-lazy-agent-spawning.md.
    """
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )
    auto_run_utils_source = (repo_root / "src/renderer/src/utils/sprintengineAutoRun.ts").read_text(encoding="utf-8")

    assert "async function ensureSprintEngineBootstrapAgent" in supervisor_source
    assert "pickSprintEngineBootstrapCandidate(workspace, sprintEngineState, {" in supervisor_source
    assert "export function pickSprintEngineBootstrapCandidate" in auto_run_utils_source
    assert "buildSprintEngineAgentRosterForState(sprintEngineState)" in auto_run_utils_source
    # Bootstrap spawns keep the roster agent id; the synthetic task id only
    # namespaces the spawn, it does not create a task-named worker.
    assert "taskId: `bootstrap-${architect.id}`" in auto_run_utils_source
    assert "candidate-pick-ready-task-waiting-for-roster-agent" in auto_run_utils_source
    assert "async function startMissingRosterAgents" not in supervisor_source
    assert "taskId: `roster-${agent.id}`" not in supervisor_source
    assert "function buildAutoRunAgentId" not in supervisor_source
    assert "buildAutoRunAgentId(task.role, task.id)" not in supervisor_source


def test_electron_roster_runner_uses_local_automation_mode_only() -> None:
    """Regression: the supervisor must derive runner activity from local autoState
    only, never from the persisted CLI watch-polling flag in run.yaml. The old
    `ensureDurableAutoMode` bridge was removed because it caused the Manual
    radio to flick back to the previous automation mode whenever the run.yaml
    write completed slightly later than the React re-render.
    """
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )

    assert "deriveSprintEngineAutomationMode" in supervisor_source
    assert "const runnerActive = automationMode !== 'manual'" in supervisor_source
    assert "async function ensureDurableAutoMode" not in supervisor_source, (
        "ensureDurableAutoMode was removed; see knowledge/multicode/sprint-engine.md "
        "and src/renderer/src/utils/sprintengineAutomation.ts for the rationale."
    )
    assert "sprintEngineState.runner?.mode" not in supervisor_source, (
        "Supervisor must not read the legacy runner.mode field. The new field is "
        "runner.cliWatchPolling, and Multicode's supervisor reads neither — local "
        "autoState alone gates spawning."
    )


def test_electron_auto_approval_runs_without_roster_runner_enabled() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    supervisor_source = (repo_root / "src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx").read_text(
        encoding="utf-8"
    )

    assert "const approvalActive = automationMode === 'run_agents_and_approve_artifacts'" in supervisor_source
    assert "if ((!runnerActive && !approvalActive)" in supervisor_source
    assert "if (approvalActive) {" in supervisor_source
    assert "reason: 'artifact-approval-only'" in supervisor_source
