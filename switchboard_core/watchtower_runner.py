from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .store import (
    SwitchboardError,
    active_execution_count,
    agent_cli_env,
    append_runner_event,
    atomic_write_json,
    execution_dir,
    execution_metadata_path,
    locked_runner,
    now_iso,
    read_all,
    read_runner_state,
    record_for_output,
    relative_to_switchboard_root,
    runner_command_for,
    validate_runner_capability,
    write_runner_state,
)
from .watchtower import (
    create_watchtower_run_with_status,
    list_watchtower_runs,
    update_watchtower_agent,
    watchtower_run_dir,
)
from .watchtower_prompts import (
    build_watchtower_review_prompt,
    build_watchtower_triage_prompt,
    selected_agents_for_preset,
    specialist_short_label,
)


def ensure_runner_can_launch_watchtower(workspace: Path, state: dict[str, Any]) -> list[str]:
    errors = validate_runner_capability(workspace, state)
    if errors:
        raise SwitchboardError(" ".join(errors))
    command = runner_command_for(state)
    if not command:
        raise SwitchboardError("Runner command disappeared after capability check.")
    return command


def watchtower_agent_record(agent_id: str, specialist_id: str, *, task_ids: list[str] | None = None) -> dict[str, Any]:
    record = {
        "agentId": agent_id,
        "specialistId": specialist_id,
        "status": "pending",
        "outputDir": f"outputs/{agent_id}",
        "reportPath": f"reports/{agent_id}.md",
        "executionId": None,
        "errorMessage": None,
    }
    if task_ids:
        record["taskIds"] = task_ids
    return record


