"""Folder-backed Sprint Engine run store primitives."""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import time
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml  # type: ignore
except ImportError as exc:
    raise SystemExit(
        "PyYAML is required. Install with: python3 -m pip install pyyaml"
    ) from exc


# Board columns: todo -> ready -> in_progress -> review -> done, with needs_input as
# the blocked surface. `ready` is the materialized queue, not a semantic status.
# MC-1542 deleted `changes_requested`, `testing`, and `product`. MIRRORED in
# sprintengine_core/tool/constants.py (VALID_TASK_STATUSES, minus `ready`) and in
# src/renderer/src/types/workspace.ts — a contract test pins all three.
TASK_STATUSES = (
    "todo",
    "ready",
    "in_progress",
    "review",
    "needs_input",
    "done",
    "canceled",
)
ARTIFACT_STATUSES = (
    "draft",
    "recorded",
    "ready_for_review",
    "approved",
    "changes_requested",
    "superseded",
)
# The repo a task targets when it names none: entry zero of `vcs.repos`, the run's
# primary repo (MC-1611). Every task written before multi-repo runs targeted the one
# repo the run had, which is that entry, so an absent `repo` reads as this and a
# single-repo run behaves exactly as it did. MIRRORED as `PRIMARY_REPO_ID` in
# sprintengine_core/tool/shell.py (which spells entry zero's id) and as
# DEFAULT_SPRINTENGINE_TASK_REPO in src/shared/sprintengine/run-types.ts; a contract
# test pins all three.
DEFAULT_TASK_REPO = "primary"
SUPPORT_DIRS = ("metrics", "reviews", "validation", "runner")
RUN_FILE = "run.yaml"
EVENTS_FILE = "events.jsonl"
DISPATCH_FILE = "dispatch.jsonl"
FEEDBACK_FILE = "metrics/agent-feedback.jsonl"
PROJECTION_FILE = "projection.json"
LOCK_STATE_FILES = ("runner/run.lock.json", "runner/ready.lock.json")
RUN_LOCK_FILE = "runner/run.queue.lock"
READY_QUEUE_LOCK_FILE = "runner/ready.queue.lock"
CLAIM_QUEUE_LOCK_FILE = "runner/claim.queue.lock"
# Serializes one repo's shared run-worktree git index across concurrent agents in
# worktree mode: only one agent stages and commits in a given project at a time.
# Per repo, because each declared project has its own index and its own worktree —
# a single run-wide lock would make an unrelated project's commit wait (MC-1611).
# The name carries the repo id, so the file both locks a project and says which.
GIT_COMMIT_LOCK_PREFIX = "git.commit."
GIT_COMMIT_LOCK_SUFFIX = ".lock"
RUN_SOURCE_KEYS = ("source", "sourceBundle")

# Run-store schema version. v2 (MC-1542, single-owner tasks): the task status enum
# lost `changes_requested`/`testing`/`product`, `qualityGates` became `phases`, and
# roles became routing + directive packs. v3 (MC-1591, leases replace the roster):
# the persistent `agents` map is gone from run.yaml — assignment is a lease minted
# on the task record and the projection derives its workers/roster view from tasks.
# v4 (MC-1611, multi-repo runs): a run declares `sprintengine.vcs.repos` and every
# task targets one entry of it; the dead `vcs.repoRoot` field is gone.
# v5 (MC-2057, roleless runs): a task's `role` is optional and the fake `general`
# role is deleted. This is the ONE version step that migrates rather than rejects
# (`migrate_run_store`): `general` was a stand-in for "no role", so a v4 run that
# used it describes a run this build can still read — it only spells absence
# differently. Every OTHER step stays the pre-release clean break: a store older
# than v4 is REJECTED (`assert_store_is_current`) and the remedy is deleting the
# team dir.
RUN_SCHEMA_VERSION = 5
# The one version this build upgrades in place, and the shape it upgrades from.
MIGRATABLE_RUN_SCHEMA_VERSION = 4
# The fake role v5 deletes, and what each of its stored spellings becomes.
_LEGACY_ROLELESS_ROLE = "general"

# Post-implementation phase vocabulary. `review` is the only shipped phase; the
# list shape is kept so a future phase slots in without a schema change.
# MIRRORED in sprintengine_core/tool/constants.py (VALID_TASK_PHASES) and
# src/renderer/src/utils/sprintengine.ts — a contract test pins all three.
VALID_TASK_PHASES = ("review",)
# The phase list a task inherits when the run records no `defaultPhases`.
DEFAULT_RUN_PHASES = ("review",)
# The run's phase ceiling, written once at init. Optional: absent means the engine
# default. Round-trips through run.yaml + projection like RUN_SOURCE_KEYS.
RUN_PHASE_KEYS = ("defaultPhases",)
# Hot-seam signals already reported to the planner (MC-1822). Run-level, and it
# must PERSIST: the whole point is that the third landing on a seam is reported
# once, so an in-memory-only log would re-raise the same seam on every publish
# after it. Round-trips through run.yaml like RUN_SOURCE_KEYS.
RUN_SEAM_KEYS = ("seamSignals",)

# Task comment vocabulary — defined here once and imported by
# sprintengine_core/tool/constants.py and sprintengine_core/tool/comments.py, so the
# set cannot drift between validation, the prompt queues, and the projection.
# `test_feedback`/`product_feedback` are gone (MC-1829): the tester- and
# product-owned review statuses they belonged to died with MC-1542.
VALID_TASK_COMMENT_TYPES = frozenset({
    "implementation_summary",
    "implementation_response",
    "review_feedback",
    "architect_feedback",
    "needs_input",
    "user_note",
    "system_note",
})
# Comment types that carry review feedback an owner must answer. `needs_input`
# joins them in the rework queue: it also blocks the owner, but it is a blocker
# question rather than a finding.
FEEDBACK_COMMENT_TYPES = frozenset({"review_feedback", "architect_feedback"})
REWORK_COMMENT_TYPES = FEEDBACK_COMMENT_TYPES | {"needs_input"}


