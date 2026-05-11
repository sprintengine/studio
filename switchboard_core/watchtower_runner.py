from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .store import (
    SwitchboardError,
    active_execution_count,
    append_runner_event,
    locked_runner,
    read_all,
    read_runner_state,
    record_for_output,
    runner_command_for,
    start_local_process_agent_execution,
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
    if not state.get("enabled") or state.get("paused"):
        raise SwitchboardError("Switchboard runner is paused or disabled.")
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


def start_watchtower_review(workspace: Path, *, preset: str) -> dict[str, Any]:
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
        state = launch_pending_watchtower_executions_unlocked(workspace, state)
        return {"ok": True, "run": run_for_response(workspace, run["runId"]), "runner": state}


def start_watchtower_triage(workspace: Path, *, scope: str = "all", task_id: str | None = None) -> dict[str, Any]:
    with locked_runner(workspace):
        state = read_runner_state(workspace)
        ensure_runner_can_launch_watchtower(workspace, state)
        active_review = active_watchtower_review_run(workspace)
        if active_review is not None:
            raise SwitchboardError(
                f"Watchtower review {active_review['runId']} is still running. "
                "Wait for review agents to finish before starting architect triage."
            )
        scoped = triage_scope_records(workspace, scope=scope, task_id=task_id)
        if not scoped:
            raise SwitchboardError("There are no Watchtower inbox tasks to triage.")
        nonce = uuid.uuid4().hex[:8]
        agent_id = f"watchtower-triage-{nonce}-architect"
        run = create_watchtower_run_with_status(
            workspace,
            preset="inbox_triage",
            agents=[watchtower_agent_record(agent_id, "architect", task_ids=[record["task"]["id"] for record in scoped])],
            status="running",
        )
        state = launch_pending_watchtower_executions_unlocked(workspace, state, triage_records=scoped)
        return {"ok": True, "run": run_for_response(workspace, run["runId"]), "runner": state}


def triage_scope_records(workspace: Path, *, scope: str, task_id: str | None) -> list[dict[str, Any]]:
    tasks, _problems, _locks = read_all(workspace)
    inbox = [record_for_output(located) for located in tasks if located.folder_status == "inbox"]
    if scope == "all":
        return inbox
    if scope == "selected":
        if not task_id:
            raise SwitchboardError("Watchtower selected triage requires a task id.")
        return [record for record in inbox if record["task"]["id"] == task_id]
    raise SwitchboardError("Watchtower triage scope must be all or selected.")


def active_watchtower_review_run(workspace: Path) -> dict[str, Any] | None:
    for run in list_watchtower_runs(workspace):
        if run.get("preset") == "inbox_triage":
            continue
        if run.get("status") in {"pending", "running"}:
            return run
        if any(agent.get("status") in {"pending", "running"} for agent in run.get("agents", [])):
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
    capability_errors = validate_runner_capability(workspace, state)
    if capability_errors:
        message = " ".join(capability_errors)
        state["lastError"] = message
        fail_pending_watchtower_agents(workspace, message)
        return write_runner_state(workspace, state)
    command = runner_command_for(state)
    if not command:
        state["lastError"] = f"Runner CLI executable was not found: {state.get('cli', 'codex')}"
        fail_pending_watchtower_agents(workspace, state["lastError"])
        return write_runner_state(workspace, state)
    while active_execution_count(state) < state.get("maxConcurrency", 1):
        pending = next_pending_watchtower_agent(workspace)
        if not pending:
            break
        run, agent = pending
        execution_id = f"exec_{uuid.uuid4().hex}"
        try:
            execution = launch_watchtower_agent(workspace, state, command, execution_id, run, agent, triage_records=triage_records)
        except Exception as exc:
            update_watchtower_agent(workspace, run["runId"], agent["agentId"], status="failed", error_message=str(exc))
            state["lastError"] = str(exc)
            append_runner_event(
                workspace,
                "provider_error",
                message=str(exc),
                data={"runId": run["runId"], "agentId": agent["agentId"], "executionId": execution_id},
            )
            return write_runner_state(workspace, state)
        state["activeExecutions"].append(execution)
        state["lastError"] = None
        append_runner_event(
            workspace,
            "launch",
            data={"executionId": execution_id, "kind": execution["kind"], "runId": run["runId"], "agentId": agent["agentId"]},
        )
        state = write_runner_state(workspace, state)
    return write_runner_state(workspace, state)


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


def next_pending_watchtower_agent(workspace: Path) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for run in sorted(list_watchtower_runs(workspace), key=lambda current: str(current.get("createdAt") or "")):
        if run.get("status") not in {"pending", "running"}:
            continue
        for agent in run.get("agents", []):
            if agent.get("status") == "pending":
                return run, agent
    return None


def launch_watchtower_agent(
    workspace: Path,
    state: dict[str, Any],
    command: list[str],
    execution_id: str,
    run: dict[str, Any],
    agent: dict[str, Any],
    *,
    triage_records: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
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

    execution = start_local_process_agent_execution(
        workspace=workspace,
        command=command,
        execution_id=execution_id,
        kind=kind,
        role=specialist_short_label(specialist_id),
        prompt=prompt,
        run_workspace=workspace.expanduser().resolve(),
        metadata={
            "watchtowerRunId": run["runId"],
            "watchtowerAgentId": agent_id,
            "specialistId": specialist_id,
        },
    )
    update_watchtower_agent(workspace, run["runId"], agent_id, status="running", execution_id=execution_id)
    return execution


def run_for_response(workspace: Path, run_id: str) -> dict[str, Any]:
    for run in list_watchtower_runs(workspace):
        if run.get("runId") == run_id:
            return run
    raise SwitchboardError("Watchtower run was not found.")