def start_watchtower_review(
    workspace: Path,
    *,
    preset: str,
    app_instance_id: str | None = None,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    with locked_runner(workspace):
        state = read_runner_state(workspace)
        ensure_runner_can_launch_watchtower(workspace, state)
        nonce = uuid.uuid4().hex[:8]
        agents = [
            watchtower_agent_record(f"watchtower-{nonce}-{agent['specialistId']}", str(agent["specialistId"]))
            for agent in selected_agents_for_preset(preset)
        ]
        if not agents:
            raise SwitchboardError("Watchtower preset has no review agents.")
        run = create_watchtower_run_with_status(workspace, preset=preset, agents=agents, status="running")
        state, descriptors = prepare_pending_watchtower_executions_unlocked(
            workspace,
            state,
            run_id=str(run["runId"]),
            ignore_concurrency=True,
            app_instance_id=app_instance_id,
            workspace_id=workspace_id,
        )
        return {"ok": True, "run": run_for_response(workspace, run["runId"]), "runner": state, "descriptors": descriptors}


def start_watchtower_triage(
    workspace: Path,
    *,
    scope: str = "all",
    task_id: str | None = None,
    app_instance_id: str | None = None,
    workspace_id: str | None = None,
) -> dict[str, Any]:
    with locked_runner(workspace):
        state = read_runner_state(workspace)
        ensure_runner_can_launch_watchtower(workspace, state)
        active_review = active_watchtower_review_run(workspace, state)
        if active_review is not None:
            raise SwitchboardError(
                f"Watchtower review {active_review['runId']} is still running. "
                "Wait for review agents to finish before starting architect triage."
            )
        scoped = triage_scope_records(workspace, scope=scope, task_id=task_id)
        if not scoped:
            tasks, _problems, _locks = read_all(workspace)
            inbox_total = sum(1 for located in tasks if located.folder_status == "inbox")
            if inbox_total == 0:
                raise SwitchboardError("There are no Watchtower inbox tasks to triage.")
            raise SwitchboardError(
                f"All {inbox_total} inbox task{'s' if inbox_total != 1 else ''} already have triage comments. "
                "Click a specific task to re-triage it."
            )
        nonce = uuid.uuid4().hex[:8]
        agent_id = f"watchtower-triage-{nonce}-architect"
        run = create_watchtower_run_with_status(
            workspace,
            preset="inbox_triage",
            agents=[watchtower_agent_record(agent_id, "architect", task_ids=[record["task"]["id"] for record in scoped])],
            status="running",
        )
        state, descriptors = prepare_pending_watchtower_executions_unlocked(
            workspace,
            state,
            run_id=str(run["runId"]),
            triage_records=scoped,
            ignore_concurrency=True,
            app_instance_id=app_instance_id,
            workspace_id=workspace_id,
        )
        return {"ok": True, "run": run_for_response(workspace, run["runId"]), "runner": state, "descriptors": descriptors}


def triage_scope_records(workspace: Path, *, scope: str, task_id: str | None) -> list[dict[str, Any]]:
    tasks, _problems, _locks = read_all(workspace)
    inbox = [record_for_output(located) for located in tasks if located.folder_status == "inbox"]
    if scope == "all":
        # Skip tasks that already carry a triage comment. Re-running
        # "triage all" without this filter has the architect add a
        # second comment to each item, which is wasteful and misleads
        # the UI count ("triaging 19/19" when 0 actually need it).
        # The "selected" scope intentionally does not filter; a user
        # who clicks a specific task is asking for a re-triage.
        return [record for record in inbox if not _has_triage_comment(record)]
    if scope == "selected":
        if not task_id:
            raise SwitchboardError("Watchtower selected triage requires a task id.")
        return [record for record in inbox if record["task"]["id"] == task_id]
    raise SwitchboardError("Watchtower triage scope must be all or selected.")


def _has_triage_comment(record: dict[str, Any]) -> bool:
    comments = record.get("task", {}).get("comments")
    if not isinstance(comments, list):
        return False
    return any(isinstance(c, dict) and c.get("kind") == "triage" for c in comments)


def active_watchtower_review_run(workspace: Path, state: dict[str, Any] | None = None) -> dict[str, Any] | None:
    if state is None:
        active_execution_ids = None
    else:
        active_execution_ids = {
            execution.get("executionId")
            for execution in state.get("activeExecutions", [])
            if (
                isinstance(execution, dict)
                and execution.get("status") in {"active", "launching"}
                and isinstance(execution.get("executionId"), str)
            )
        }
    for run in list_watchtower_runs(workspace):
        if run.get("preset") == "inbox_triage":
            continue
        pending_or_running_agents = [
            agent for agent in run.get("agents", [])
            if isinstance(agent, dict) and agent.get("status") in {"pending", "running"}
        ]
        if not pending_or_running_agents and run.get("status") not in {"pending", "running"}:
            continue
        if active_execution_ids is None:
            return run
        if any(agent.get("executionId") in active_execution_ids for agent in pending_or_running_agents):
            return run
    return None


def triage_records_for_agent(workspace: Path, agent: dict[str, Any]) -> list[dict[str, Any]]:
    task_ids = agent.get("taskIds")
    if not isinstance(task_ids, list) or not task_ids:
        return triage_scope_records(workspace, scope="all", task_id=None)
    wanted = {task_id for task_id in task_ids if isinstance(task_id, str)}
    tasks, _problems, _locks = read_all(workspace)
    return [
        record_for_output(located)
        for located in tasks
        if located.folder_status == "inbox" and located.task["id"] in wanted
    ]


def launch_pending_watchtower_executions(workspace: Path) -> dict[str, Any]:
    with locked_runner(workspace):
        state = read_runner_state(workspace)
        if not state.get("enabled") or state.get("paused"):
            return state
        return launch_pending_watchtower_executions_unlocked(workspace, state)


def launch_pending_watchtower_executions_unlocked(
    workspace: Path,
    state: dict[str, Any],
    *,
    triage_records: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    state, _descriptors = prepare_pending_watchtower_executions_unlocked(workspace, state, triage_records=triage_records)
    return state


def prepare_pending_watchtower_executions_unlocked(
    workspace: Path,
    state: dict[str, Any],
    *,
    run_id: str | None = None,
    triage_records: list[dict[str, Any]] | None = None,
    ignore_concurrency: bool = False,
    app_instance_id: str | None = None,
    workspace_id: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    descriptors: list[dict[str, Any]] = []
    capability_errors = validate_runner_capability(workspace, state)
    if capability_errors:
        message = " ".join(capability_errors)
        state["lastError"] = message
        fail_pending_watchtower_agents(workspace, message)
        return write_runner_state(workspace, state), descriptors
    command = runner_command_for(state)
    if not command:
        state["lastError"] = f"Runner CLI executable was not found: {state.get('cli', 'codex')}"
        fail_pending_watchtower_agents(workspace, state["lastError"])
        return write_runner_state(workspace, state), descriptors
    while ignore_concurrency or active_execution_count(state) < state.get("maxConcurrency", 1):
        pending = next_pending_watchtower_agent(workspace, run_id=run_id)
        if not pending:
            break
        run, agent = pending
        execution_id = f"exec_{uuid.uuid4().hex}"
        try:
            execution, descriptor = prepare_watchtower_agent(
                workspace,
                state,
                command,
                execution_id,
                run,
                agent,
                triage_records=triage_records,
                app_instance_id=app_instance_id,
                workspace_id=workspace_id,
            )
        except Exception as exc:
            update_watchtower_agent(workspace, run["runId"], agent["agentId"], status="failed", error_message=str(exc))
            state["lastError"] = str(exc)
            append_runner_event(
                workspace,
                "provider_error",
                message=str(exc),
                data={"runId": run["runId"], "agentId": agent["agentId"], "executionId": execution_id},
            )
            return write_runner_state(workspace, state), descriptors
        state["activeExecutions"].append(execution)
        descriptors.append(descriptor)
        state["lastError"] = None
        append_runner_event(
            workspace,
            "launch",
            data={"executionId": execution_id, "kind": execution["kind"], "runId": run["runId"], "agentId": agent["agentId"]},
        )
        state = write_runner_state(workspace, state)
    return write_runner_state(workspace, state), descriptors


def fail_pending_watchtower_agents(workspace: Path, message: str) -> None:
    for run in list_watchtower_runs(workspace):
        if run.get("status") not in {"pending", "running"}:
            continue
        for agent in run.get("agents", []):
            if agent.get("status") == "pending":
                update_watchtower_agent(
                    workspace,
                    str(run["runId"]),
                    str(agent["agentId"]),
                    status="failed",
                    error_message=message,
                )


def next_pending_watchtower_agent(workspace: Path, *, run_id: str | None = None) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for run in sorted(list_watchtower_runs(workspace), key=lambda current: str(current.get("createdAt") or "")):
        if run_id is not None and run.get("runId") != run_id:
            continue
        if run.get("status") not in {"pending", "running"}:
            continue
        for agent in run.get("agents", []):
            if agent.get("status") == "pending":
                return run, agent
    return None


def prepare_watchtower_agent(
    workspace: Path,
    state: dict[str, Any],
    command: list[str],
    execution_id: str,
    run: dict[str, Any],
    agent: dict[str, Any],
    *,
    triage_records: list[dict[str, Any]] | None = None,
    app_instance_id: str | None = None,
    workspace_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    agent_id = str(agent["agentId"])
    specialist_id = str(agent.get("specialistId") or "")
    run_dir = watchtower_run_dir(workspace, run["runId"])
    output_directory = str((run_dir / str(agent["outputDir"])).resolve())
    report_path = str((run_dir / str(agent["reportPath"] or f"reports/{agent_id}.md")).resolve())
    if run.get("preset") == "inbox_triage":
        records = triage_records if triage_records is not None else triage_records_for_agent(workspace, agent)
        prompt = build_watchtower_triage_prompt(
            run=run,
            workspace_root=workspace,
            tasks=records,
            scope_label=f"{len(records)} inbox tasks" if len(records) != 1 else f"selected inbox task {records[0]['task']['identifier']}",
        )
        kind = "watchtower_triage"
    else:
        from .watchtower_prompts import WATCHTOWER_REVIEW_PRESETS

        sectors = WATCHTOWER_REVIEW_PRESETS.get(str(run.get("preset")), {}).get(specialist_id, [])
        prompt = build_watchtower_review_prompt(
            run=run,
            agent=agent,
            sectors=sectors,
            workspace_root=workspace,
            output_directory=output_directory,
            report_path=report_path,
        )
        kind = "watchtower_review"

    started_at = now_iso()
    current_dir = execution_dir(workspace, execution_id)
    current_dir.mkdir(parents=True, exist_ok=False)
    prompt_path = current_dir / "prompt.txt"
    prompt_path.write_text(prompt + "\n", encoding="utf-8")
    role = specialist_short_label(specialist_id)
    run_workspace = workspace.expanduser().resolve()
    provider_ref = {
        "cwd": str(run_workspace),
        "sessionId": execution_id,
        "attachable": True,
    }
    env = agent_cli_env(workspace)
    execution = {
        "executionId": execution_id,
        "kind": kind,
        "system": "watchtower",
        "workId": run["runId"],
        "role": role,
        "provider": "electron-session",
        "providerRef": provider_ref,
        "startedAt": started_at,
        "lastSeenAt": started_at,
        "launchStartedAt": started_at,
        "ownerAppInstanceId": app_instance_id,
        "workspaceId": workspace_id,
        "sessionId": execution_id,
        "status": "launching",
        "watchtowerRunId": run["runId"],
        "watchtowerAgentId": agent_id,
        "specialistId": specialist_id,
    }
    atomic_write_json(
        execution_metadata_path(workspace, execution_id),
        {
            "schemaVersion": 1,
            **execution,
            "command": command,
            "cwd": str(run_workspace),
            "prompt": prompt,
            "promptFile": relative_to_switchboard_root(workspace, prompt_path),
            "exitCode": None,
            "completedAt": None,
            "error": None,
        },
    )
    update_watchtower_agent(workspace, run["runId"], agent_id, status="running", execution_id=execution_id)
    return execution, {
        "executionId": execution_id,
        "system": "watchtower",
        "workId": run["runId"],
        "role": role,
        "displayName": role,
        "command": command,
        "cwd": str(run_workspace),
        "env": env,
        "prompt": prompt,
        "cli": state.get("cli", "codex"),
    }


def run_for_response(workspace: Path, run_id: str) -> dict[str, Any]:
    for run in list_watchtower_runs(workspace):
        if run.get("runId") == run_id:
            return run
    raise SwitchboardError("Watchtower run was not found.")
