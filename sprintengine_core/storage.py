"""Read-only Sprint Engine storage over current Swarm state files."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
import re
from typing import Any, cast

import yaml

from .schema import (
    AutoRunState,
    AutoRunStatus,
    AgentStatus,
    ArtifactStatus,
    Blocker,
    Evidence,
    ReviewHistoryEntry,
    SourceMetadata,
    SprintAgent,
    SprintArtifact,
    SprintEngineState,
    SprintEvent,
    SprintRun,
    SprintTask,
    TaskStatus,
)
from .specialists import list_specialist_role_refs

SWARM_STATE_FORMAT = "swarm-state"
SPRINT_RUN_PREFIX = "sprint:"
SPRINT_TEAM_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class SprintEngineStorageError(RuntimeError):
    """Raised when Sprint Engine cannot read a backing state file."""


def list_runs(repo_root: Path | str | None = None) -> list[SprintRun]:
    """Discover current `swarm/<team>/state.yaml` files as Sprint Engine runs."""

    root = _repo_root(repo_root)
    return [load_run_summary(state_path, root) for state_path in _iter_state_files(root)]


def load_run_summary(
    state_path: Path | str,
    repo_root: Path | str | None = None,
) -> SprintRun:
    """Load only run metadata from one Swarm state file."""

    root = _repo_root(repo_root)
    path = Path(state_path)
    raw_state = _read_state(path)
    return _convert_run(raw_state, path, root)


def load_run(run_id: str, repo_root: Path | str | None = None) -> SprintEngineState:
    """Load a full Sprint Engine state by canonical run id."""

    root = _repo_root(repo_root)
    return load_state(find_state_file(run_id, root), root)


def inspect_run(run_id: str, repo_root: Path | str | None = None) -> SprintEngineState:
    """Alias for loading a complete run for inspect commands."""

    return load_run(run_id, repo_root)


def get_run_status(run_id: str, repo_root: Path | str | None = None) -> dict[str, Any]:
    """Return deterministic status details for a Sprint Engine run."""

    state = load_run(run_id, repo_root)
    task_counts = Counter(task.status for task in state.tasks)
    artifact_counts = Counter(artifact.status for artifact in state.artifacts)
    done_task_ids = {task.id for task in state.tasks if task.status == "done"}
    ready_task_ids = [
        task.id
        for task in state.tasks
        if task.status == "todo"
        and task.owner_agent_id is None
        and all(dependency in done_task_ids for dependency in task.depends_on)
    ]

    return {
        "run": state.run.to_dict(),
        "taskCounts": dict(sorted(task_counts.items())),
        "artifactCounts": dict(sorted(artifact_counts.items())),
        "readyTaskIds": ready_task_ids,
        "source": state.source.to_dict() if state.source is not None else None,
    }


def find_state_file(run_id: str, repo_root: Path | str | None = None) -> Path:
    """Return the backing Swarm state file for a canonical Sprint Engine run id."""

    root = _repo_root(repo_root)
    if not run_id.startswith(SPRINT_RUN_PREFIX):
        raise SprintEngineStorageError(
            f"Sprint Engine run id must start with {SPRINT_RUN_PREFIX!r}: {run_id}"
        )

    team_slug = run_id.removeprefix(SPRINT_RUN_PREFIX)
    if not SPRINT_TEAM_SLUG_RE.fullmatch(team_slug):
        raise SprintEngineStorageError(f"Invalid Sprint Engine run id: {run_id}")

    swarm_root = (root / "swarm").resolve()
    state_path = (swarm_root / team_slug / "state.yaml").resolve()
    try:
        state_path.relative_to(swarm_root)
    except ValueError as exc:
        raise SprintEngineStorageError(f"Invalid Sprint Engine run id: {run_id}") from exc

    if not state_path.is_file():
        raise SprintEngineStorageError(f"Sprint Engine run not found: {run_id}")
    return state_path


def load_state(
    state_path: Path | str,
    repo_root: Path | str | None = None,
) -> SprintEngineState:
    """Load a current Swarm state file into canonical Sprint Engine objects."""

    root = _repo_root(repo_root)
    path = Path(state_path)
    raw_state = _read_state(path)
    source = _source(path, root)

    return SprintEngineState(
        schema_version=int(raw_state.get("schemaVersion", 1)),
        run=_convert_run(raw_state, path, root),
        tasks=[
            _convert_task(record, path, root, index)
            for index, record in enumerate(_list(raw_state.get("tasks")))
        ],
        artifacts=[
            _convert_artifact(record, path, root, index)
            for index, record in enumerate(_list(raw_state.get("artifacts")))
        ],
        agents=[
            _convert_agent(agent_id, record, path, root)
            for agent_id, record in sorted(_dict(raw_state.get("agents")).items())
        ],
        events=[
            _convert_event(record, path, root, index)
            for index, record in enumerate(_list(raw_state.get("events")))
        ],
        specialist_roles=list_specialist_role_refs(),
        auto_run=_convert_auto_run(raw_state, path, root),
        source=source,
    )


def _iter_state_files(repo_root: Path) -> list[Path]:
    swarm_root = repo_root / "swarm"
    if not swarm_root.is_dir():
        return []

    return sorted(
        (
            state_path
            for state_path in swarm_root.glob("*/state.yaml")
            if _looks_like_swarm_state(state_path)
        ),
        key=lambda path: path.parent.name,
    )


def _looks_like_swarm_state(state_path: Path) -> bool:
    try:
        raw_state = _read_state(state_path)
    except SprintEngineStorageError:
        return False
    return isinstance(raw_state.get("swarm"), dict)


def _read_state(state_path: Path) -> dict[str, Any]:
    try:
        loaded = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise SprintEngineStorageError(
            f"Unable to read Sprint Engine state: {state_path}"
        ) from exc
    except yaml.YAMLError as exc:
        raise SprintEngineStorageError(
            f"Invalid Sprint Engine state YAML: {state_path}"
        ) from exc

    if not isinstance(loaded, dict):
        raise SprintEngineStorageError(
            f"Sprint Engine state must be an object: {state_path}"
        )
    return loaded


def _convert_run(raw_state: dict[str, Any], state_path: Path, repo_root: Path) -> SprintRun:
    swarm = _dict(raw_state.get("swarm"))
    team_slug = state_path.parent.name
    name = str(swarm.get("name") or team_slug)
    return SprintRun(
        id=f"{SPRINT_RUN_PREFIX}{team_slug}",
        name=name,
        goal=str(swarm.get("goal") or ""),
        status=str(swarm.get("status") or "planning"),
        updated_at=_optional_str(swarm.get("updatedAt")),
        source=_source(state_path, repo_root, key_path="swarm"),
    )


def _convert_task(
    record: dict[str, Any],
    state_path: Path,
    repo_root: Path,
    index: int,
) -> SprintTask:
    evidence = _dict(record.get("evidence"))
    return SprintTask(
        id=str(record.get("id") or ""),
        title=str(record.get("title") or ""),
        description=str(record.get("description") or ""),
        role=str(record.get("role") or ""),
        status=cast(TaskStatus, str(record.get("status") or "todo")),
        owner_agent_id=_optional_str(record.get("ownerAgentId")),
        depends_on=_str_list(record.get("dependsOn")),
        owned_paths=_str_list(record.get("ownedPaths")),
        acceptance_criteria=_str_list(record.get("acceptanceCriteria")),
        implementation_notes=_str_list(record.get("implementationNotes")),
        evidence=Evidence(
            summary=str(evidence.get("summary") or ""),
            touched_files=_str_list(evidence.get("touchedFiles")),
            commands_ran=_str_list(evidence.get("commandsRan")),
            results=_str_list(evidence.get("results")),
        ),
        notes=_str_list(record.get("notes")),
        learned_facts=_str_list(record.get("learnedFacts")),
        blockers=[
            _convert_blocker(blocker, state_path, repo_root, blocker_index)
            for blocker_index, blocker in enumerate(_list(record.get("blockers")))
        ],
        started_at=_optional_str(record.get("startedAt")),
        completed_at=_optional_str(record.get("completedAt")),
        source=_source(state_path, repo_root, key_path=f"tasks[{index}]"),
    )


def _convert_blocker(
    record: dict[str, Any],
    state_path: Path,
    repo_root: Path,
    index: int,
) -> Blocker:
    return Blocker(
        id=str(record.get("id") or f"blocker-{index + 1}"),
        summary=str(record.get("summary") or record.get("description") or ""),
        created_at=_optional_str(record.get("createdAt")),
        resolved_at=_optional_str(record.get("resolvedAt")),
        source=_source(state_path, repo_root, key_path=f"blockers[{index}]"),
    )


def _convert_artifact(
    record: dict[str, Any],
    state_path: Path,
    repo_root: Path,
    index: int,
) -> SprintArtifact:
    return SprintArtifact(
        id=str(record.get("id") or ""),
        kind=str(record.get("kind") or ""),
        title=str(record.get("title") or ""),
        path=str(record.get("path") or ""),
        status=cast(ArtifactStatus, str(record.get("status") or "draft")),
        created_by=str(record.get("createdBy") or ""),
        task_id=_optional_str(record.get("taskId")),
        review_history=[
            ReviewHistoryEntry(
                action=str(history.get("action") or ""),
                actor=str(history.get("actor") or ""),
                timestamp=str(history.get("timestamp") or ""),
                feedback=_optional_str(history.get("feedback")),
            )
            for history in _list(record.get("reviewHistory"))
        ],
        recommended_tasks=_str_list(record.get("recommendedTasks")),
        approved_by=_optional_str(record.get("approvedBy")),
        source=_source(state_path, repo_root, key_path=f"artifacts[{index}]"),
    )


def _convert_agent(
    agent_id: str,
    record: dict[str, Any],
    state_path: Path,
    repo_root: Path,
) -> SprintAgent:
    return SprintAgent(
        id=agent_id,
        role=str(record.get("role") or ""),
        status=cast(AgentStatus, str(record.get("status") or "idle")),
        current_task_id=_optional_str(record.get("currentTaskId")),
        source=_source(state_path, repo_root, key_path=f"agents.{agent_id}"),
    )


def _convert_event(
    record: dict[str, Any],
    state_path: Path,
    repo_root: Path,
    index: int,
) -> SprintEvent:
    return SprintEvent(
        id=str(record.get("id") or ""),
        timestamp=str(record.get("timestamp") or ""),
        type=str(record.get("type") or ""),
        actor=str(record.get("actor") or ""),
        message=str(record.get("message") or ""),
        task_id=_optional_str(record.get("taskId")),
        artifact_id=_optional_str(record.get("artifactId")),
        source=_source(state_path, repo_root, key_path=f"events[{index}]"),
    )


def _convert_auto_run(
    raw_state: dict[str, Any],
    state_path: Path,
    repo_root: Path,
) -> AutoRunState | None:
    raw_auto_run = raw_state.get("autoRun", raw_state.get("auto_run"))
    if raw_auto_run is None:
        return None

    auto_run = _dict(raw_auto_run)
    return AutoRunState(
        status=cast(AutoRunStatus, str(auto_run.get("status") or "idle")),
        enabled=bool(auto_run.get("enabled", False)),
        requested_by=_optional_str(auto_run.get("requestedBy")),
        started_at=_optional_str(auto_run.get("startedAt")),
        stopped_at=_optional_str(auto_run.get("stoppedAt")),
        last_error=_optional_str(auto_run.get("lastError")),
        source=_source(state_path, repo_root, key_path="autoRun"),
    )


def _source(
    state_path: Path,
    repo_root: Path,
    key_path: str | None = None,
) -> SourceMetadata:
    return SourceMetadata(
        format=SWARM_STATE_FORMAT,
        path=_project_relative_path(state_path, repo_root),
        key_path=key_path,
    )


def _project_relative_path(path: Path, repo_root: Path) -> str:
    try:
        relative = path.resolve().relative_to(repo_root.resolve())
    except ValueError:
        raise SprintEngineStorageError(
            "Sprint Engine source path escapes repository root"
        )
    return relative.as_posix()


def _repo_root(repo_root: Path | str | None) -> Path:
    return Path.cwd() if repo_root is None else Path(repo_root)


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _str_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _optional_str(value: Any) -> str | None:
    return None if value is None else str(value)