# Task-scoped roster identity (no slot recycling): a worker roster id owns at
# most one task for its whole lifetime. `per_task` is the only policy today; the
# field is durable and versioned so a future multi-task policy can relax the
# claim guard without a data migration. An absent policy reads as `per_task`.
WORKER_ASSIGNMENT_PER_TASK = "per_task"
WORKER_ASSIGNMENT_POLICIES = (WORKER_ASSIGNMENT_PER_TASK,)
DEFAULT_ROSTER_POLICY = {"workerAssignment": WORKER_ASSIGNMENT_PER_TASK}
DEFAULT_RUNNER_POLICY = {
    # The CLI watch loop this policy configured was retired with the CLI-runner
    # era (MC-1827); nothing in the engine polls any more. `cliWatchPolling`
    # survives as the run.yaml hint the app writes when the automation mode
    # changes, and the mobile snapshot reads it back to derive that mode.
    # Multicode's supervisor ignores it and decides spawning from local
    # renderer autoState. Legacy `mode: auto|off` is read as a fallback by
    # `normalize_runner_policy`.
    "cliWatchPolling": "disabled",
    "pollIntervalSeconds": 10,
    "idleBackoffSeconds": 30,
    "maxBackoffSeconds": 120,
    "stopWhenComplete": True,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_status(value: str, allowed: Iterable[str], label: str) -> str:
    status = str(value).strip()
    valid = set(allowed)
    if status not in valid:
        raise ValueError(f"Invalid {label} status {status!r}; expected one of: {', '.join(sorted(valid))}.")
    return status


def validate_task_status(value: str) -> str:
    return validate_status(value, TASK_STATUSES, "task")


def validate_artifact_status(value: str) -> str:
    return validate_status(value, ARTIFACT_STATUSES, "artifact")


def task_repo(task: dict[str, Any]) -> str:
    """The repo a task targets, defaulting to the run's primary repo.

    The one accessor every reader shares, so no caller re-spells the default.
    Membership in the run's declared repos is enforced at creation and at claim
    (`ensure_task_repo_declared`), never here: this reads a task record that is
    already stored, and a stored task must read back the same way whatever the
    run declares today.
    """
    return str(task.get("repo") or "").strip() or DEFAULT_TASK_REPO


def git_commit_lock_file(repo_id: str) -> str:
    """The commit lock for one declared repo. The single site that spells the name."""
    return f"runner/{GIT_COMMIT_LOCK_PREFIX}{repo_id}{GIT_COMMIT_LOCK_SUFFIX}"


def validate_project_relative_path(value: str, *, field: str = "path") -> str:
    raw = str(value).strip()
    if not raw:
        raise ValueError(f"{field} cannot be empty.")
    path = Path(raw)
    if path.is_absolute() or raw.startswith(("/", "\\")):
        raise ValueError(f"{field} must use project-root-relative paths, not absolute paths: {raw}")
    if re.match(r"^[A-Za-z]:[\\/]", raw) or raw.startswith("\\\\"):
        raise ValueError(f"{field} must not use a machine-specific path: {raw}")
    if raw == "~" or raw.startswith("~/") or raw.startswith("~\\"):
        raise ValueError(f"{field} must not use a home-directory path: {raw}")
    if "://" in raw:
        raise ValueError(f"{field} must be a project-root-relative file path, not a URL: {raw}")
    if any(part == ".." for part in path.parts):
        raise ValueError(f"{field} must not traverse outside the project root: {raw}")
    return path.as_posix()


def normalize_phase_list(raw: Any, *, field: str) -> list[str]:
    """Validate an ordered, de-duplicated phase list.

    An empty list is meaningful (`[]` = no post-implementation phase), so callers
    distinguish "absent" (inherit) from "explicitly empty" before calling here.
    """
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be an array of phase names.")
    phases: list[str] = []
    for entry in raw:
        phase = str(entry or "").strip()
        if not phase:
            continue
        if phase not in VALID_TASK_PHASES:
            raise ValueError(
                f"{field} contains unknown phase {phase!r}; expected one of: {', '.join(VALID_TASK_PHASES)}."
            )
        if phase not in phases:
            phases.append(phase)
    return phases


def run_default_phases(state: dict[str, Any]) -> list[str]:
    """The run's phase list: default for tasks that pass none, and their ceiling.

    An absent key reads as the engine default. An explicitly empty list is
    honoured: every publish with changes then routes straight to `done`.
    """
    raw = state.get("defaultPhases")
    if not isinstance(raw, list):
        return list(DEFAULT_RUN_PHASES)
    return normalize_phase_list(raw, field="defaultPhases")


class RunStoreVersionError(ValueError):
    """A run store written before the current schema version."""


def run_schema_version(run: dict[str, Any]) -> int:
    try:
        return int(run.get("schemaVersion") or 1)
    except (TypeError, ValueError):
        return 1


def assert_store_is_current(run: dict[str, Any], team_dir: Path) -> None:
    """Reject an out-of-date run store loudly, at every surface that reads one.

    Decision 8 (pre-release clean break): old stores are local runtime state and
    are never migrated. The remedy is deleting the team folder. Raising here — in
    the one function both `state_from_folder_store` and `build_projection` call —
    means the board, wizard, backlog links, and CLI all get the same readable
    message instead of a silent crash or a blank board. v4 (MC-1611) broke on
    multi-repo: a run now declares a list of repos, so a v3 store — whose one
    repo is described by fields this build no longer writes — cannot be read.

    v5 (MC-2057) is the exception and stays one: a v4 store is UPGRADED by
    `migrate_run_store` before it reaches here, because `general` was only ever a
    stand-in for "no role" and such a run is fully describable in v5. Callers run
    the migration first; anything still below v5 at this point genuinely cannot
    be read.
    """
    version = run_schema_version(run)
    if version >= RUN_SCHEMA_VERSION:
        return
    raise RunStoreVersionError(
        f"Unsupported Sprint Engine run store (schemaVersion {version}, expected {RUN_SCHEMA_VERSION}). "
        "This pre-release store predates a breaking change (single-owner tasks, then "
        "leases replacing the roster, then sprints spanning more than one repository) "
        "and is never migrated. "
        f"Delete `{team_dir}` and re-run the sprint."
    )


def _migrated_roleless_agent_id(agent_id: Any) -> str:
    """v4 -> v5: an id that encoded the fake role becomes one that encodes none.

    `general` was the seat, `general-N` its workers, so they map onto the ids a
    roleless run mints today: `coordinator` and `agent-N`. Any other id is left
    exactly as it is — a role-based run's ids are untouched by this migration.
    """
    clean = str(agent_id or "").strip()
    if clean == _LEGACY_ROLELESS_ROLE:
        return "coordinator"
    if re.fullmatch(rf"{_LEGACY_ROLELESS_ROLE}-(\d+)", clean):
        return f"agent-{clean.split('-', 1)[1]}"
    return clean


def _migrate_roleless_record(record: dict[str, Any]) -> bool:
    """Strip the fake role from one task/lease/ledger record. True when changed.

    `role: general` becomes an OMITTED key, never `''` or null — the pinned v5
    representation of absent. Agent ids on the record move with it so the task's
    ownership and lease survive the rename.
    """
    changed = False
    if str(record.get("role") or "").strip() == _LEGACY_ROLELESS_ROLE:
        record.pop("role")
        changed = True
    for field in ("ownerAgentId", "lastImplementedByAgentId", "agentId", "workerId"):
        current = str(record.get(field) or "").strip()
        if not current:
            continue
        migrated = _migrated_roleless_agent_id(current)
        if migrated != current:
            record[field] = migrated
            changed = True
    lease = record.get("lease")
    if isinstance(lease, dict) and _migrate_roleless_record(lease):
        changed = True
    return changed


def migrate_run_store(team_dir: Path, run: dict[str, Any]) -> dict[str, Any]:
    """Upgrade a v4 store to v5 in place, or return `run` untouched (MC-2057).

    The only migrating version step this engine has (see RUN_SCHEMA_VERSION).
    A v4 run that used `general` was a roleless run spelling absence with a
    stand-in role, so it reads forward exactly: `configuredRoles: ['general']`
    becomes the empty list a roleless run records, every `role: general` key is
    dropped, and `general`/`general-N` ids become `coordinator`/`agent-N`. The
    task graph, dependencies, ownership, evidence, and lease state are otherwise
    untouched — nothing is rebuilt, only the deleted role is removed.

    Idempotent and version-guarded, so the read paths can call it unconditionally
    and it does no disk work on the store it has already upgraded. A v4 run that
    never used `general` (every role-based run on disk) is stamped v5 and nothing
    else about it changes.
    """
    if run_schema_version(run) != MIGRATABLE_RUN_SCHEMA_VERSION:
        return run

    migrated = copy.deepcopy(run)
    configured = migrated.get("configuredRoles")
    if isinstance(configured, list):
        migrated["configuredRoles"] = [
            role for role in configured if str(role or "").strip() != _LEGACY_ROLELESS_ROLE
        ]
    # The per-role runtime map is keyed by role, so its `general` entry becomes
    # unreachable the moment the role is gone. Drop it rather than leave a key
    # nothing can look up.
    runtimes = migrated.get("roleRuntimes")
    if isinstance(runtimes, dict):
        runtimes.pop(_LEGACY_ROLELESS_ROLE, None)
    for entry in migrated.get("tasks") or []:
        if isinstance(entry, dict):
            _migrate_roleless_record(entry)
    migrated["schemaVersion"] = RUN_SCHEMA_VERSION
    atomic_write_yaml(team_dir / RUN_FILE, migrated)

    # The materialized task files are the semantic record (run.yaml carries only
    # the graph), so they carry the same rename. Written per file, in place, so a
    # task keeps its status folder and queue position.
    for status in TASK_STATUSES:
        folder = team_dir / "tasks" / status
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.json")):
            task = read_json_file(path)
            if _migrate_roleless_record(task):
                atomic_write_json(path, task)

    # The dispatch ledger is keyed by (agentId, taskId) — `derive_worker_views`
    # rebuilds each worker's `currentDispatch` from it — so its ids must move with
    # the lease's or a migrated in-flight worker would show no dispatch at all.
    # `events.jsonl` is deliberately NOT migrated: it is pure history whose ids
    # live inside human-readable messages, and rewriting one without the other
    # would leave each record contradicting itself.
    dispatch_path = team_dir / DISPATCH_FILE
    if dispatch_path.exists():
        records = read_jsonl_file(dispatch_path)
        # Materialize before testing: `any()` over a generator would short-circuit
        # on the first changed record and leave the rest of the ledger unmigrated.
        changed = [_migrate_roleless_record(record) for record in records]
        if any(changed):
            # Same encoding as `append_jsonl`, so a migrated ledger is byte-identical
            # to one this build would have written.
            atomic_write_text(
                dispatch_path,
                "".join(f"{json.dumps(record, sort_keys=True)}\n" for record in records),
            )
    return migrated


def _bool_value(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def _positive_int(value: Any, fallback: int, *, minimum: int = 1, maximum: int = 3600) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def normalize_runner_policy(raw: Any) -> dict[str, Any]:
    """Normalize the on-disk runner policy."""
    policy = raw if isinstance(raw, dict) else {}
    raw_value = policy.get("cliWatchPolling")
    if raw_value is None:
        raw_value = DEFAULT_RUNNER_POLICY["cliWatchPolling"]
    cli_watch_polling = str(raw_value).strip().lower()
    if cli_watch_polling not in {"enabled", "disabled"}:
        cli_watch_polling = str(DEFAULT_RUNNER_POLICY["cliWatchPolling"])
    return {
        "cliWatchPolling": cli_watch_polling,
        "pollIntervalSeconds": _positive_int(policy.get("pollIntervalSeconds"), int(DEFAULT_RUNNER_POLICY["pollIntervalSeconds"])),
        "idleBackoffSeconds": _positive_int(policy.get("idleBackoffSeconds"), int(DEFAULT_RUNNER_POLICY["idleBackoffSeconds"])),
        "maxBackoffSeconds": _positive_int(policy.get("maxBackoffSeconds"), int(DEFAULT_RUNNER_POLICY["maxBackoffSeconds"])),
        "stopWhenComplete": _bool_value(policy.get("stopWhenComplete"), bool(DEFAULT_RUNNER_POLICY["stopWhenComplete"])),
    }


def normalize_roster_policy(raw: Any) -> dict[str, Any]:
    """Normalize the durable roster policy, defaulting an absent policy to per_task.

    Unknown or missing `workerAssignment` values fall back to `per_task` so a
    legacy run.yaml with no `rosterPolicy` key behaves like a task-scoped run.
    """
    policy = raw if isinstance(raw, dict) else {}
    assignment = str(policy.get("workerAssignment") or "").strip()
    if assignment not in WORKER_ASSIGNMENT_POLICIES:
        assignment = WORKER_ASSIGNMENT_PER_TASK
    return {"workerAssignment": assignment}


def worker_assignment_policy(state: dict[str, Any]) -> str:
    """The run's worker-assignment policy id, defaulting to per_task."""
    return normalize_roster_policy(state.get("rosterPolicy"))["workerAssignment"]


def roster_is_configured_in_state(state: dict[str, Any]) -> bool:
    sprintengine = state.get("sprintengine") if isinstance(state.get("sprintengine"), dict) else {}
    return bool(sprintengine.get("rosterConfigured"))


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def atomic_write_yaml(path: Path, payload: Any) -> None:
    atomic_write_text(path, yaml.safe_dump(payload, sort_keys=False))


def atomic_move(source: Path, destination: Path) -> None:
    if not source.exists():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")


def append_event(team_dir: Path, event: dict[str, Any]) -> Path:
    append_jsonl(team_dir / EVENTS_FILE, event)
    return team_dir / EVENTS_FILE


def normalize_current_dispatch(raw: Any) -> dict[str, Any] | None:
    # `role` is NOT required (MC-2057). A roleless run dispatches tasks that carry
    # no role, so requiring one here would make `currentDispatch` permanently null
    # for every worker on such a run — the board would show nobody doing anything.
    # It is omitted rather than emitted as '', like every other absent role.
    if not isinstance(raw, dict):
        return None
    dispatch_id = str(raw.get("dispatchId") or raw.get("id") or "").strip()
    target_kind = str(raw.get("targetKind") or raw.get("kind") or "").strip()
    role = str(raw.get("role") or "").strip()
    reason = str(raw.get("reason") or "").strip()
    if not dispatch_id or not target_kind or not reason:
        return None
    dispatch = {
        "dispatchId": dispatch_id,
        "targetKind": target_kind,
        **({"role": role} if role else {}),
        "reason": reason,
    }
    for key in ("taskId", "assignedAt"):
        value = str(raw.get(key) or "").strip()
        if value:
            dispatch[key] = value
    return dispatch


def dispatch_id_for_record(record: dict[str, Any]) -> str:
    target = record.get("target") if isinstance(record.get("target"), dict) else {}
    material = {
        "agentId": record.get("agentId"),
        "role": record.get("role"),
        "target": {"kind": target.get("kind"), "taskId": target.get("taskId")},
        "reason": record.get("reason"),
    }
    digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return f"DISP-{digest}"


def append_dispatch_records(team_dir: Path, records: list[dict[str, Any]]) -> Path:
    path = team_dir / DISPATCH_FILE
    if not records:
        if not path.exists():
            atomic_write_text(path, "")
        return path
    existing_ids = {
        str(record.get("id"))
        for record in read_jsonl_file(path)
        if isinstance(record, dict) and record.get("id")
    }
    for raw in records:
        if not isinstance(raw, dict):
            continue
        record = dict(raw)
        record["id"] = str(record.get("id") or dispatch_id_for_record(record))
        if record["id"] in existing_ids:
            continue
        append_jsonl(path, record)
        existing_ids.add(record["id"])
    return path


def initialize_run_store(
    team_dir: Path,
    *,
    name: str,
    goal: str = "",
    status: str = "planning",
    roster_configured: bool = False,
) -> Path:
    team_dir.mkdir(parents=True, exist_ok=True)
    for task_status in TASK_STATUSES:
        (team_dir / "tasks" / task_status).mkdir(parents=True, exist_ok=True)
    for artifact_status in ARTIFACT_STATUSES:
        (team_dir / "artifacts" / artifact_status).mkdir(parents=True, exist_ok=True)
    for support_dir in SUPPORT_DIRS:
        (team_dir / support_dir).mkdir(parents=True, exist_ok=True)

    run_path = team_dir / RUN_FILE
    if not run_path.exists():
        atomic_write_yaml(
            run_path,
            {
                "schemaVersion": RUN_SCHEMA_VERSION,
                "name": name,
                "goal": goal,
                "status": status,
                "rosterConfigured": roster_configured,
                "graphPolicy": {"readiness": "dependency"},
                "runner": dict(DEFAULT_RUNNER_POLICY),
                "roles": {},
                "sprintengine": {
                    "name": name,
                    "goal": goal,
                    "status": status,
                    "rosterConfigured": roster_configured,
                },
                "tasks": [],
                "artifacts": [],
                "creation": {"source": "folder_store", "createdAt": now_iso()},
            },
        )
    events_path = team_dir / EVENTS_FILE
    if not events_path.exists():
        atomic_write_text(events_path, "")
    dispatch_path = team_dir / DISPATCH_FILE
    if not dispatch_path.exists():
        atomic_write_text(dispatch_path, "")
    feedback_path = team_dir / FEEDBACK_FILE
    if not feedback_path.exists():
        atomic_write_text(feedback_path, "")
    for lock_file in LOCK_STATE_FILES:
        path = team_dir / lock_file
        if not path.exists():
            atomic_write_json(path, {"status": "idle", "updatedAt": now_iso()})
    return run_path


def task_filename(task_id: str, order: int | None = None) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(task_id).strip())
    if not safe_id:
        raise ValueError("Task id cannot be empty.")
    if order is None:
        return f"{safe_id}.json"
    return f"{order:04d}-{safe_id}.json"


def load_run_yaml(team_dir: Path) -> dict[str, Any]:
    run_path = team_dir / RUN_FILE
    if not run_path.exists():
        return {}
    loaded = yaml.safe_load(run_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise ValueError(f"Unexpected run.yaml shape in {run_path}")
    return loaded


def read_json_file(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON file {path}: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"Unexpected JSON object shape in {path}")
    return parsed


def read_jsonl_file(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSONL record in {path}:{line_number}: {exc.msg}") from exc
        if isinstance(parsed, dict):
            records.append(parsed)
    return records


def task_graph_from_run(team_dir: Path) -> dict[str, list[str]]:
    run = load_run_yaml(team_dir)
    graph: dict[str, list[str]] = {}
    for entry in run.get("tasks", []) or []:
        if not isinstance(entry, dict):
            continue
        task_id = str(entry.get("id") or "").strip()
        if not task_id:
            continue
        graph[task_id] = [str(dep).strip() for dep in entry.get("dependsOn", []) or [] if str(dep).strip()]
    return graph


def task_graph_from_tasks(tasks: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    graph: dict[str, list[str]] = {}
    for task in tasks:
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        graph[task_id] = [str(dep).strip() for dep in task.get("dependsOn", []) or [] if str(dep).strip()]
    return graph


def topological_task_ids(graph: dict[str, list[str]]) -> list[str]:
    missing = sorted({dep for deps in graph.values() for dep in deps if dep not in graph})
    if missing:
        raise ValueError(f"Task graph references unknown dependencies: {', '.join(missing)}")

    temporary: set[str] = set()
    permanent: set[str] = set()
    ordered: list[str] = []

    def visit(task_id: str, trail: list[str]) -> None:
        if task_id in permanent:
            return
        if task_id in temporary:
            cycle_start = trail.index(task_id) if task_id in trail else 0
            cycle = [*trail[cycle_start:], task_id]
            raise ValueError(f"Task dependency cycle detected: {' -> '.join(cycle)}")
        temporary.add(task_id)
        for dep_id in sorted(graph.get(task_id, [])):
            visit(dep_id, [*trail, task_id])
        temporary.remove(task_id)
        permanent.add(task_id)
        ordered.append(task_id)

    for task_id in sorted(graph):
        visit(task_id, [])
    return ordered


def validate_acyclic_task_graph(tasks: Iterable[dict[str, Any]]) -> list[str]:
    return topological_task_ids(task_graph_from_tasks(tasks))


def task_is_ready_for_queue(tasks_by_id: dict[str, dict[str, Any]], task: dict[str, Any], graph: dict[str, list[str]]) -> bool:
    if task.get("status") != "todo" or task.get("ownerAgentId"):
        return False
    if _bool_value(task.get("needsTriage"), False):
        return False
    for dep_id in graph.get(str(task.get("id")), []):
        dependency = tasks_by_id.get(dep_id)
        if dependency is None or dependency.get("status") != "done":
            return False
    return True


def sync_run_yaml_from_state(team_dir: Path, state: dict[str, Any]) -> None:
    sprintengine = state.get("sprintengine") if isinstance(state.get("sprintengine"), dict) else {}
    roles = state.get("roles") if isinstance(state.get("roles"), dict) else {}
    run = load_run_yaml(team_dir)
    # Per-role execution runtime map (model/cli), written once at init from the
    # roster's per-role model selection; preserve any existing run.yaml value
    # when the in-memory state has not (re)loaded it.
    role_runtimes = (
        state.get("roleRuntimes")
        if isinstance(state.get("roleRuntimes"), dict)
        else (run.get("roleRuntimes") if isinstance(run.get("roleRuntimes"), dict) else {})
    )
    # The run's explicit enabled-role set (written at init); preserve any existing
    # run.yaml value when in-memory state has not (re)loaded it. It is the set of
    # roles a task may be tagged with (`plan.add_task` enforces membership).
    configured_roles = (
        state.get("configuredRoles")
        if isinstance(state.get("configuredRoles"), list)
        else (run.get("configuredRoles") if isinstance(run.get("configuredRoles"), list) else None)
    )
    creation = run.get("creation") if isinstance(run.get("creation"), dict) else {}
    # Durable worker-assignment policy; normalized (absent -> per_task) and always
    # written so run.yaml is self-describing for task-scoped roster ids.
    roster_policy = normalize_roster_policy(
        state.get("rosterPolicy") if isinstance(state.get("rosterPolicy"), dict) else run.get("rosterPolicy")
    )
    runner_policy = normalize_runner_policy(state.get("runner") if isinstance(state.get("runner"), dict) else run.get("runner"))
    run.update(
        {
            "schemaVersion": RUN_SCHEMA_VERSION,
            "name": sprintengine.get("name") or team_dir.name,
            "goal": sprintengine.get("goal") or "",
            "status": sprintengine.get("status") or "planning",
            "rosterConfigured": bool(sprintengine.get("rosterConfigured")),
            "graphPolicy": run.get("graphPolicy") or {"readiness": "dependency"},
            "rosterPolicy": roster_policy,
            "runner": runner_policy,
            "roles": roles,
            "roleRuntimes": role_runtimes,
            "sprintengine": sprintengine,
            "tasks": [
                {
                    "id": task.get("id"),
                    "status": task.get("status"),
                    # Omitted when the task carries no role (MC-2057) — the same
                    # absent-is-an-omitted-key rule the task record itself holds,
                    # so run.yaml never persists a null role for a roleless run.
                    **({"role": task["role"]} if str(task.get("role") or "").strip() else {}),
                    "dependsOn": [str(dep) for dep in task.get("dependsOn", []) or []],
                    "needsTriage": _bool_value(task.get("needsTriage"), False),
                }
                for task in state.get("tasks", []) or []
                if isinstance(task, dict) and task.get("id")
            ],
            "artifacts": [
                {
                    "id": artifact.get("id"),
                    "status": artifact.get("status"),
                    "kind": artifact.get("kind"),
                    "taskId": artifact.get("taskId"),
                }
                for artifact in state.get("artifacts", []) or []
                if isinstance(artifact, dict) and artifact.get("id")
            ],
            "updatedAt": now_iso(),
        }
    )
    for key in RUN_SOURCE_KEYS + RUN_PHASE_KEYS + RUN_SEAM_KEYS:
        if key in state:
            run[key] = state[key]
    if configured_roles is not None:
        run["configuredRoles"] = configured_roles
    else:
        run.pop("configuredRoles", None)
    # v3 (MC-1591): the persistent `agents` map is gone — assignment is a lease on
    # the task record and the projection derives its workers/roster view from tasks.
    # Drop any `agents` key an older run.yaml still carries so it never round-trips.
    run.pop("agents", None)
    run["creation"] = creation or {"source": "folder_store", "createdAt": now_iso()}
    atomic_write_yaml(team_dir / RUN_FILE, run)


def clear_task_status_folders(team_dir: Path) -> None:
    for status in TASK_STATUSES:
        folder = team_dir / "tasks" / status
        folder.mkdir(parents=True, exist_ok=True)
        for child in folder.glob("*.json"):
            child.unlink()


def clear_artifact_status_folders(team_dir: Path) -> None:
    for status in ARTIFACT_STATUSES:
        folder = team_dir / "artifacts" / status
        folder.mkdir(parents=True, exist_ok=True)
        for child in folder.glob("*.json"):
            child.unlink()


def status_folder_for_task(task: dict[str, Any], ready_ids: set[str]) -> str:
    """The folder a task materializes into.

    An UNKNOWN status is a hard error, not a silent coercion to `todo` (decision 8:
    no read-side tolerance for the retired `changes_requested`/`testing`/`product`).
    A v1 store never gets here — `assert_store_is_current` rejects it first — but a
    hand-edited or programmatically-built v2 state would otherwise surface a bogus
    rework task as ordinary ready work while `run.yaml` kept the bogus status.
    `ready` is the materialized queue folder, never a semantic status, so a task
    carrying it reads as `todo`.
    """
    task_id = str(task.get("id") or "")
    status = str(task.get("status") or "todo")
    if status == "ready":
        status = "todo"
    if status not in TASK_STATUSES:
        raise ValueError(
            f"Task {task_id or '(unknown)'} has invalid status {status!r}; "
            f"expected one of: {', '.join(sorted(set(TASK_STATUSES) - {'ready'}))}."
        )
    if task_id in ready_ids:
        return "ready"
    return status


def write_materialized_task_files(team_dir: Path, tasks: list[dict[str, Any]], ordered_ids: list[str], ready_ids: set[str]) -> None:
    clear_task_status_folders(team_dir)
    order_by_id = {task_id: index + 1 for index, task_id in enumerate(ordered_ids)}
    for task in tasks:
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        folder_status = status_folder_for_task(task, ready_ids)
        stored = dict(task)
        stored["needsTriage"] = _bool_value(stored.get("needsTriage"), False)
        stored["status"] = folder_status
        if folder_status == "ready":
            stored["stateStatus"] = task.get("status")
        target = team_dir / "tasks" / folder_status / task_filename(task_id, order_by_id.get(task_id))
        atomic_write_json(target, stored)


def artifact_filename(artifact_id: str) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(artifact_id).strip())
    if not safe_id:
        raise ValueError("Artifact id cannot be empty.")
    return f"{safe_id}.json"


def status_folder_for_artifact(artifact: dict[str, Any]) -> str:
    status = str(artifact.get("status") or "draft")
    if status not in ARTIFACT_STATUSES:
        status = "draft"
    return status


def write_materialized_artifact_files(team_dir: Path, artifacts: list[dict[str, Any]]) -> None:
    clear_artifact_status_folders(team_dir)
    for artifact in artifacts:
        artifact_id = str(artifact.get("id") or "").strip()
        if not artifact_id:
            continue
        folder_status = status_folder_for_artifact(artifact)
        stored = dict(artifact)
        stored["status"] = folder_status
        target = team_dir / "artifacts" / folder_status / artifact_filename(artifact_id)
        atomic_write_json(target, stored)


def sync_events_jsonl(team_dir: Path, events: list[dict[str, Any]]) -> None:
    lines = [json.dumps(event, sort_keys=True) for event in events if isinstance(event, dict)]
    atomic_write_text(team_dir / EVENTS_FILE, ("\n".join(lines) + "\n") if lines else "")


def refresh_ready_queue(team_dir: Path, state: dict[str, Any]) -> dict[str, Any]:
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    graph = task_graph_from_run(team_dir)
    if set(graph) != {str(task.get("id")) for task in tasks if task.get("id")}:
        graph = task_graph_from_tasks(tasks)
    ordered_ids = topological_task_ids(graph)
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    ready_ids = {
        task_id
        for task_id in ordered_ids
        if task_id in tasks_by_id and task_is_ready_for_queue(tasks_by_id, tasks_by_id[task_id], graph)
    }
    write_materialized_task_files(team_dir, tasks, ordered_ids, ready_ids)
    return {"orderedTaskIds": ordered_ids, "readyTaskIds": [task_id for task_id in ordered_ids if task_id in ready_ids]}


def sync_state_to_store(team_dir: Path, state: dict[str, Any], *, state_path: Path | None = None) -> dict[str, Any]:
    initialize_run_store(
        team_dir,
        name=str(state.get("sprintengine", {}).get("name") or team_dir.name),
        goal=str(state.get("sprintengine", {}).get("goal") or ""),
        status=str(state.get("sprintengine", {}).get("status") or "planning"),
        roster_configured=bool(state.get("sprintengine", {}).get("rosterConfigured")),
    )
    validate_acyclic_task_graph([task for task in state.get("tasks", []) or [] if isinstance(task, dict)])
    if state_path is not None:
        # Git-truth repo reconciliation (MC-1752). Never blocks a state write:
        # a missing git binary, an unprovisioned worktree, or any probe failure
        # simply leaves the entry as it was.
        try:
            from sprintengine_core.tool.shell import reconcile_repo_commit_state_from_git

            reconcile_repo_commit_state_from_git(state, state_path)
        except Exception:
            pass
    with FolderLock(team_dir / READY_QUEUE_LOCK_FILE):
        pending_dispatch_records = [
            record for record in state.pop("_dispatchRecords", []) if isinstance(record, dict)
        ]
        sync_run_yaml_from_state(team_dir, state)
        refresh = refresh_ready_queue(team_dir, state)
        write_materialized_artifact_files(team_dir, [artifact for artifact in state.get("artifacts", []) or [] if isinstance(artifact, dict)])
        sync_events_jsonl(team_dir, [event for event in state.get("events", []) or [] if isinstance(event, dict)])
        append_dispatch_records(team_dir, pending_dispatch_records)
        write_projection_file(team_dir, state, state_path=state_path)
        return refresh


def materialized_ready_task_ids(team_dir: Path) -> list[str]:
    ready_dir = team_dir / "tasks" / "ready"
    if not ready_dir.exists():
        return []
    ready_ids: list[str] = []
    for path in sorted(ready_dir.glob("*.json")):
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid ready task file {path}: {exc.msg}") from exc
        if not isinstance(parsed, dict) or not parsed.get("id"):
            raise ValueError(f"Invalid ready task file {path}: missing task id")
        ready_ids.append(str(parsed["id"]))
    return ready_ids


def _list_materialized_records(team_dir: Path, root: str, statuses: Iterable[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for status in statuses:
        folder = team_dir / root / status
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.json")):
            record = read_json_file(path)
            record.setdefault("status", status)
            record["folderStatus"] = status
            records.append(record)
    return records


def _tasks_from_folder_store(team_dir: Path) -> list[dict[str, Any]]:
    tasks = _list_materialized_records(team_dir, "tasks", TASK_STATUSES)
    return sorted(tasks, key=lambda task: str(task.get("id") or ""))


def _artifacts_from_folder_store(team_dir: Path) -> list[dict[str, Any]]:
    artifacts = _list_materialized_records(team_dir, "artifacts", ARTIFACT_STATUSES)
    return sorted(artifacts, key=lambda artifact: str(artifact.get("id") or ""))


def _semantic_task_from_folder_record(task: dict[str, Any]) -> dict[str, Any]:
    semantic = dict(task)
    folder_status = str(semantic.get("folderStatus") or semantic.get("status") or "todo")
    semantic["status"] = str(semantic.get("stateStatus") or folder_status)
    semantic.pop("folderStatus", None)
    semantic.pop("stateStatus", None)
    return semantic


def _semantic_artifact_from_folder_record(artifact: dict[str, Any]) -> dict[str, Any]:
    semantic = dict(artifact)
    semantic["status"] = str(semantic.get("folderStatus") or semantic.get("status") or "draft")
    semantic.pop("folderStatus", None)
    return semantic


def state_from_folder_store(team_dir: Path) -> dict[str, Any]:
    run = load_run_yaml(team_dir)
    if not run:
        raise FileNotFoundError(team_dir / RUN_FILE)
    run = migrate_run_store(team_dir, run)
    assert_store_is_current(run, team_dir)

    sprintengine = run.get("sprintengine") if isinstance(run.get("sprintengine"), dict) else {}
    reconstructed_sprintengine = dict(sprintengine)
    reconstructed_sprintengine.setdefault("name", run.get("name") or team_dir.name)
    reconstructed_sprintengine.setdefault("goal", run.get("goal") or "")
    reconstructed_sprintengine.setdefault("status", run.get("status") or "planning")
    reconstructed_sprintengine.setdefault("rosterConfigured", bool(run.get("rosterConfigured")))
    if isinstance(run.get("creation"), dict):
        reconstructed_sprintengine.setdefault("creation", run["creation"])

    roles = run.get("roles") if isinstance(run.get("roles"), dict) else {}
    role_runtimes = run.get("roleRuntimes") if isinstance(run.get("roleRuntimes"), dict) else {}
    task_order = {
        str(entry.get("id")): index
        for index, entry in enumerate(run.get("tasks", []) or [])
        if isinstance(entry, dict) and entry.get("id")
    }
    tasks = [_semantic_task_from_folder_record(task) for task in _tasks_from_folder_store(team_dir)]
    tasks.sort(key=lambda task: task_order.get(str(task.get("id") or ""), len(task_order)))
    # No `agents` key (MC-1591): assignment is a lease on each task record and the
    # projection derives its workers/roster view from those leases.
    state = {
        "sprintengine": reconstructed_sprintengine,
        "rosterPolicy": normalize_roster_policy(run.get("rosterPolicy")),
        "runner": normalize_runner_policy(run.get("runner")),
        "tasks": tasks,
        "artifacts": [_semantic_artifact_from_folder_record(artifact) for artifact in _artifacts_from_folder_store(team_dir)],
        "events": read_jsonl_file(team_dir / EVENTS_FILE),
        "dispatches": read_jsonl_file(team_dir / DISPATCH_FILE),
        "roles": roles,
        "roleRuntimes": role_runtimes,
    }
    # Only reconstruct `configuredRoles` when present so a run that never recorded
    # one stays absent (its roster boundary then no-ops).
    if isinstance(run.get("configuredRoles"), list):
        state["configuredRoles"] = run["configuredRoles"]
    for key in RUN_SOURCE_KEYS + RUN_PHASE_KEYS + RUN_SEAM_KEYS:
        if key in run:
            state[key] = run[key]
    return state


def _normalize_projection_task(task: dict[str, Any], *, board_column: str) -> dict[str, Any]:
    semantic_status = str(task.get("stateStatus") or task.get("status") or "todo")
    projected = dict(task)
    projected["status"] = board_column
    projected["stateStatus"] = semantic_status
    projected["boardColumn"] = board_column
    projected.setdefault("dependsOn", [])
    projected.setdefault("ownedPaths", [])
    projected["repo"] = task_repo(task)
    projected.setdefault("acceptanceCriteria", [])
    projected.setdefault("implementationNotes", [])
    projected.setdefault("notes", [])
    projected.setdefault("evidence", {})
    projected.setdefault("comments", [])
    projected.setdefault("activity", [])
    projected["needsTriage"] = _bool_value(projected.get("needsTriage"), False)
    return projected


def _projection_comment_time(comment: dict[str, Any]) -> str:
    return str(comment.get("createdAt") or "")


def _projection_latest_comments(task: dict[str, Any], limit: int = 5) -> list[dict[str, Any]]:
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    clean_comments = [comment for comment in comments if isinstance(comment, dict)]
    return sorted(clean_comments, key=_projection_comment_time, reverse=True)[:limit]


def _projection_open_feedback(task: dict[str, Any], limit: int = 10) -> list[dict[str, Any]]:
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    open_comments = []
    for comment in comments:
        if not isinstance(comment, dict) or comment.get("type") not in FEEDBACK_COMMENT_TYPES:
            continue
        data = comment.get("data") if isinstance(comment.get("data"), dict) else {}
        if data.get("status", "open") == "open":
            open_comments.append(comment)
    return sorted(open_comments, key=_projection_comment_time, reverse=True)[:limit]


def _projection_recorded_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    recorded = []
    for artifact in artifacts:
        if artifact.get("status") != "recorded":
            continue
        recorded.append({
            "id": artifact.get("id"),
            "kind": artifact.get("kind"),
            "title": artifact.get("title"),
            "path": artifact.get("path"),
            "createdBy": artifact.get("createdBy"),
            "createdAt": artifact.get("createdAt"),
        })
    return recorded


def _build_board(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    columns = {status: {"count": 0, "taskIds": []} for status in TASK_STATUSES}
    for task in tasks:
        column = str(task.get("boardColumn") or task.get("folderStatus") or task.get("status") or "todo")
        if column not in columns:
            column = "todo"
        columns[column]["count"] += 1
        if task.get("id"):
            columns[column]["taskIds"].append(str(task["id"]))
    return {
        "columns": columns,
        "counts": {status: data["count"] for status, data in columns.items()},
        "readyTaskIds": list(columns["ready"]["taskIds"]),
    }


def _artifact_counts(artifacts: list[dict[str, Any]]) -> dict[str, int]:
    counts = {status: 0 for status in ARTIFACT_STATUSES}
    for artifact in artifacts:
        status = str(artifact.get("folderStatus") or artifact.get("status") or "draft")
        if status in counts:
            counts[status] += 1
    return counts


def _build_projection_run_summary(
    run: dict[str, Any],
    tasks: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    board: dict[str, Any],
) -> dict[str, Any]:
    completed = [task for task in tasks if task.get("stateStatus") == "done" or task.get("status") == "done"]
    artifact_counts = _artifact_counts(artifacts)
    return {
        "goal": run.get("goal") or "",
        "status": run.get("status") or "planning",
        "tasks": {
            "total": len(tasks),
            "completed": len(completed),
            "remaining": max(0, len(tasks) - len(completed)),
            "ready": board["counts"].get("ready", 0),
            "needsInput": board["counts"].get("needs_input", 0),
        },
        "artifacts": {
            "total": len(artifacts),
            "readyForReview": artifact_counts.get("ready_for_review", 0),
            "approved": artifact_counts.get("approved", 0),
            "changesRequested": artifact_counts.get("changes_requested", 0),
        },
        "completedTasks": [
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "summary": (task.get("evidence") if isinstance(task.get("evidence"), dict) else {}).get("summary") or "",
                "ownerAgentId": task.get("ownerAgentId"),
                "completedAt": task.get("completedAt"),
            }
            for task in completed
        ],
    }


def _projection_locks(team_dir: Path, state_path: Path | None) -> dict[str, Any]:
    lock_paths = {
        "runFile": (state_path or team_dir / RUN_FILE).with_suffix(".yaml.lock"),
        "run": team_dir / RUN_LOCK_FILE,
        "readyQueue": team_dir / READY_QUEUE_LOCK_FILE,
        "claimQueue": team_dir / CLAIM_QUEUE_LOCK_FILE,
        # One commit lock per declared repo, discovered rather than enumerated: the
        # lock files exist only while held (or stale, which is what this report is
        # for), and the repo id each one locks is in its name.
        **{
            f"gitCommit:{path.name[len(GIT_COMMIT_LOCK_PREFIX):-len(GIT_COMMIT_LOCK_SUFFIX)]}": path
            for path in sorted((team_dir / "runner").glob(f"{GIT_COMMIT_LOCK_PREFIX}*{GIT_COMMIT_LOCK_SUFFIX}"))
        },
    }
    lock_reports = []
    warnings = []
    for name, path in lock_paths.items():
        report = FolderLock(path).inspect()
        entry = {
            "name": name,
            "exists": report.exists,
            "stale": report.stale,
            "ageSeconds": report.ageSeconds,
            "owner": report.owner,
        }
        lock_reports.append(entry)
        if report.stale:
            warnings.append({"name": name, "message": f"{name} lock appears stale.", "ageSeconds": report.ageSeconds})

    state_files = {}
    for relative in LOCK_STATE_FILES:
        path = team_dir / relative
        if path.exists():
            try:
                state_files[Path(relative).stem] = read_json_file(path)
            except ValueError:
                state_files[Path(relative).stem] = {"status": "invalid"}
    return {"locks": lock_reports, "states": state_files, "warnings": warnings}


# Semantic task statuses that keep a task's assignment lease active. Mirrors
# ACTIVE_TASK_STATUSES in sprintengine_core/tool/constants.py: a task in one of
# these binds the worker holding its lease; done/canceled/todo do not.
ACTIVE_LEASE_STATUSES = ("in_progress", "review", "needs_input")

# A leased task's semantic status maps to the worker runtime status the four TS
# roster readers coerce (idle | running | needs_input | done | retired).
_LEASE_STATUS_TO_WORKER_STATUS = {
    "in_progress": "running",
    "review": "running",
    "needs_input": "needs_input",
}


def _latest_dispatch_by_agent_task(dispatches: Iterable[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    """Index the append-only dispatch ledger by (agentId, taskId), last write wins.

    Reconstructs a worker's `currentDispatch` for the derived roster without the
    deleted per-agent cursor state — the ledger is ordered, so the last record for
    a pair is the current one.
    """
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for record in dispatches or []:
        if not isinstance(record, dict):
            continue
        agent_id = str(record.get("agentId") or "").strip()
        target = record.get("target") if isinstance(record.get("target"), dict) else {}
        task_id = str(target.get("taskId") or "").strip()
        if agent_id and task_id:
            latest[(agent_id, task_id)] = record
    return latest


def _current_dispatch_from_ledger(record: dict[str, Any] | None) -> dict[str, Any] | None:
    """Shape a dispatch ledger record into the `currentDispatch` the readers parse."""
    if not isinstance(record, dict):
        return None
    target = record.get("target") if isinstance(record.get("target"), dict) else {}
    return normalize_current_dispatch({
        "dispatchId": record.get("id"),
        "targetKind": target.get("kind"),
        "role": record.get("role"),
        "reason": record.get("reason"),
        "taskId": target.get("taskId"),
        "assignedAt": record.get("timestamp"),
    })


def derive_worker_views(
    tasks: list[dict[str, Any]],
    dispatches: Iterable[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Reconstruct "who is doing what" from task records, no `agents` map (MC-1591).

    Assignment is a lease minted on the task record; `ownerAgentId` is the lease's
    denormalized owner and the reliable key (a task predating the lease field, or
    persisted with only the owner, still resolves). A worker holds an ACTIVE lease
    on the task it owns while that task is in_progress/review/needs_input, and is a
    recent worker of every task it last implemented. A done plan gate with no
    implementer stamp yields no worker — correct under the lazy roster: no
    lease/implementer means not assigned, and the role stays in `configuredRoles`.

    Returns a dict keyed by worker id carrying the union of fields the canonical
    `workers` view and the `roster` bridge need; `build_projection` shapes both
    from this one derivation so they cannot drift (plan decision D5).
    """
    latest_dispatch = _latest_dispatch_by_agent_task(dispatches)
    workers: dict[str, dict[str, Any]] = {}
    last_seen: dict[str, str] = {}

    def touch(worker_id: str, role: str, task_id: str, ordering: str) -> dict[str, Any]:
        entry = workers.get(worker_id)
        if entry is None:
            entry = {
                "role": role or "",
                "status": "idle",
                "currentTaskId": None,
                "lastOwnedTaskId": None,
                "ownedTaskIds": [],
                "currentDispatch": None,
            }
            workers[worker_id] = entry
        if role and not entry["role"]:
            entry["role"] = role
        if task_id and task_id not in entry["ownedTaskIds"]:
            entry["ownedTaskIds"].append(task_id)
        # lastOwnedTaskId tracks the most recently touched task by completion/start
        # timestamp; ISO strings sort chronologically, so a plain max is correct.
        if task_id and ordering >= last_seen.get(worker_id, ""):
            last_seen[worker_id] = ordering
            entry["lastOwnedTaskId"] = task_id
        return entry

    for task in tasks:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        semantic_status = str(task.get("stateStatus") or task.get("status") or "").strip()
        lease = task.get("lease") if isinstance(task.get("lease"), dict) else {}
        owner_id = str(task.get("ownerAgentId") or "").strip()
        task_role = str(task.get("role") or "").strip()
        ordering = str(task.get("completedAt") or task.get("startedAt") or "")

        lease_worker = str(lease.get("workerId") or "").strip() or owner_id
        if semantic_status in ACTIVE_LEASE_STATUSES and lease_worker:
            role = str(lease.get("role") or task_role).strip()
            entry = touch(lease_worker, role, task_id, ordering)
            entry["status"] = _LEASE_STATUS_TO_WORKER_STATUS.get(semantic_status, "running")
            entry["currentTaskId"] = task_id
            entry["currentDispatch"] = _current_dispatch_from_ledger(
                latest_dispatch.get((lease_worker, task_id))
            )
            # The repo the worker is currently working in, from the lease the claim
            # minted (MC-1611). A task predating the lease field falls back to the
            # task's own repo, so (role, repo) routing reads the same either way.
            entry["repo"] = str(lease.get("repo") or "").strip() or task_repo(task)
            session_id = str(lease.get("sessionId") or "").strip()
            if session_id:
                entry["sessionId"] = session_id
            for key in ("since", "heartbeatAt"):
                value = str(lease.get(key) or "").strip()
                if value:
                    entry[key] = value

        implementer = str(task.get("lastImplementedByAgentId") or "").strip()
        if implementer:
            touch(implementer, task_role, task_id, ordering)

    return workers


def _roster_entry_from_worker(worker: dict[str, Any]) -> dict[str, Any]:
    """Project a worker view onto the D5 `roster` bridge shape (the four TS readers
    parse role, status, currentTaskId, lastOwnedTaskId?, currentDispatch, ownedTaskIds)."""
    entry: dict[str, Any] = {
        "role": worker.get("role") or "",
        "status": worker.get("status") or "idle",
        "currentTaskId": worker.get("currentTaskId"),
        "currentDispatch": worker.get("currentDispatch"),
    }
    last_owned = str(worker.get("lastOwnedTaskId") or "").strip()
    if last_owned:
        entry["lastOwnedTaskId"] = last_owned
    owned = [str(task_id) for task_id in worker.get("ownedTaskIds") or [] if str(task_id).strip()]
    if owned:
        entry["ownedTaskIds"] = owned
    return entry


def build_projection(
    team_dir: Path,
    *,
    state_path: Path | None = None,
) -> dict[str, Any]:
    folder_store_ready = (team_dir / RUN_FILE).exists() and (team_dir / "tasks").exists()
    if folder_store_ready:
        source = "folder_store"
        run = migrate_run_store(team_dir, load_run_yaml(team_dir))
        assert_store_is_current(run, team_dir)
        raw_tasks = _tasks_from_folder_store(team_dir)
        tasks = [_normalize_projection_task(task, board_column=str(task.get("folderStatus") or task.get("status") or "todo")) for task in raw_tasks]
        artifacts = _artifacts_from_folder_store(team_dir)
        events = read_jsonl_file(team_dir / EVENTS_FILE)
        dispatches = read_jsonl_file(team_dir / DISPATCH_FILE)
        feedback = read_jsonl_file(team_dir / FEEDBACK_FILE)
        runner_policy = normalize_runner_policy(run.get("runner"))
    else:
        raise ValueError(f"Sprint Engine folder store is not initialized at {team_dir}.")

    artifacts_by_task: dict[str, list[dict[str, Any]]] = {}
    for artifact in artifacts:
        task_id = str(artifact.get("taskId") or "")
        if task_id:
            artifacts_by_task.setdefault(task_id, []).append(artifact)
    for task in tasks:
        task_id = str(task.get("id") or "")
        linked_artifacts = artifacts_by_task.get(task_id, [])
        task["artifacts"] = linked_artifacts
        task["latestComments"] = _projection_latest_comments(task)
        task["latestOpenFeedback"] = _projection_open_feedback(task)
        task["recordedArtifacts"] = _projection_recorded_artifacts(linked_artifacts)

    board = _build_board(tasks)
    locks = _projection_locks(team_dir, state_path)
    updated_at = run.get("updatedAt") or now_iso()
    run_sprintengine = run.get("sprintengine") if isinstance(run.get("sprintengine"), dict) else {}
    # The whole vcs dict rides into the projection verbatim — never reconstructed
    # field-by-field. That is the multi-repo seam (MC-1615): an unknown `vcs.repos`
    # array (schema-v4 multi-repo runs) reaches the renderer's normalizer and the
    # mobile snapshot without field loss, mirroring the TS pass-throughs in
    # normalizeSprintEngineVcs (state.ts) and buildVcsState (snapshot.ts). Do not
    # rebuild this into a fixed key list — that would silently strip repos.
    vcs = run_sprintengine.get("vcs") if isinstance(run_sprintengine.get("vcs"), dict) else None
    # Lease-derived "who is doing what" (MC-1591): the deleted `agents` map is
    # replaced by a view built from task leases. `workers` is canonical; `roster`
    # is the D5 bridge the four existing TS readers still parse, derived from the
    # SAME worker views so the two shapes cannot drift. An empty worker set yields
    # an empty roster (no phantom agents); the renderer's lazy-roster fallback owns
    # the pre-seat placeholder.
    worker_views = derive_worker_views(tasks, dispatches)
    roster = {worker_id: _roster_entry_from_worker(worker) for worker_id, worker in worker_views.items()}
    projection = {
        "ok": True,
        "projectionVersion": 1,
        "source": source,
        "generatedAt": now_iso(),
        "updatedAt": updated_at,
        "run": {
            "id": team_dir.name,
            # The store's schema version, carried into the projection so the app can
            # reject a pre-MC-1542 run WITHOUT calling Python: the renderer reads
            # projection.json straight off disk (src/main/sprintengine-artifacts.ts
            # readProjection), so a version guard that only lives in the Python
            # loader would let a stale board render gate-era columns silently.
            "schemaVersion": RUN_SCHEMA_VERSION,
            "name": run.get("name") or team_dir.name,
            "goal": run.get("goal") or "",
            "status": run.get("status") or "planning",
            "rosterConfigured": bool(run.get("rosterConfigured")),
            "updatedAt": updated_at,
            "creation": run.get("creation") if isinstance(run.get("creation"), dict) else {},
            "rosterPolicy": normalize_roster_policy(run.get("rosterPolicy")),
            "runner": runner_policy,
            "vcs": vcs,
            # Per-role execution runtime map ({model, cli} per role), written to
            # run.yaml once at init. The renderer resolves every spawn's model
            # and CLI from this map (MC-1450), so the projection must carry it —
            # renderer-side SprintEngineState is rebuilt from this payload on
            # every poll and would otherwise never see the roster's picks.
            "roleRuntimes": run.get("roleRuntimes") if isinstance(run.get("roleRuntimes"), dict) else {},
            # The run's configured (enabled) role set, written once at init from
            # the roster the user turned on. Under the lazy roster only the
            # architect is seated at start, so the renderer cannot infer the
            # enabled roles from who is present — it must carry the config. The
            # roster view groups by these roles so a configured reviewer that has
            # not spawned yet still shows as an (empty) role group. Absent (null)
            # when the run recorded none, which keeps the renderer on its
            # seated-roster fallback.
            "configuredRoles": (
                run.get("configuredRoles") if isinstance(run.get("configuredRoles"), list) else None
            ),
            # Seed docs recorded at run creation (source = root plan doc,
            # sourceBundle = attached reference docs), round-tripped through
            # run.yaml via RUN_SOURCE_KEYS. The renderer's Sprint Inbox surfaces
            # them as "Started from", so the projection must carry them. Omitted
            # cleanly when absent so legacy runs stay unaffected.
            **{key: run[key] for key in RUN_SOURCE_KEYS if key in run},
            # The run's phase list (default AND ceiling for every task). The
            # wizard's "Agents review their own work" toggle writes it; the board
            # and architect prompt read it. Absent = the engine default.
            **{key: run[key] for key in RUN_PHASE_KEYS if key in run},
        },
        "roster": roster,
        "workers": worker_views,
        "tasks": tasks,
        "board": board,
        "artifacts": artifacts,
        "locks": locks,
        "activity": events,
        "dispatches": dispatches,
        "feedback": feedback,
        "counts": {
            "tasks": board["counts"],
            "ready": board["counts"].get("ready", 0),
            "needsInput": board["counts"].get("needs_input", 0),
            "artifacts": _artifact_counts(artifacts),
        },
        "runSummary": _build_projection_run_summary(run, tasks, artifacts, board),
    }
    if state_path is not None:
        projection["statePath"] = str(state_path)
        projection["planPath"] = str(team_dir / "plan.md")
    return projection


def write_projection_file(team_dir: Path, state: dict[str, Any], *, state_path: Path | None = None) -> Path:
    projection = build_projection(team_dir, state_path=state_path)
    atomic_write_json(team_dir / PROJECTION_FILE, projection)
    return team_dir / PROJECTION_FILE


@dataclass(frozen=True)
class LockReport:
    path: str
    exists: bool
    stale: bool
    ageSeconds: float | None
    owner: dict[str, Any] | None


class FolderLock:
    def __init__(self, path: Path, *, stale_after_seconds: float = 300.0, timeout: float = 30.0, poll: float = 0.2):
        self.path = path
        self.stale_after_seconds = stale_after_seconds
        self.timeout = timeout
        self.poll = poll
        self.fd: int | None = None

    def inspect(self) -> LockReport:
        if not self.path.exists():
            return LockReport(str(self.path), False, False, None, None)
        age = max(0.0, time.time() - self.path.stat().st_mtime)
        owner = None
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                owner = parsed
        except (OSError, json.JSONDecodeError):
            owner = None
        return LockReport(str(self.path), True, age > self.stale_after_seconds, age, owner)

    def recover_stale(self) -> bool:
        report = self.inspect()
        if not report.exists or not report.stale:
            return False
        self.path.unlink()
        return True

    def acquire(self, *, recover_stale: bool = False) -> LockReport:
        deadline = time.monotonic() + self.timeout
        payload = json.dumps({"pid": os.getpid(), "createdAt": now_iso()})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, payload.encode("utf-8"))
                return self.inspect()
            except FileExistsError:
                report = self.inspect()
                if report.stale and recover_stale:
                    self.recover_stale()
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for lock: {self.path}")
                time.sleep(self.poll)

    def release(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "FolderLock":
        self.acquire(recover_stale=True)
        return self

    def __exit__(self, *_: Any) -> None:
        self.release()
