#!/usr/bin/env python3
"""Sprint Engine coordination tool for specialist agents.

WARNING: Do not edit .multi-code/sprintengine/state.yaml directly.
All updates must go through this tool.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml  # type: ignore
except ImportError as exc:
    raise SystemExit(
        "PyYAML is required. Install with: python3 -m pip install pyyaml"
    ) from exc


VALID_TASK_STATUSES = {"todo", "in_progress", "needs_input", "done"}
ACTIVE_TASK_STATUSES = {"in_progress", "needs_input"}
VALID_ROLES = {"architect", "product", "developer", "frontend", "tester", "security", "code_reviewer", "performance"}
VALID_TASK_SOURCE_TYPES = {"local", "github", "jira", "linear"}
VALID_TASK_SOURCE_SYNC_STATUSES = {"clean", "local_changed", "remote_changed", "conflict"}
VALID_TASK_DISPATCH_MODES = {"dependency", "manual"}
VALID_TASK_DISPATCH_STATUSES = {"todo", "ready"}
VALID_TASK_DISPATCH_TRIAGED_BY = {"none", "user", "architect"}
VALID_ARTIFACT_KINDS = {
    "architect_plan",
    "product_strategy",
    "requirements",
    "html_mockup",
    "design_notes",
    "branding",
    "security_review",
    "code_review",
    "performance_review",
    "validation_report",
}
VALID_ARTIFACT_STATUSES = {"draft", "ready_for_review", "approved", "changes_requested", "superseded"}
APPROVAL_BLOCKING_ARTIFACT_STATUSES = VALID_ARTIFACT_STATUSES - {"superseded"}
PLAN_REVIEW_ROLES = VALID_ROLES - {"architect"}
FEEDBACK_SCHEMA_VERSION = 3
FEEDBACK_SCORE_FIELDS = [
    ("directive_clarity_pct", "directiveClarityPct", "directive_clarity_pct"),
    ("task_clarity_pct", "taskClarityPct", "task_clarity_pct"),
    ("acceptance_criteria_clarity_pct", "acceptanceCriteriaClarityPct", "acceptance_criteria_clarity_pct"),
    ("sprintengine_tool_effectiveness_pct", "swarmToolEffectivenessPct", "sprintengine_tool_effectiveness_pct"),
    ("prompt_optimization_pct", "promptOptimizationPct", "prompt_optimization_pct"),
    ("context_fit_pct", "contextFitPct", "context_fit_pct"),
    ("hallucination_risk_pct", "hallucinationRiskPct", "hallucination_risk_pct"),
    ("role_fit_pct", "roleFitPct", "role_fit_pct"),
    ("autonomy_pct", "autonomyPct", "autonomy_pct"),
    ("confidence_pct", "confidencePct", "confidence_pct"),
]
FEEDBACK_TEXT_FIELDS = [
    ("top_friction", "topFriction", "top_friction"),
    ("suggested_improvement", "suggestedImprovement", "suggested_improvement"),
]
FEEDBACK_TEXT_LIMIT = 500
FEEDBACK_ISSUE_TEXT_LIMIT = 1000
VALID_FEEDBACK_ISSUE_CATEGORIES = {
    "system_prompt",
    "role_prompt",
    "task_card",
    "acceptance_criteria",
    "context",
    "tooling",
    "coordination",
    "validation",
    "permissions",
    "ui",
    "other",
}
VALID_FEEDBACK_ISSUE_SEVERITIES = {"low", "medium", "high"}
VALID_FEEDBACK_ISSUE_STATUSES = {"new", "reviewed", "applied", "rejected", "deferred"}
VALID_FEEDBACK_FINDING_KINDS = {
    "code_bug",
    "security_issue",
    "product_requirement_violation",
    "test_gap",
    "accessibility_issue",
    "performance_issue",
    "reliability_issue",
    "documentation_gap",
    "other",
}
VALID_FEEDBACK_FINDING_SEVERITIES = {"critical", "high", "medium", "low"}
VALID_FEEDBACK_FINDING_AREAS = {
    "frontend",
    "backend",
    "database",
    "networking",
    "auth",
    "security",
    "filesystem",
    "cli",
    "ipc",
    "mobile",
    "testing",
    "performance",
    "docs",
    "product",
    "other",
}
VALID_FEEDBACK_FINDING_STATUSES = {"open", "accepted", "fixed", "rejected", "deferred"}


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected true or false")


def architect_worktree_preference_block(use_worktrees: bool) -> str:
    return "\n".join([
        "## Execution Workspace",
        "Sprint Engine worktree orchestration is disabled.",
        "- Plan execution in the current workspace.",
        "- Do not create Sprint Engine worktrees or add worktree setup tasks.",
    ])


def worker_plan_worktree_block() -> str:
    return "\n".join([
        "## Execution Workspace Discipline",
        "- Read `plan.md` before claiming work.",
        "- Work in the current workspace directory used to launch this agent.",
        "- Do not create Sprint Engine worktrees.",
        "- Edit only task-owned paths and log evidence before marking your task done.",
        "- Do not merge or push.",
    ])


def build_merge_start_prompt(state: Dict[str, Any], state_path: Path, actor_id: str, target: str) -> str:
    sprintengine = state.get("sprintengine", {})
    goal = sprintengine.get("goal") or "(not set - read the codebase for context)"
    plan_path = plan_path_for_state(state_path)
    target_branch = target.strip()
    return "\n".join([
        "You are the architect responsible for the post-run sprintengine merge.",
        f"Actor id: {actor_id}",
        f"Goal: {goal}",
        f"State file: {state_path}",
        f"Plan file: {plan_path}",
        f"Requested merge target: {target_branch}",
        "",
        "This command only returns instructions. It has not changed task cards and has not run Git.",
        "",
        "Hard rules:",
        "- Confirm the sprintengine run is complete before merging.",
        "- Read `plan.md` and `sprintengine summary` before touching Git state.",
        "- Verify the current branch is the intended source branch and `git status --short` is clean.",
        "- Verify the merge target branch and fetch or update only if the user has allowed network/remote operations.",
        "- Perform the merge to the requested target branch, resolving conflicts where reasonable.",
        "- Run relevant validation after the merge.",
        "- Record the result in run summary evidence or the user handoff; do not create, reopen, or edit task cards for merge work.",
        "- Do not push unless explicitly instructed by the user.",
        "- If the merge cannot be completed safely, document the blocker and stop.",
    ])

PLAN_REVIEW_FOCUS = {
    "product": "scope fit, user value, prioritization, adoption risk, and missing requirements",
    "developer": "implementation sequence, integration risk, data flow, backend/API impact, and owned paths",
    "frontend": "interaction design, UI architecture, accessibility, responsive behavior, and user workflow",
    "tester": "test strategy, acceptance criteria, regression coverage, edge cases, and release confidence",
    "security": "trust boundaries, command safety, secrets, permissions, abuse cases, and hardening",
    "code_reviewer": "code correctness, integration risk, maintainability, regressions, and evidence quality",
    "performance": "latency, CPU, memory, bundle/runtime resource use, measurement quality, and likely bottlenecks",
}


def repository_root_for_tool() -> Path:
    starts = [Path.cwd().resolve(), Path(__file__).resolve()]
    seen = set()
    for start in starts:
        base = start.parent if start.is_file() else start
        candidates = [base, *base.parents]
        for candidate in candidates:
            key = str(candidate)
            if key in seen:
                continue
            seen.add(key)
            if (candidate / ".agents" / "skills" / "sprintengine").exists() or (candidate / ".git").exists():
                return candidate
    return Path(__file__).resolve().parents[1]


REPO_ROOT = repository_root_for_tool()
PROMPTS_DIR = REPO_ROOT / ".agents" / "skills" / "sprintengine" / "prompts"

STATE_NOTICE = (
    "DO NOT EDIT THIS FILE DIRECTLY. "
    "All updates must go through the Sprint Engine tool "
    "(Sprint Engine plan add-task, sprintengine task status, sprintengine task log, etc.). "
    "Direct edits will be overwritten and may corrupt Sprint Engine state."
)

MULTICODE_DIR_NAME = ".multi-code"
SPRINTENGINE_DIR_NAME = "sprintengine"


def sprintengine_root_for(workspace_root: Path) -> Path:
    return workspace_root / MULTICODE_DIR_NAME / SPRINTENGINE_DIR_NAME


def sprintengine_state_path_for(workspace_root: Path, team_slug: str) -> Path:
    return sprintengine_root_for(workspace_root) / team_slug / "state.yaml"


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_state_path(start: Optional[Path] = None) -> Path:
    import sys
    env_path = os.environ.get("SPRINTENGINE_STATE_PATH")
    if env_path:
        print(f"[sprintengine] state path from SPRINTENGINE_STATE_PATH: {env_path}", file=sys.stderr)
        return Path(env_path)
    current = (start or Path.cwd()).resolve()
    print(f"[sprintengine] SPRINTENGINE_STATE_PATH not set, scanning from: {current}", file=sys.stderr)
    for candidate in [current, *current.parents]:
        sprintengine_root = sprintengine_root_for(candidate)
        p = sprintengine_root / "state.yaml"
        if p.exists():
            print(f"[sprintengine] found: {p}", file=sys.stderr)
            return p
        nested = sorted(sprintengine_root.glob("*/state.yaml"))
        if len(nested) == 1:
            print(f"[sprintengine] found nested: {nested[0]}", file=sys.stderr)
            return nested[0]
        if len(nested) > 1:
            names = [f.parent.name for f in nested]
            print(f"[sprintengine] multiple teams found in {sprintengine_root}/: {names}", file=sys.stderr)
            raise SystemExit(
                f"Multiple Sprint Engine teams found: {', '.join(names)}\n"
                f"Specify which one with: --state <path>\n"
                + "\n".join(f"  {f}" for f in nested)
            )
    fallback = sprintengine_root_for(current) / "state.yaml"
    print(f"[sprintengine] nothing found, defaulting to: {fallback}", file=sys.stderr)
    return fallback


def reject_invalid_posix_state_path(path: Path) -> None:
    raw = str(path)
    if os.name == "nt":
        return
    if re.match(r"^[A-Za-z]:[\\/]", raw):
        raise SystemExit(
            "Invalid POSIX state path: "
            f"{raw}\n"
            "This looks like a Windows path. Use the mounted WSL path, for example /mnt/c/..."
        )


def load_soul_prompt(role: str) -> Optional[str]:
    try:
        from souls import render_soul
    except ImportError:
        return None

    try:
        return render_soul(role)
    except (KeyError, FileNotFoundError):
        return None


def project_relative_path_guidance() -> str:
    return "\n".join([
        "# Project-Relative Paths",
        (
            "Never use absolute or machine-specific paths in task cards, evidence, artifacts, "
            "plans, reviews, or handoff text. Full paths break when the repository is opened on "
            "another computer."
        ),
        (
            "All file and directory references must be relative to the project root, using forward "
            "slashes where practical, for example `src/renderer/src/App.tsx`, "
            "`souls/prompts/developer.md`, or `.multi-code/sprintengine/<team>/reviews/code-review-1.md`."
        ),
        (
            "For `Sprint Engine plan --path`, `sprintengine task log --file`, and `sprintengine artifact add --path`, "
            "pass only project-root-relative paths. If a tool prints an absolute path, convert it "
            "to a project-relative path before logging or writing it into an artifact."
        ),
    ])


def local_venv_install_guidance() -> str:
    return "\n".join([
        "# SprintEngine Local Python Environment",
        (
            "When running sprintengine work, you may install task-required Python packages into the "
            "repository-local virtual environment. Use `.venv/bin/python -m pip install <package>` "
            "on POSIX shells, or `.venv\\Scripts\\python.exe -m pip install <package>` on Windows."
        ),
        (
            "Do not install Python packages globally. If `.venv` is missing and the task genuinely "
            "requires Python dependencies, create or repair the repo-local virtual environment using "
            "the project's existing conventions, then log the commands as task evidence."
        ),
    ])


def compose_prompt(
    swarm_heading: str,
    swarm_prompt: str,
    soul_prompt: Optional[str],
    priority_text: str,
) -> str:
    if not soul_prompt:
        return "\n\n".join([
            swarm_heading,
            swarm_prompt,
            "---",
            project_relative_path_guidance(),
            "---",
            local_venv_install_guidance(),
            "---",
            "# Rule Priority",
            priority_text,
        ])

    return "\n\n".join([
        "# Soul Personality And Quality Bar",
        soul_prompt,
        "---",
        swarm_heading,
        swarm_prompt,
        "---",
        project_relative_path_guidance(),
        "---",
        local_venv_install_guidance(),
        "---",
        "# Rule Priority",
        priority_text,
    ])


def load_prompt(role: str) -> str:
    path = PROMPTS_DIR / f"{role}.md"
    if not path.exists():
        raise SystemExit(f"Prompt file not found for role {role!r}: {path}")
    swarm_prompt = path.read_text(encoding="utf-8").strip()
    return compose_prompt(
        "# SprintEngine Coordination Rules",
        swarm_prompt,
        load_soul_prompt(role),
        (
            "Use the Soul prompt above for role personality, judgment, and quality bar. "
            "The Sprint Engine coordination rules below override it for tool mechanics: coordinate through "
            "the Sprint Engine tool, do not edit Sprint Engine state files directly, respect task ownership and owned "
            "paths, log evidence, create artifacts through the artifact commands, and stop when your "
            "Sprint Engine role instructions tell you to stop. Current user and task instructions override both "
            "when they are more specific and do not violate Sprint Engine coordination rules."
        ),
    )


def artifact_registration_instruction(agent_id: str) -> str:
    return (
        "Artifact-producing tasks: if the task asks for an artifact, review, report, "
        "requirements document, design notes, mockup, plan, or validation output, writing "
        "the file and logging evidence is not enough. Register the UI-visible artifact object "
        "before stopping. If the artifact needs human approval, register it ready for review:\n"
        "```\n"
        f"sprintengine artifact add --actor {agent_id} --task-id <task-id> --kind <artifact-kind> "
        f"--title \"<title>\" --path <path-under-team-folder> --created-by {agent_id} --ready\n"
        "sprintengine artifact list --task-id <task-id>\n"
        "```\n"
        "Use the task's requested kind when specified. Otherwise use `security_review` for "
        "security reviews, `code_review` for code reviews, `performance_review` for performance "
        "reviews, `validation_report` for validation reports, `requirements` or `product_strategy` "
        "for product outputs, `design_notes` or "
        "`html_mockup` for frontend outputs, and `architect_plan` for plan gates. The `--ready` "
        "flag moves the linked task to `needs_input`; use it only when the artifact should wait for "
        "human approval. If a review artifact approves/passes the work with no findings, register "
        "the artifact, log evidence, and follow the completion rule below."
    )


def backup_state_file(path: Path) -> Path:
    if not path.exists():
        raise SystemExit(f"State file not found: {path}")
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"state-{timestamp}.yaml")
    attempt = 1
    while backup.exists():
        backup = path.with_name(f"state-{timestamp}-{attempt}.yaml")
        attempt += 1
    backup.write_bytes(path.read_bytes())
    return backup


# ---------------------------------------------------------------------------
# State I/O
# ---------------------------------------------------------------------------

class StateLock:
    def __init__(self, path: Path, timeout: float = 30.0, poll: float = 0.2):
        self.path = path
        self.timeout = timeout
        self.poll = poll
        self.fd: Optional[int] = None

    def acquire(self) -> None:
        deadline = time.monotonic() + self.timeout
        payload = json.dumps({"pid": os.getpid(), "createdAt": now_iso()})
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, payload.encode())
                return
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise SystemExit(f"Timed out waiting for lock: {self.path}")
                time.sleep(self.poll)

    def release(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "StateLock":
        self.acquire()
        return self

    def __exit__(self, *_: Any) -> None:
        self.release()


def load_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"State file not found: {path}")
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        data = {}
    else:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = yaml.safe_load(raw) or {}
    if not isinstance(data, dict):
        raise SystemExit(f"Unexpected state shape in {path}")
    data.pop("_notice", None)
    data.setdefault("events", [])
    data.setdefault("artifacts", [])
    data.setdefault("tasks", [])
    data.setdefault("agents", {})
    data.setdefault("roles", {})
    data.setdefault("sprintengine", {})
    return data


def parse_agent_specs(values: Optional[List[str]]) -> Dict[str, Dict[str, Any]]:
    agents: Dict[str, Dict[str, Any]] = {}
    for raw in values or []:
        spec = raw.strip()
        if not spec:
            continue
        if ":" not in spec:
            raise SystemExit("--agent must use role:id, for example --agent developer:developer-1")
        role, agent_id = [part.strip() for part in spec.split(":", 1)]
        if role not in VALID_ROLES:
            raise SystemExit(f"--agent has invalid role {role!r}.")
        if not agent_id:
            raise SystemExit("--agent id cannot be empty.")
        if agent_id in agents and agents[agent_id].get("role") != role:
            raise SystemExit(f"--agent {agent_id!r} is declared with multiple roles.")
        agents[agent_id] = {"role": role, "status": "idle", "currentTaskId": None}
    return agents


def apply_agent_specs(state: Dict[str, Any], values: Optional[List[str]]) -> None:
    parsed = parse_agent_specs(values)
    if not parsed:
        return
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    agents = state.setdefault("agents", {})
    for agent_id, agent in parsed.items():
        existing = agents.get(agent_id)
        if isinstance(existing, dict):
            if existing.get("role") and existing.get("role") != agent["role"]:
                raise SystemExit(f"Agent {agent_id!r} already exists with role {existing.get('role')!r}.")
            existing["role"] = agent["role"]
            existing.setdefault("status", "idle")
            existing.setdefault("currentTaskId", None)
        else:
            agents[agent_id] = agent


def roster_roles(state: Dict[str, Any]) -> set[str]:
    return {
        str(agent.get("role"))
        for agent in state.get("agents", {}).values()
        if isinstance(agent, dict) and str(agent.get("role")) in VALID_ROLES
    }


def roster_is_configured(state: Dict[str, Any]) -> bool:
    return bool(state.get("sprintengine", {}).get("rosterConfigured"))


def ensure_role_in_roster(state: Dict[str, Any], role: str) -> None:
    roles = roster_roles(state)
    if roster_is_configured(state) and role not in roles:
        raise SystemExit(
            f"Role {role!r} is not in this Sprint Engine roster. "
            "Add a roster member for that role before creating tasks for it."
        )


def ensure_agent_in_roster(state: Dict[str, Any], agent_id: str, role: str) -> None:
    if not roster_is_configured(state):
        return
    existing_agent = state.get("agents", {}).get(agent_id)
    if not isinstance(existing_agent, dict):
        raise SystemExit(f"Agent {agent_id!r} is not in this Sprint Engine roster.")
    if existing_agent.get("role") != role:
        raise SystemExit(f"Agent {agent_id!r} is rostered as {existing_agent.get('role')!r}, not {role!r}.")


def add_roster_agent(state: Dict[str, Any], role: str, agent_id: str, actor: str) -> Dict[str, Any]:
    if role not in VALID_ROLES:
        raise SystemExit(f"Invalid roster role {role!r}.")
    clean_id = agent_id.strip()
    if not clean_id:
        raise SystemExit("--id cannot be empty.")

    agents = state.setdefault("agents", {})
    existing = agents.get(clean_id)
    if isinstance(existing, dict):
        if existing.get("role") != role:
            raise SystemExit(f"Agent {clean_id!r} already exists with role {existing.get('role')!r}.")
        state.setdefault("sprintengine", {})["rosterConfigured"] = True
        return existing

    agent = {"role": role, "status": "idle", "currentTaskId": None}
    agents[clean_id] = agent
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    append_event(state, "roster_member_added", actor, f"{actor} added {clean_id} to the Sprint Engine roster as {role}.")
    return agent


def set_if_changed(record: Dict[str, Any], key: str, value: Any) -> bool:
    if record.get(key) == value:
        return False
    record[key] = value
    return True


def save_state(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    output = {"_notice": STATE_NOTICE, **state}
    with path.open("w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
        f.write("\n")


def with_locked_state(path: Path, handler) -> Dict[str, Any]:
    lock = StateLock(path.with_suffix(f"{path.suffix}.lock"))
    with lock:
        state = load_state(path)
        result = handler(state)
        if result.get("write", True):
            save_state(path, state)
        result.pop("write", None)
        return result


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

def find_task(state: Dict[str, Any], task_id: str) -> Dict[str, Any]:
    for task in state.get("tasks", []):
        if task.get("id") == task_id:
            return task
    raise SystemExit(f"Task not found: {task_id}")


def find_task_by_id(state: Dict[str, Any], task_id: Any) -> Optional[Dict[str, Any]]:
    for task in state.get("tasks", []):
        if isinstance(task, dict) and task.get("id") == task_id:
            return task
    return None


def append_event(state: Dict[str, Any], event_type: str, actor: str, message: str) -> Dict[str, Any]:
    event = {
        "id": f"EVT-{len(state['events']) + 1:03d}",
        "timestamp": now_iso(),
        "type": event_type,
        "actor": actor,
        "message": message,
    }
    state["events"].append(event)
    state.setdefault("sprintengine", {})["updatedAt"] = now_iso()
    return event


def ensure_agent(state: Dict[str, Any], agent_id: str, role: Optional[str] = None) -> Dict[str, Any]:
    agents = state.setdefault("agents", {})
    agent = agents.setdefault(agent_id, {"role": role or "developer", "status": "idle", "currentTaskId": None})
    if role and not agent.get("role"):
        agent["role"] = role
    agent.setdefault("status", "idle")
    agent.setdefault("currentTaskId", None)
    return agent


def set_agent_idle(agent: Dict[str, Any]) -> bool:
    changed = set_if_changed(agent, "status", "idle")
    changed = set_if_changed(agent, "currentTaskId", None) or changed
    return changed


def set_agent_active(agent: Dict[str, Any], task: Dict[str, Any]) -> bool:
    changed = set_if_changed(agent, "status", "needs_input" if task.get("status") == "needs_input" else "running")
    changed = set_if_changed(agent, "currentTaskId", task.get("id")) or changed
    return changed


def clear_task_refs(state: Dict[str, Any], task_id: str) -> List[str]:
    cleared = []
    for agent_id, agent in state.get("agents", {}).items():
        if isinstance(agent, dict) and agent.get("currentTaskId") == task_id:
            set_agent_idle(agent)
            cleared.append(str(agent_id))
    return cleared


def ensure_agent_for_reconcile(state: Dict[str, Any], agent_id: str, role: str) -> tuple[Dict[str, Any], bool]:
    agents = state.setdefault("agents", {})
    agent = agents.get(agent_id)
    if not isinstance(agent, dict):
        agent = {"role": role, "status": "idle", "currentTaskId": None}
        agents[agent_id] = agent
        return agent, True

    changed = False
    if not agent.get("role"):
        changed = set_if_changed(agent, "role", role) or changed
    if "status" not in agent:
        changed = set_if_changed(agent, "status", "idle") or changed
    if "currentTaskId" not in agent:
        changed = set_if_changed(agent, "currentTaskId", None) or changed
    return agent, changed


def reconcile_agent(state: Dict[str, Any], agent_id: str, role: str) -> Dict[str, Any]:
    agent, dirty = ensure_agent_for_reconcile(state, agent_id, role)
    dirty = set_if_changed(agent, "role", role) or dirty
    repairs = []

    current_task_id = agent.get("currentTaskId")
    if current_task_id:
        current_task = find_task_by_id(state, current_task_id)
        if not current_task or current_task.get("status") not in ACTIVE_TASK_STATUSES:
            dirty = set_agent_idle(agent) or dirty
            repairs.append(f"cleared stale task ref {current_task_id}")
        elif current_task.get("ownerAgentId") in (None, "", agent_id):
            dirty = set_if_changed(current_task, "ownerAgentId", agent_id) or dirty
            dirty = set_agent_active(agent, current_task) or dirty
            return {"agent": agent, "activeTask": current_task, "repairs": repairs, "dirty": dirty}
        else:
            dirty = set_agent_idle(agent) or dirty
            repairs.append(f"cleared task {current_task_id} owned by {current_task.get('ownerAgentId')}")

    active_task = next(
        (t for t in state.get("tasks", [])
         if isinstance(t, dict) and t.get("ownerAgentId") == agent_id and t.get("status") in ACTIVE_TASK_STATUSES),
        None,
    )
    if active_task:
        dirty = set_agent_active(agent, active_task) or dirty
        return {"agent": agent, "activeTask": active_task, "repairs": repairs, "dirty": dirty}

    if agent.get("status") == "done":
        dirty = set_if_changed(agent, "currentTaskId", None) or dirty
        return {"agent": agent, "activeTask": None, "repairs": repairs, "dirty": dirty}

    dirty = set_agent_idle(agent) or dirty
    return {"agent": agent, "activeTask": None, "repairs": repairs, "dirty": dirty}


def assign_task(state: Dict[str, Any], task: Dict[str, Any], agent_id: str) -> Dict[str, Any]:
    task["ownerAgentId"] = agent_id
    task["status"] = "in_progress"
    task["startedAt"] = task.get("startedAt") or now_iso()
    agent = ensure_agent(state, agent_id, task.get("role"))
    set_agent_active(agent, task)
    return {"agent": agent}


def recompute_phase(state: Dict[str, Any]) -> bool:
    sprintengine = state.setdefault("sprintengine", {})
    tasks = state.get("tasks", [])
    if tasks and all(t.get("status") == "done" for t in tasks):
        return set_if_changed(sprintengine, "status", "completed")
    if any(t.get("status") in ACTIVE_TASK_STATUSES for t in tasks):
        return set_if_changed(sprintengine, "status", "executing")
    return set_if_changed(sprintengine, "status", "planned" if tasks else "planning")


def ensure_evidence(task: Dict[str, Any]) -> Dict[str, Any]:
    ev = task.setdefault("evidence", {})
    ev.setdefault("summary", "")
    ev.setdefault("touchedFiles", [])
    ev.setdefault("commandsRan", [])
    ev.setdefault("results", [])
    return ev


def task_is_ready(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    if task.get("status") != "todo" or task.get("ownerAgentId"):
        return False
    dispatch = task.get("dispatch")
    if isinstance(dispatch, dict) and dispatch.get("mode") == "manual" and dispatch.get("status") != "ready":
        return False
    for dep_id in task.get("dependsOn", []):
        dep = next((t for t in state.get("tasks", []) if t.get("id") == dep_id), None)
        if dep is None or dep.get("status") != "done":
            return False
    return True


def optional_non_empty_string(record: Dict[str, Any], key: str) -> Optional[str]:
    value = record.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def normalize_task_source(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} source must be an object.")

    source_type = optional_non_empty_string(raw, "type")
    if source_type not in VALID_TASK_SOURCE_TYPES:
        raise SystemExit(
            f"Task {task_id} source.type must be one of: {', '.join(sorted(VALID_TASK_SOURCE_TYPES))}."
        )

    source: Dict[str, Any] = {"type": source_type}
    for key in ("externalId", "externalUrl", "repo", "title", "externalUpdatedAt", "syncedAt"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            source[key] = value

    sync_status = optional_non_empty_string(raw, "syncStatus")
    if sync_status is not None:
        if sync_status not in VALID_TASK_SOURCE_SYNC_STATUSES:
            raise SystemExit(
                f"Task {task_id} source.syncStatus must be one of: {', '.join(sorted(VALID_TASK_SOURCE_SYNC_STATUSES))}."
            )
        source["syncStatus"] = sync_status

    return source


def normalize_task_dispatch(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} dispatch must be an object.")

    mode = optional_non_empty_string(raw, "mode")
    if mode not in VALID_TASK_DISPATCH_MODES:
        raise SystemExit(
            f"Task {task_id} dispatch.mode must be one of: {', '.join(sorted(VALID_TASK_DISPATCH_MODES))}."
        )

    dispatch: Dict[str, Any] = {"mode": mode}
    status = optional_non_empty_string(raw, "status")
    if status is not None:
        if status not in VALID_TASK_DISPATCH_STATUSES:
            raise SystemExit(
                f"Task {task_id} dispatch.status must be one of: {', '.join(sorted(VALID_TASK_DISPATCH_STATUSES))}."
            )
        dispatch["status"] = status

    triaged_by = optional_non_empty_string(raw, "triagedBy")
    if triaged_by is not None:
        if triaged_by not in VALID_TASK_DISPATCH_TRIAGED_BY:
            raise SystemExit(
                f"Task {task_id} dispatch.triagedBy must be one of: {', '.join(sorted(VALID_TASK_DISPATCH_TRIAGED_BY))}."
            )
        dispatch["triagedBy"] = triaged_by

    ready_at = optional_non_empty_string(raw, "readyAt")
    if ready_at is not None:
        dispatch["readyAt"] = ready_at

    return dispatch


def normalize_task(raw: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("Each task must be an object.")
    task_id = str(raw.get("id", "")).strip()
    title = str(raw.get("title", "")).strip()
    role = str(raw.get("role", "")).strip()
    if not task_id:
        raise SystemExit("Each task must have a non-empty id.")
    if not title:
        raise SystemExit(f"Task {task_id} must have a non-empty title.")
    if role not in VALID_ROLES:
        raise SystemExit(f"Task {task_id} has invalid role {role!r}.")
    status = str(raw.get("status", "todo")).strip() or "todo"
    if status not in VALID_TASK_STATUSES:
        raise SystemExit(f"Task {task_id} has invalid status {status!r}.")
    ev = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    task = {
        "id": task_id,
        "title": title,
        "description": str(raw.get("description", "")).strip(),
        "role": role,
        "status": status,
        "ownerAgentId": raw.get("ownerAgentId") or None,
        "dependsOn": [str(i).strip() for i in raw.get("dependsOn", []) if str(i).strip()],
        "ownedPaths": [str(i).strip() for i in raw.get("ownedPaths", []) if str(i).strip()],
        "acceptanceCriteria": [str(i).strip() for i in raw.get("acceptanceCriteria", []) if str(i).strip()],
        "implementationNotes": [str(i).strip() for i in raw.get("implementationNotes", []) if str(i).strip()],
        "evidence": {
            "summary": str(ev.get("summary", "")).strip(),
            "touchedFiles": [str(i).strip() for i in ev.get("touchedFiles", []) if str(i).strip()],
            "commandsRan": [str(i).strip() for i in ev.get("commandsRan", []) if str(i).strip()],
            "results": [str(i).strip() for i in ev.get("results", []) if str(i).strip()],
        },
        "notes": [str(i).strip() for i in raw.get("notes", []) if str(i).strip()],
        "startedAt": raw.get("startedAt") or None,
        "completedAt": raw.get("completedAt") or None,
    }
    source = normalize_task_source(raw.get("source"), task_id)
    if source is not None:
        task["source"] = source
    dispatch = normalize_task_dispatch(raw.get("dispatch"), task_id)
    if dispatch is not None:
        task["dispatch"] = dispatch
    return task


def reject_absolute_path_values(values: Optional[List[str]], field: str) -> None:
    if not values:
        return
    absolute_values = [str(value).strip() for value in values if Path(str(value).strip()).is_absolute()]
    if absolute_values:
        raise SystemExit(
            f"{field} must use project-root-relative paths, not absolute paths: "
            + ", ".join(absolute_values)
        )


def next_task_id(tasks: List[Dict[str, Any]]) -> str:
    used = {str(t.get("id", "")) for t in tasks if isinstance(t, dict)}
    index = 1
    while f"T{index}" in used:
        index += 1
    return f"T{index}"


def build_task_from_args(args: argparse.Namespace, state: Dict[str, Any]) -> Dict[str, Any]:
    task_id = getattr(args, "task_id", None) or next_task_id(state.get("tasks", []))
    reject_absolute_path_values(getattr(args, "path", None), "--path")
    raw = {
        "id": task_id,
        "title": args.title,
        "description": getattr(args, "description", "") or "",
        "role": args.role,
        "status": "todo",
        "ownerAgentId": None,
        "dependsOn": getattr(args, "depends_on", None) or [],
        "ownedPaths": getattr(args, "path", None) or [],
        "acceptanceCriteria": getattr(args, "acceptance", None) or [],
        "implementationNotes": getattr(args, "note", None) or [],
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
        "notes": [],
        "startedAt": None,
        "completedAt": None,
    }
    task = normalize_task(raw)
    existing_ids = {str(t.get("id")) for t in state.get("tasks", []) if isinstance(t, dict)}
    if task["id"] in existing_ids:
        raise SystemExit(f"Task id already exists: {task['id']}")
    missing = [dep for dep in task["dependsOn"] if dep not in existing_ids]
    if missing:
        raise SystemExit(f"Unknown dependency for {task['id']}: {', '.join(missing)}")
    return task


def task_ids(state: Dict[str, Any]) -> set:
    return {str(t.get("id")) for t in state.get("tasks", []) if isinstance(t, dict) and t.get("id")}


def ensure_task_can_be_replanned(task: Dict[str, Any], force: bool = False) -> None:
    if force:
        return
    if task.get("status") != "todo" or task.get("ownerAgentId"):
        raise SystemExit(
            f"Task {task.get('id')} has already started. "
            "Use --force only if you intentionally want to replan active or completed work."
        )


def set_unique_list(task: Dict[str, Any], key: str, values: Optional[List[str]]) -> None:
    if values is None:
        return
    if key in {"ownedPaths", "touchedFiles"}:
        reject_absolute_path_values(values, key)
    task[key] = unique_strings(values)


def add_unique_values(task: Dict[str, Any], key: str, values: List[str]) -> List[str]:
    if key in {"ownedPaths", "touchedFiles"}:
        reject_absolute_path_values(values, key)
    existing = task.setdefault(key, [])
    seen = set(existing)
    added = []
    for value in values:
        item = str(value).strip()
        if not item or item in seen:
            continue
        existing.append(item)
        seen.add(item)
        added.append(item)
    return added


def remove_values(task: Dict[str, Any], key: str, values: List[str]) -> List[str]:
    targets = {str(value).strip() for value in values if str(value).strip()}
    before = [str(value) for value in task.get(key, [])]
    task[key] = [value for value in before if value not in targets]
    return [value for value in before if value in targets]


def task_dependents(state: Dict[str, Any], task_id: str) -> List[str]:
    return [
        str(task.get("id"))
        for task in state.get("tasks", [])
        if isinstance(task, dict) and task_id in task.get("dependsOn", [])
    ]


def unique_strings(values: List[Any]) -> List[str]:
    seen: set = set()
    result = []
    for v in values:
        if not isinstance(v, str):
            continue
        s = v.strip()
        if s and s not in seen:
            seen.add(s)
            result.append(s)
    return result


def path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def feedback_args_present(args: argparse.Namespace) -> bool:
    for attr, _, _ in FEEDBACK_SCORE_FIELDS:
        if getattr(args, attr, None) is not None:
            return True
    for attr, _, _ in FEEDBACK_TEXT_FIELDS:
        if str(getattr(args, attr, "") or "").strip():
            return True
    if getattr(args, "issue_json", None):
        return True
    if getattr(args, "finding_json", None):
        return True
    return False


def validate_feedback_percent(value: int, field_name: str) -> int:
    if not isinstance(value, int) or value < 0 or value > 100:
        raise SystemExit(f"{field_name} must be an integer from 0 to 100.")
    return value


def validate_feedback_text(value: str, field_name: str) -> str:
    text = value.strip()
    if len(text) > FEEDBACK_TEXT_LIMIT:
        raise SystemExit(f"{field_name} must be {FEEDBACK_TEXT_LIMIT} characters or fewer.")
    return text


def validate_feedback_issue_text(value: Any, field_name: str, required: bool = False) -> str:
    if not isinstance(value, str):
        if required:
            raise SystemExit(f"{field_name} must be a string.")
        return ""
    text = value.strip()
    if required and not text:
        raise SystemExit(f"{field_name} cannot be empty.")
    if len(text) > FEEDBACK_ISSUE_TEXT_LIMIT:
        raise SystemExit(f"{field_name} must be {FEEDBACK_ISSUE_TEXT_LIMIT} characters or fewer.")
    return text


def normalize_feedback_issue(raw: Any, task_id: str, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("--issue-json entries must be JSON objects.")

    category = validate_feedback_issue_text(raw.get("category"), "issue.category", required=True)
    if category not in VALID_FEEDBACK_ISSUE_CATEGORIES:
        raise SystemExit(f"issue.category must be one of: {', '.join(sorted(VALID_FEEDBACK_ISSUE_CATEGORIES))}.")

    severity = validate_feedback_issue_text(raw.get("severity"), "issue.severity", required=True)
    if severity not in VALID_FEEDBACK_ISSUE_SEVERITIES:
        raise SystemExit(f"issue.severity must be one of: {', '.join(sorted(VALID_FEEDBACK_ISSUE_SEVERITIES))}.")

    status = validate_feedback_issue_text(raw.get("status", "new"), "issue.status") or "new"
    if status not in VALID_FEEDBACK_ISSUE_STATUSES:
        raise SystemExit(f"issue.status must be one of: {', '.join(sorted(VALID_FEEDBACK_ISSUE_STATUSES))}.")

    issue_id = validate_feedback_issue_text(raw.get("id"), "issue.id") or f"{task_id}-I{index + 1}"
    issue = {
        "id": issue_id,
        "category": category,
        "severity": severity,
        "title": validate_feedback_issue_text(raw.get("title"), "issue.title", required=True),
        "detail": validate_feedback_issue_text(raw.get("detail"), "issue.detail", required=True),
        "status": status,
    }
    for key in ["target", "evidence", "suggestedPromptChange", "suggestedProcessChange"]:
        text = validate_feedback_issue_text(raw.get(key), f"issue.{key}")
        if text:
            issue[key] = text
    return issue


def parse_feedback_issue_args(args: argparse.Namespace, task_id: str) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "issue_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--issue-json must be valid JSON: {exc.msg}") from exc
        issues.append(normalize_feedback_issue(raw, task_id, index))
    return issues


def normalize_feedback_finding(raw: Any, task_id: str, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("--finding-json entries must be JSON objects.")

    kind = validate_feedback_issue_text(raw.get("kind"), "finding.kind", required=True)
    if kind not in VALID_FEEDBACK_FINDING_KINDS:
        raise SystemExit(f"finding.kind must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_KINDS))}.")

    severity = validate_feedback_issue_text(raw.get("severity"), "finding.severity", required=True)
    if severity not in VALID_FEEDBACK_FINDING_SEVERITIES:
        raise SystemExit(f"finding.severity must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_SEVERITIES))}.")

    area = validate_feedback_issue_text(raw.get("area"), "finding.area", required=True)
    if area not in VALID_FEEDBACK_FINDING_AREAS:
        raise SystemExit(f"finding.area must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_AREAS))}.")

    status = validate_feedback_issue_text(raw.get("status", "open"), "finding.status") or "open"
    if status not in VALID_FEEDBACK_FINDING_STATUSES:
        raise SystemExit(f"finding.status must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_STATUSES))}.")

    finding_id = validate_feedback_issue_text(raw.get("id"), "finding.id") or f"{task_id}-F{index + 1}"
    finding = {
        "id": finding_id,
        "kind": kind,
        "severity": severity,
        "area": area,
        "title": validate_feedback_issue_text(raw.get("title"), "finding.title", required=True),
        "detail": validate_feedback_issue_text(raw.get("detail"), "finding.detail", required=True),
        "status": status,
    }
    for key in ["recommendation", "requirementId", "file"]:
        text = validate_feedback_issue_text(raw.get(key), f"finding.{key}")
        if text:
            finding[key] = text
    return finding


def parse_feedback_finding_args(args: argparse.Namespace, task_id: str) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "finding_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--finding-json must be valid JSON: {exc.msg}") from exc
        findings.append(normalize_feedback_finding(raw, task_id, index))
    return findings


def parse_feedback_args(args: argparse.Namespace) -> Dict[str, Any]:
    scores: Dict[str, int] = {}
    json_scores: Dict[str, int] = {}
    for attr, state_key, json_key in FEEDBACK_SCORE_FIELDS:
        raw = getattr(args, attr, None)
        if raw is None:
            continue
        value = validate_feedback_percent(raw, f"--{attr.replace('_', '-')}")
        scores[state_key] = value
        json_scores[json_key] = value

    text_fields: Dict[str, str] = {}
    json_text_fields: Dict[str, str] = {}
    for attr, state_key, json_key in FEEDBACK_TEXT_FIELDS:
        raw = str(getattr(args, attr, "") or "")
        if not raw.strip():
            continue
        text = validate_feedback_text(raw, f"--{attr.replace('_', '-')}")
        text_fields[state_key] = text
        json_text_fields[json_key] = text

    return {"scores": scores, "jsonScores": json_scores, "textFields": text_fields, "jsonTextFields": json_text_fields}


def elapsed_ms(task: Dict[str, Any]) -> Optional[int]:
    started_at = task.get("startedAt")
    completed_at = task.get("completedAt")
    if not isinstance(started_at, str) or not isinstance(completed_at, str):
        return None
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int((end - start).total_seconds() * 1000))


def observed_task_metrics(task: Dict[str, Any]) -> Dict[str, Any]:
    ev = ensure_evidence(task)
    observed: Dict[str, Any] = {
        "task_status": task.get("status"),
        "commands_run_count": len(ev.get("commandsRan", [])),
        "files_touched_count": len(ev.get("touchedFiles", [])),
        "human_intervention_count": 0,
    }
    duration = elapsed_ms(task)
    if duration is not None:
        observed["elapsed_ms"] = duration
    return observed


def build_feedback_payload(
    args: argparse.Namespace,
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
) -> Optional[Dict[str, Any]]:
    if not feedback_args_present(args):
        return None

    parsed = parse_feedback_args(args)
    now = now_iso()
    role = str(task.get("role") or "")
    task_id = str(task.get("id") or "")
    team_slug = str(state.get("sprintengine", {}).get("name") or state_path.parent.name)
    issues = parse_feedback_issue_args(args, task_id)
    findings = parse_feedback_finding_args(args, task_id)
    state_feedback = {
        "schemaVersion": FEEDBACK_SCHEMA_VERSION,
        "capturedAt": now,
        "source": "agent_self_report",
        "agentId": actor,
        "role": role,
        "scores": parsed["scores"],
    }
    state_feedback.update(parsed["textFields"])

    record = {
        "schema_version": FEEDBACK_SCHEMA_VERSION,
        "run_id": team_slug,
        "team_slug": team_slug,
        "task_id": task_id,
        "agent_id": actor,
        "role": role,
        "task_title": task.get("title") or "",
        "captured_at": now,
        "source": "agent_self_report",
        "scores": parsed["jsonScores"],
        "observed": observed_task_metrics(task),
        **parsed["jsonTextFields"],
    }
    if issues:
        state_feedback["issues"] = issues
        record["issues"] = [
            {
                "id": issue["id"],
                "category": issue["category"],
                "severity": issue["severity"],
                "target": issue.get("target"),
                "title": issue["title"],
                "detail": issue["detail"],
                "evidence": issue.get("evidence"),
                "suggested_prompt_change": issue.get("suggestedPromptChange"),
                "suggested_process_change": issue.get("suggestedProcessChange"),
                "status": issue["status"],
            }
            for issue in issues
        ]
    if findings:
        state_feedback["findings"] = findings
        record["findings"] = [
            {
                "id": finding["id"],
                "kind": finding["kind"],
                "severity": finding["severity"],
                "area": finding["area"],
                "title": finding["title"],
                "detail": finding["detail"],
                "recommendation": finding.get("recommendation"),
                "requirement_id": finding.get("requirementId"),
                "file": finding.get("file"),
                "status": finding["status"],
            }
            for finding in findings
        ]
    return {"stateFeedback": state_feedback, "record": record}


def metrics_feedback_path(state_path: Path) -> Path:
    team_dir = state_path.parent.resolve()
    metrics_dir = (team_dir / "metrics").resolve()
    if not path_is_relative_to(metrics_dir, team_dir):
        raise SystemExit(f"Metrics directory must stay under active Sprint Engine team folder: {team_dir}")
    return metrics_dir / "agent-feedback.jsonl"


def append_feedback_record(state_path: Path, record: Dict[str, Any]) -> str:
    output_path = metrics_feedback_path(state_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")
    return str(output_path)


def repository_root_for_state(state_path: Path) -> Path:
    starts = [Path.cwd().resolve(), state_path.parent.resolve()]
    seen = set()
    for start in starts:
        for candidate in [start, *start.parents]:
            key = str(candidate)
            if key in seen:
                continue
            seen.add(key)
            if (candidate / ".git").exists():
                return candidate
    if state_path.parent.parent.name == SPRINTENGINE_DIR_NAME and state_path.parent.parent.parent.name == MULTICODE_DIR_NAME:
        return state_path.parent.parent.parent.parent.resolve()
    if state_path.parent.parent.name == SPRINTENGINE_DIR_NAME:
        return state_path.parent.parent.parent.resolve()
    return state_path.parent.resolve()


def artifact_absolute_path(state_path: Path, value: str) -> Path:
    raw = Path(value)
    if raw.is_absolute():
        return raw.resolve()

    team_dir = state_path.parent.resolve()
    repo_root = repository_root_for_state(state_path)
    candidates = [(repo_root / raw).resolve(), (team_dir / raw).resolve()]
    for candidate in candidates:
        if path_is_relative_to(candidate, team_dir):
            return candidate
    return candidates[0]


def project_relative_display_path(state_path: Path, path: Path) -> str:
    absolute = path.resolve()
    repo_root = repository_root_for_state(state_path)
    if path_is_relative_to(absolute, repo_root):
        return absolute.relative_to(repo_root).as_posix()
    return path.as_posix()


def normalize_artifact_path(state_path: Path, value: str, require_file: bool = False) -> Dict[str, Any]:
    raw = str(value).strip()
    if not raw:
        raise SystemExit("Artifact path cannot be empty.")
    if Path(raw).is_absolute():
        raise SystemExit(
            "Artifact path must be project-root-relative, not absolute: "
            f"{raw}"
        )

    team_dir = state_path.parent.resolve()
    repo_root = repository_root_for_state(state_path)
    absolute = artifact_absolute_path(state_path, raw)
    if not path_is_relative_to(absolute, team_dir):
        raise SystemExit(
            "Artifact path must stay under the active Sprint Engine team folder: "
            f"{team_dir}"
        )
    if absolute.exists() and not absolute.is_file():
        raise SystemExit(f"Artifact path must be a file, not a directory: {absolute}")
    if require_file and not absolute.is_file():
        raise SystemExit(f"Artifact file not found: {absolute}")

    if path_is_relative_to(absolute, repo_root):
        stored = absolute.relative_to(repo_root).as_posix()
    else:
        stored = absolute.relative_to(team_dir).as_posix()
    return {"path": stored, "absolutePath": absolute}


def file_fingerprint(path: Path) -> Optional[str]:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def next_artifact_id(artifacts: List[Dict[str, Any]]) -> str:
    used = {str(a.get("id", "")) for a in artifacts if isinstance(a, dict)}
    index = 1
    while f"A{index}" in used:
        index += 1
    return f"A{index}"


def find_artifact(state: Dict[str, Any], artifact_id: str) -> Dict[str, Any]:
    for artifact in state.get("artifacts", []):
        if isinstance(artifact, dict) and artifact.get("id") == artifact_id:
            return artifact
    raise SystemExit(f"Artifact not found: {artifact_id}")


def artifacts_for_task(state: Dict[str, Any], task_id: str) -> List[Dict[str, Any]]:
    return [
        artifact
        for artifact in state.get("artifacts", [])
        if isinstance(artifact, dict) and artifact.get("taskId") == task_id
    ]


def blocking_artifacts_for_task(state: Dict[str, Any], task_id: str) -> List[Dict[str, Any]]:
    return [
        artifact
        for artifact in artifacts_for_task(state, task_id)
        if artifact.get("status", "draft") in APPROVAL_BLOCKING_ARTIFACT_STATUSES
    ]


def ensure_artifact_history(artifact: Dict[str, Any]) -> List[Dict[str, Any]]:
    history = artifact.setdefault("reviewHistory", [])
    if not isinstance(history, list):
        artifact["reviewHistory"] = []
    return artifact["reviewHistory"]


def append_artifact_history(
    artifact: Dict[str, Any],
    action: str,
    actor: str,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    entry = {"action": action, "actor": actor, "timestamp": now_iso()}
    if note:
        entry["note"] = note
    ensure_artifact_history(artifact).append(entry)
    return entry


def build_artifact_from_args(args: argparse.Namespace, state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    task = find_task(state, args.task_id)
    artifact_id = args.artifact_id or next_artifact_id(state.setdefault("artifacts", []))
    if any(isinstance(a, dict) and a.get("id") == artifact_id for a in state.get("artifacts", [])):
        raise SystemExit(f"Artifact id already exists: {artifact_id}")

    path_info = normalize_artifact_path(state_path, args.path)
    absolute_path = path_info["absolutePath"]
    created_by = args.created_by or task.get("ownerAgentId") or args.actor
    now = now_iso()
    return {
        "id": artifact_id,
        "kind": args.kind,
        "title": args.title.strip(),
        "path": path_info["path"],
        "status": "draft",
        "createdBy": created_by,
        "taskId": args.task_id,
        "fingerprint": file_fingerprint(absolute_path),
        "reviewHistory": [{"action": "created", "actor": args.actor, "timestamp": now}],
        "recommendedTasks": unique_strings(args.recommended_task or []),
        "createdAt": now,
        "updatedAt": now,
    }


def mark_task_needs_input_for_artifact(state: Dict[str, Any], task: Dict[str, Any]) -> None:
    task["status"] = "needs_input"
    task["completedAt"] = None
    owner_id = task.get("ownerAgentId")
    if owner_id:
        agent = ensure_agent(state, owner_id, task.get("role"))
        agent["status"] = "needs_input"
        agent["currentTaskId"] = task.get("id")


def mark_task_done_if_artifacts_approved(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    linked_artifacts = blocking_artifacts_for_task(state, str(task.get("id")))
    if not linked_artifacts or any(a.get("status") != "approved" for a in linked_artifacts):
        return False

    task["status"] = "done"
    task["completedAt"] = now_iso()
    cleared = clear_task_refs(state, str(task.get("id")))
    owner_id = task.get("ownerAgentId")
    if owner_id:
        set_agent_idle(ensure_agent(state, owner_id, task.get("role")))
    for agent_id in cleared:
        if agent_id != owner_id:
            set_agent_idle(ensure_agent(state, agent_id))
    return True


def reopen_task_for_artifact_changes(state: Dict[str, Any], task: Dict[str, Any]) -> str:
    task["completedAt"] = None
    owner_id = task.get("ownerAgentId")
    owner = state.get("agents", {}).get(owner_id) if owner_id else None
    owner_still_active = (
        bool(owner_id)
        and isinstance(owner, dict)
        and owner.get("currentTaskId") == task.get("id")
        and owner.get("status") in {"running", "needs_input"}
    )

    if owner_still_active:
        task["status"] = "in_progress"
        agent = ensure_agent(state, str(owner_id), task.get("role"))
        agent["status"] = "running"
        agent["currentTaskId"] = task.get("id")
        return "in_progress"

    clear_task_refs(state, str(task.get("id")))
    task["ownerAgentId"] = None
    task["status"] = "todo"
    return "todo"


def plan_path_artifact_value(state_path: Path) -> str:
    return normalize_artifact_path(state_path, "plan.md")["path"]


def product_intake_path_artifact_value(state_path: Path) -> str:
    return normalize_artifact_path(state_path, "product-requirements.md")["path"]


def product_intake_handover_note(state_path: Path) -> Optional[str]:
    handover_path = handover_path_for_state(state_path)
    if not handover_path.exists():
        return None
    handover_path_value = project_relative_display_path(state_path, handover_path)
    return f"Read `{handover_path_value}` as incoming context before writing product-requirements.md."


def find_architect_plan_gate(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    plan_path_value = plan_path_artifact_value(state_path)
    plan_task = None
    plan_artifact = None

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        if (
            artifact.get("kind") == "architect_plan"
            and artifact.get("path") == plan_path_value
            and artifact.get("status") != "superseded"
        ):
            plan_artifact = artifact
            plan_task = find_task_by_id(state, artifact.get("taskId"))
            break

    if plan_task is None:
        candidate = find_task_by_id(state, "T0")
        if candidate and candidate.get("role") == "architect":
            plan_task = candidate

    return {"task": plan_task, "artifact": plan_artifact}


def ensure_product_intake_gate(state: Dict[str, Any], state_path: Path, actor: str = "product") -> Dict[str, Any]:
    requirements_path_value = product_intake_path_artifact_value(state_path)
    handover_note = product_intake_handover_note(state_path)
    product_task = None
    product_artifact = None

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        if (
            artifact.get("kind") in {"product_strategy", "requirements"}
            and artifact.get("path") == requirements_path_value
            and artifact.get("status") != "superseded"
        ):
            product_artifact = artifact
            product_task = find_task_by_id(state, artifact.get("taskId"))
            break

    if product_task is None:
        candidate = find_task_by_id(state, "T0")
        if candidate and candidate.get("role") == "product":
            product_task = candidate

    if product_task is None:
        task_id = "T0" if "T0" not in task_ids(state) else next_task_id(state.get("tasks", []))
        implementation_notes = [
            "Write the artifact at product-requirements.md in the active Sprint Engine team folder.",
            "Use the existing requirements artifact created by sprintengine init; mark it ready after the file exists.",
        ]
        if handover_note:
            implementation_notes.insert(0, handover_note)
        product_task = normalize_task({
            "id": task_id,
            "title": "Define product requirements",
            "description": (
                "Product strategist intake gate for this sprintengine run. Produce a requirements or "
                "product handoff artifact before architect planning begins."
            ),
            "role": "product",
            "status": "todo",
            "ownerAgentId": None,
            "dependsOn": [],
            "ownedPaths": [requirements_path_value],
            "acceptanceCriteria": [
                "Product artifact captures the goal, requirements, constraints, and acceptance expectations.",
                "If no meaningful product strategy is needed, artifact states that clearly and records non-goals and handoff constraints.",
                "Artifact is reviewed by the user and either approved to done or sent back for changes.",
            ],
            "implementationNotes": implementation_notes,
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
            "notes": [],
            "startedAt": None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(product_task)
        append_event(state, "task_added", actor, f"{actor} added {product_task['id']}: {product_task['title']}.")
    elif product_task.get("status") == "in_progress":
        product_task["ownerAgentId"] = product_task.get("ownerAgentId") or actor
        product_task["startedAt"] = product_task.get("startedAt") or now_iso()
        product_task["completedAt"] = None

    if handover_note and product_task.get("status") != "done":
        add_unique_values(product_task, "implementationNotes", [handover_note])

    if product_task.get("status") in ACTIVE_TASK_STATUSES:
        set_agent_active(ensure_agent(state, actor, "product"), product_task)

    if product_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, requirements_path_value)
        initial_status = "approved" if product_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": "Imported from completed product intake task."})
        product_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            "kind": "requirements",
            "title": "Product Requirements",
            "path": requirements_path_value,
            "status": initial_status,
            "createdBy": actor,
            "taskId": product_task.get("id"),
            "fingerprint": file_fingerprint(absolute_path),
            "reviewHistory": history,
            "recommendedTasks": [],
            "createdAt": now,
            "updatedAt": now,
        }
        if initial_status == "approved":
            product_artifact["approvedBy"] = actor
            product_artifact["approvedAt"] = now
        state.setdefault("artifacts", []).append(product_artifact)
        append_event(state, "artifact_added", actor, f"{actor} registered product requirements artifact {product_artifact['id']}.")
    else:
        product_artifact["taskId"] = product_task.get("id")
        product_artifact["path"] = requirements_path_value
        product_artifact.setdefault("title", "Product Requirements")
        product_artifact.setdefault("createdBy", actor)
        product_artifact.setdefault("reviewHistory", [])
        product_artifact.setdefault("recommendedTasks", [])
        product_artifact.setdefault("createdAt", now_iso())
        product_artifact["updatedAt"] = now_iso()

    return {"task": product_task, "artifact": product_artifact}


def ensure_plan_approval_gate(
    state: Dict[str, Any],
    state_path: Path,
    actor: str = "architect",
    depends_on: Optional[str] = None,
    start_active: bool = True,
) -> Dict[str, Any]:
    plan_path_value = plan_path_artifact_value(state_path)
    existing_gate = find_architect_plan_gate(state, state_path)
    plan_task = existing_gate["task"]
    plan_artifact = existing_gate["artifact"]

    if plan_task is None:
        preferred_id = "T1" if depends_on else "T0"
        task_id = preferred_id if preferred_id not in task_ids(state) else next_task_id(state.get("tasks", []))
        plan_task = normalize_task({
            "id": task_id,
            "title": "Review architect plan artifact",
            "description": "Architect-authored plan.md and task graph approval gate.",
            "role": "architect",
            "status": "in_progress" if start_active else "todo",
            "ownerAgentId": actor if start_active else None,
            "dependsOn": [depends_on] if depends_on else [],
            "ownedPaths": [plan_path_value],
            "acceptanceCriteria": [
                "Architect plan describes the execution approach and task graph.",
                "Plan is reviewed by the user and either approved to done or sent back for changes.",
            ],
            "implementationNotes": [],
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
            "notes": [],
            "startedAt": now_iso() if start_active else None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(plan_task)
        append_event(state, "task_added", actor, f"{actor} added {plan_task['id']}: {plan_task['title']}.")
    elif plan_task.get("status") != "done":
        if depends_on and depends_on not in plan_task.get("dependsOn", []):
            add_unique_values(plan_task, "dependsOn", [depends_on])
        if start_active and task_is_ready(state, plan_task):
            plan_task["status"] = "in_progress"
            plan_task["ownerAgentId"] = plan_task.get("ownerAgentId") or actor
            plan_task["startedAt"] = plan_task.get("startedAt") or now_iso()
        plan_task["completedAt"] = None

    if plan_task.get("status") in ACTIVE_TASK_STATUSES:
        set_agent_active(ensure_agent(state, actor, "architect"), plan_task)

    if plan_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, plan_path_value)
        initial_status = "approved" if plan_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": "Imported from completed architect plan task."})
        plan_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            "kind": "architect_plan",
            "title": "Architect Plan",
            "path": plan_path_value,
            "status": initial_status,
            "createdBy": actor,
            "taskId": plan_task.get("id"),
            "fingerprint": file_fingerprint(absolute_path),
            "reviewHistory": history,
            "recommendedTasks": [],
            "createdAt": now,
            "updatedAt": now,
        }
        if initial_status == "approved":
            plan_artifact["approvedBy"] = actor
            plan_artifact["approvedAt"] = now
        state.setdefault("artifacts", []).append(plan_artifact)
        append_event(state, "artifact_added", actor, f"{actor} registered architect plan artifact {plan_artifact['id']}.")
    else:
        plan_artifact["taskId"] = plan_task.get("id")
        plan_artifact["path"] = plan_path_value
        plan_artifact.setdefault("title", "Architect Plan")
        plan_artifact.setdefault("createdBy", actor)
        plan_artifact.setdefault("reviewHistory", [])
        plan_artifact.setdefault("recommendedTasks", [])
        plan_artifact.setdefault("createdAt", now_iso())
        plan_artifact["updatedAt"] = now_iso()

    return {"task": plan_task, "artifact": plan_artifact}


def plan_path_for_state(state_path: Path) -> Path:
    return state_path.parent / "plan.md"


def plan_reviews_dir_for_state(state_path: Path) -> Path:
    return state_path.parent / "plan-reviews"


def default_swarm_name_for_state(state_path: Path) -> str:
    team_dir_name = state_path.parent.name
    return "Sprint Engine Team" if team_dir_name == "sprintengine" else team_dir_name


def slugify_team_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "sprintengine-team"


def handover_path_for_state(state_path: Path) -> Path:
    return state_path.parent / "handover.md"


def safe_review_filename(agent_id: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", agent_id.strip()).strip(".-")
    return f"{name or 'agent'}.md"


def plan_fingerprint(plan_path: Path) -> str:
    if not plan_path.exists():
        raise SystemExit(f"Plan file not found: {plan_path}")
    return hashlib.sha256(plan_path.read_bytes()).hexdigest()


def expected_plan_reviewers(state: Dict[str, Any]) -> List[Dict[str, str]]:
    reviewers = []
    for agent_id, agent in state.get("agents", {}).items():
        if not isinstance(agent, dict):
            continue
        role = str(agent.get("role", "")).strip()
        if role not in PLAN_REVIEW_ROLES:
            continue
        reviewers.append({"id": str(agent_id), "role": role})
    return sorted(reviewers, key=lambda item: (item["role"], item["id"]))


def parse_review_metadata(path: Path) -> Dict[str, Any]:
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="replace")
    fingerprint_match = re.search(r"(?im)^Plan fingerprint:\s*([A-Fa-f0-9]{64})\s*$", content)
    verdict_match = re.search(r"(?im)^Verdict:\s*([^\n]+)\s*$", content)
    role_match = re.search(r"(?im)^Role:\s*([A-Za-z0-9_-]+)\s*$", content)
    agent_match = re.search(r"(?im)^Agent:\s*([A-Za-z0-9._-]+)\s*$", content)
    return {
        "path": str(path),
        "filename": path.name,
        "agentId": agent_match.group(1).strip() if agent_match else path.stem,
        "role": role_match.group(1).strip() if role_match else None,
        "planFingerprint": fingerprint_match.group(1).lower() if fingerprint_match else None,
        "verdict": verdict_match.group(1).strip() if verdict_match else "unknown",
        "content": content,
    }


def build_plan_review_status(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    plan_path = plan_path_for_state(state_path)
    reviews_dir = plan_reviews_dir_for_state(state_path)
    current_fingerprint = plan_fingerprint(plan_path)
    expected = expected_plan_reviewers(state)
    expected_by_id = {reviewer["id"]: reviewer for reviewer in expected}
    files = sorted(reviews_dir.glob("*.md")) if reviews_dir.exists() else []
    reviews = []

    for path in files:
        metadata = parse_review_metadata(path)
        metadata["path"] = project_relative_display_path(state_path, path)
        metadata["stale"] = metadata.get("planFingerprint") != current_fingerprint
        metadata["expected"] = metadata.get("agentId") in expected_by_id
        metadata.pop("content", None)
        reviews.append(metadata)

    review_ids = {review.get("agentId") for review in reviews}
    missing = [reviewer for reviewer in expected if reviewer["id"] not in review_ids]
    stale = [review for review in reviews if review.get("stale")]
    unexpected = [review for review in reviews if not review.get("expected")]
    completed = [
        review for review in reviews
        if not review.get("stale") and str(review.get("verdict", "")).lower() in {"approve", "needs_changes", "blocked"}
    ]

    return {
        "planPath": project_relative_display_path(state_path, plan_path),
        "reviewsDirectory": project_relative_display_path(state_path, reviews_dir),
        "planFingerprint": current_fingerprint,
        "expectedReviewers": expected,
        "reviews": reviews,
        "missingReviewers": missing,
        "staleReviews": stale,
        "unexpectedReviews": unexpected,
        "counts": {
            "expected": len(expected),
            "completed": len(completed),
            "missing": len(missing),
            "stale": len(stale),
            "unexpected": len(unexpected),
        },
    }


def build_plan_review_template(agent_id: str, role: str, plan_path: Path, fingerprint: str) -> str:
    role_label = role.replace("-", " ").title()
    return "\n".join([
        f"# Plan Review: {role_label}",
        "",
        f"Agent: {agent_id}",
        f"Role: {role}",
        f"Plan: {plan_path.name}",
        f"Plan fingerprint: {fingerprint}",
        "Verdict: pending",
        "",
        "## Summary",
        "",
        "## Blocking Issues",
        "",
        "## Recommended Changes",
        "",
        "## Task Graph Feedback",
        "",
        "## Missing Acceptance Criteria",
        "",
        "## Risks",
        "",
        "## Questions For Architect",
        "",
    ])


def build_plan_review_prompt(
    agent_id: str,
    role: str,
    state_path: Path,
    plan_path: Path,
    review_path: Path,
    fingerprint: str,
    existing_review: bool,
) -> str:
    action = "Replace your existing review" if existing_review else "Write your review"
    plan_display_path = project_relative_display_path(state_path, plan_path)
    review_display_path = project_relative_display_path(state_path, review_path)
    review_prompt = "\n".join([
        f"You are the {role} specialist reviewing the architect's Sprint Engine plan.",
        "",
        "Do not claim tasks, do not implement, and do not edit state.yaml.",
        "",
        f"Plan file: {plan_display_path}",
        f"Your review file: {review_display_path}",
        f"Current plan fingerprint: {fingerprint}",
        f"Review focus: {PLAN_REVIEW_FOCUS.get(role, 'specialist risks, gaps, and execution quality')}.",
        "",
        "Steps:",
        "1. Read the full architect plan.",
        "2. Inspect the repository only as needed to validate the plan from your specialty.",
        "3. Evaluate whether the task graph, owned paths, dependencies, and acceptance criteria are sufficient.",
        f"4. {action} at the exact project-relative review file path above.",
        "5. Set `Verdict:` to one of: approve, needs_changes, blocked.",
        "6. Keep feedback concrete and actionable for the architect.",
        "",
        "Required markdown sections:",
        "- Summary",
        "- Blocking Issues",
        "- Recommended Changes",
        "- Task Graph Feedback",
        "- Missing Acceptance Criteria",
        "- Risks",
        "- Questions For Architect",
        "",
        "Do not update the task board. The architect will address feedback with `Sprint Engine plan address-reviews`.",
    ])
    return compose_prompt(
        "# Sprint Engine Plan Review Rules",
        review_prompt,
        load_soul_prompt(role),
        (
            "Use the Soul prompt above for review perspective and quality bar. The plan review "
            "rules below override it for sprintengine mechanics: do not claim tasks, do not implement, do not "
            "edit state files, write only the assigned review file, and keep feedback concrete for the architect."
        ),
    )


def build_address_reviews_prompt(
    state: Dict[str, Any],
    state_path: Path,
    status: Dict[str, Any],
    review_contents: List[Dict[str, str]],
) -> str:
    plan_path = plan_path_for_state(state_path)
    plan_display_path = project_relative_display_path(state_path, plan_path)
    plan_content = plan_path.read_text(encoding="utf-8")
    review_blocks = []

    for review in review_contents:
        review_blocks.extend([
            f"## Review File: {review['path']}",
            "",
            review["content"].rstrip(),
            "",
        ])

    warnings = []
    if status["missingReviewers"]:
        missing = ", ".join(f"{r['id']} ({r['role']})" for r in status["missingReviewers"])
        warnings.append(f"- Missing expected reviews: {missing}")
    if status["staleReviews"]:
        stale = ", ".join(str(r["path"]) for r in status["staleReviews"])
        warnings.append(f"- Stale reviews whose fingerprint does not match the current plan: {stale}")
    if status["unexpectedReviews"]:
        unexpected = ", ".join(str(r["path"]) for r in status["unexpectedReviews"])
        warnings.append(f"- Unexpected review files: {unexpected}")
    warning_block = "\n".join(warnings) if warnings else "- No missing, stale, or unexpected review files detected."

    return "\n".join([
        "You are the sprintengine architect addressing specialist plan reviews.",
        "",
        "Do not implement. Do not hand-edit state.yaml. Your job is to revise the plan and task graph.",
        "",
        f"Plan file: {plan_display_path}",
        f"Plan fingerprint: {status['planFingerprint']}",
        "",
        "Review status:",
        warning_block,
        "",
        "Steps:",
        "1. Read the current plan and all specialist review feedback below.",
        "2. Decide which feedback to accept, adapt, or reject.",
        "3. Update plan.md directly when the human-readable plan needs changes.",
        "4. Update the task graph only with Sprint Engine plan commands:",
        "   - Sprint Engine plan update-task",
        "   - Sprint Engine plan add-task",
        "   - Sprint Engine plan delete-task",
        "   - Sprint Engine plan add-dependency",
        "   - Sprint Engine plan remove-dependency",
        "5. Do not start implementation work.",
        "6. When done, tell the user which review items were accepted, adapted, or rejected.",
        "",
        "# Current Plan",
        "",
        plan_content.rstrip(),
        "",
        "# Specialist Reviews",
        "",
        "\n".join(review_blocks).rstrip() or "(No plan review files found.)",
    ])


def build_run_summary(state: Dict[str, Any]) -> Dict[str, Any]:
    tasks = state.get("tasks", [])
    completed = [t for t in tasks if t.get("status") == "done"]
    touched_files: List[Any] = []
    commands_ran: List[Any] = []
    results: List[str] = []
    task_summaries = []
    open_questions: List[str] = []

    for t in completed:
        ev = ensure_evidence(t)
        task_summaries.append({
            "id": t.get("id"),
            "title": t.get("title"),
            "summary": ev.get("summary") or "No summary recorded.",
            "ownerAgentId": t.get("ownerAgentId"),
            "completedAt": t.get("completedAt"),
        })
        touched_files.extend(ev.get("touchedFiles", []))
        commands_ran.extend(ev.get("commandsRan", []))
        results.extend(f"{t.get('id')}: {r}" for r in ev.get("results", []) if isinstance(r, str))

    for t in tasks:
        for q in t.get("notes", []):
            if isinstance(q, str) and q.strip():
                open_questions.append(f"{t.get('id')}: {q.strip()}")

    sprintengine = state.get("sprintengine", {})
    return {
        "goal": sprintengine.get("goal", ""),
        "status": sprintengine.get("status", "planning"),
        "tasks": {"total": len(tasks), "completed": len(completed), "remaining": max(0, len(tasks) - len(completed))},
        "touchedFiles": unique_strings(touched_files),
        "commandsRan": unique_strings(commands_ran),
        "results": results,
        "completedTasks": task_summaries,
        "openQuestions": open_questions,
    }


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

def cmd_handover(args: argparse.Namespace) -> Dict[str, Any]:
    team_slug = slugify_team_name(args.name)
    state_path = (args.state or sprintengine_state_path_for(Path.cwd(), team_slug)).resolve()
    team_dir = state_path.parent
    handover_path = handover_path_for_state(state_path)

    existing = [path for path in [state_path, handover_path] if path.exists()]
    if existing and not args.force:
        return {
            "ok": False,
            "error": "Team already has bootstrap files. Use --force only if you intend to replace the state/handover bootstrap.",
            "existing": [str(path) for path in existing],
            "write": False,
        }

    handover_text = ""
    source_metadata: Optional[Dict[str, Any]] = None
    captured_at = now_iso()
    if args.handover:
        source_path = args.handover.resolve()
        handover_text = source_path.read_text(encoding="utf-8")
        source_metadata = {
            "kind": "markdown",
            "origin": "file",
            "path": project_relative_display_path(state_path, handover_path),
            "originalPath": project_relative_display_path(state_path, source_path),
            "capturedAt": captured_at,
        }
    elif getattr(args, "handover_stdin", False):
        handover_text = sys.stdin.read()
        source_metadata = {
            "kind": "markdown",
            "origin": "stdin",
            "path": project_relative_display_path(state_path, handover_path),
            "capturedAt": captured_at,
        }
    elif args.handover_text:
        handover_text = args.handover_text
        source_metadata = {
            "kind": "markdown",
            "origin": "inline",
            "path": project_relative_display_path(state_path, handover_path),
            "capturedAt": captured_at,
        }

    team_dir.mkdir(parents=True, exist_ok=True)
    initial: Dict[str, Any] = {
        "sprintengine": {
            "name": team_slug,
            "goal": args.goal or "",
            "status": "planning",
            "rosterConfigured": bool(getattr(args, "agent", None)),
        },
        "tasks": [],
        "agents": parse_agent_specs(getattr(args, "agent", None)),
        "events": [
            {
                "id": "EVT-001",
                "timestamp": now_iso(),
                "type": "handover_created",
                "actor": args.actor,
                "message": f"{args.actor} created sprintengine handover for team {team_slug}.",
            }
        ],
        "artifacts": [],
        "roles": {},
    }
    if source_metadata and handover_text.strip():
        initial["source"] = source_metadata
    save_state(state_path, initial)

    wrote_handover = False
    if handover_text.strip():
        handover_path.write_text(handover_text.rstrip() + "\n", encoding="utf-8")
        wrote_handover = True

    init_command = f"sprintengine --state {json.dumps(str(state_path))} init"
    architect_startup_prompt = "\n\n".join([
        f"Use the existing Sprint Engine team `{team_slug}`.",
        "Fetch the canonical Sprint Engine startup instructions from the Python tool.",
        "Run:",
        f"```bash\n{init_command}\n```",
        "Then follow the returned prompt. If `handover.md` exists, treat it as incoming context, not as the final plan.",
    ])

    return {
        "ok": True,
        "action": "handover",
        "team": team_slug,
        "statePath": str(state_path),
        "handoverPath": str(handover_path) if wrote_handover else None,
        "planPath": str(plan_path_for_state(state_path)),
        "architectStartupPrompt": architect_startup_prompt,
    }


def cmd_init(args: argparse.Namespace) -> Dict[str, Any]:
    state_path = args.state
    default_name = default_swarm_name_for_state(state_path)
    if not state_path.exists():
        state_path.parent.mkdir(parents=True, exist_ok=True)
        initial: Dict[str, Any] = {
            "sprintengine": {
                "name": default_name,
                "goal": getattr(args, "goal", "") or "",
                "status": "planning",
                "rosterConfigured": bool(getattr(args, "agent", None)),
            },
            "tasks": [],
            "agents": parse_agent_specs(getattr(args, "agent", None)),
            "events": [],
            "artifacts": [],
            "roles": {},
        }
        save_state(state_path, initial)

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        apply_agent_specs(state, getattr(args, "agent", None))
        sprintengine = state.setdefault("sprintengine", {})
        if not sprintengine.get("name"):
            sprintengine["name"] = default_name
        if getattr(args, "goal", None) and not sprintengine.get("goal"):
            sprintengine["goal"] = args.goal
        legacy_plan_gate = find_architect_plan_gate(state, state_path)
        if legacy_plan_gate["task"] and not any(
            isinstance(task, dict) and task.get("role") == "product"
            for task in state.get("tasks", [])
        ):
            plan_gate = ensure_plan_approval_gate(state, state_path, "sprintengine", start_active=False)
            recompute_phase(state)
            return {"ok": True, "planGate": plan_gate}

        roles = roster_roles(state)
        should_create_product_gate = not roster_is_configured(state) or "product" in roles
        product_gate = (
            ensure_product_intake_gate(state, state_path, "sprintengine")
            if should_create_product_gate
            else None
        )
        product_task = product_gate["task"] if product_gate else None
        plan_gate = ensure_plan_approval_gate(
            state,
            state_path,
            "sprintengine",
            depends_on=str(product_task.get("id")) if product_task else None,
            start_active=False,
        )
        recompute_phase(state)
        return {
            "ok": True,
            "productGate": product_gate,
            "planGate": plan_gate,
        }

    init_state = with_locked_state(state_path, run)
    state = load_state(state_path)
    sprintengine = state.setdefault("sprintengine", {})
    plan_gate = init_state["planGate"]
    product_gate = init_state.get("productGate")
    return {
        "ok": True,
        "action": "initialized",
        "team": sprintengine.get("name") or default_name,
        "statePath": str(state_path),
        "productTask": product_gate["task"] if product_gate else None,
        "productArtifact": product_gate["artifact"] if product_gate else None,
        "planTask": plan_gate["task"],
        "planArtifact": plan_gate["artifact"],
    }
def cmd_join(args: argparse.Namespace) -> Dict[str, Any]:
    import sys
    print(f"[sprintengine] reading state from: {args.state}", file=sys.stderr)

    def completion_instruction() -> str:
        if args.role == "code_reviewer":
            return (
                "When complete: follow the claimed task's review mode. For review-and-fix tasks, make targeted "
                "source or test changes inside the owned paths when the fix is clear and bounded, log changed files "
                "and verification evidence, then mark the task done if acceptance is met. For review-only tasks, "
                "produce the requested review evidence or artifact. If unresolved findings remain, record them with "
                "repeatable `--finding-json` and, when an artifact is requested, `--recommended-task`; move the task "
                "to `needs_input` only when the review output requires approval or the task is blocked from meeting "
                "acceptance. "
            )
        return (
            "When complete: if you produced findings, issues, or changes_requested, move the task back to "
            "`needs_input` so the implementer/author can address them. Otherwise, mark it done. "
        )

    def role_boundary_instruction() -> str:
        return (
            f"You are assigned role `{args.role}`. Only claim and work tasks whose Sprint Engine "
            f"`task.role` exactly matches `{args.role}`. When instructed to keep picking up ready tasks, "
            f"interpret that as ready `{args.role}` tasks only. Do not run `sprintengine task claim`, "
            f"`sprintengine task status`, `sprintengine artifact ready`, `sprintengine plan`, or similar "
            f"mutating commands for another role's task unless the user explicitly changes your assigned role. "
            f"You may inspect other roles read-only to diagnose blockers. If no task is ready for `{args.role}`, "
            f"stop and report the blocker id if one is visible."
        )

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ensure_agent_in_roster(state, args.id, args.role)
        runtime = reconcile_agent(state, args.id, args.role)
        agent = runtime["agent"]
        active = runtime["activeTask"]
        ready = [t for t in state.get("tasks", []) if t.get("role") == args.role and task_is_ready(state, t)]

        if not active and not ready:
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "stop", "message": f"No tasks are currently ready for the '{args.role}' role. Either all tasks are complete or dependencies are not yet resolved. Stop now.", "write": runtime["dirty"]}

        prompt = load_prompt(args.role)
        if active:
            task_id = active.get("id")
            task_title = active.get("title") or "(untitled task)"
            directive = (
                f"\n\n---\n"
                f"## Your First Action\n"
                f"You are agent `{args.id}` with role `{args.role}`.\n"
                f"You already have active task `{task_id}`: {task_title}.\n\n"
                f"Run:\n```\nsprintengine task next --role {args.role} --id {args.id}\n```\n\n"
                f"This reconnects you to your existing active task instead of claiming a new one. "
                f"Continue the task and log evidence.\n\n"
                f"{role_boundary_instruction()}\n\n"
                f"{worker_plan_worktree_block()}\n\n"
                f"{artifact_registration_instruction(args.id)}\n\n"
                f"{completion_instruction()}"
                f"If you notice a prompt or process issue that would help improve future Sprint Engine runs, include it with repeatable `--issue-json` on your final feedback command. "
                f"If your role reviews work, report concrete bugs, security issues, requirement violations, or test gaps with repeatable `--finding-json`. "
                f"After completion, stop unless your current launch instructions explicitly tell you to keep claiming ready {args.role} tasks.\n\n"
                "**IMPORTANT: Do not edit .multi-code/sprintengine/state.yaml directly. "
                "All updates must go through the Sprint Engine tool.**"
            )
            return {"ok": True, "role": args.role, "agentId": args.id, "action": "resume", "task": active, "prompt": prompt + directive, "write": runtime["dirty"]}

        directive = (
            f"\n\n---\n"
            f"## Your First Action\n"
            f"You are agent `{args.id}` with role `{args.role}`.\n"
            f"There are **{len(ready)} task(s)** ready for your role.\n\n"
            f"Run:\n```\nsprintengine task next --role {args.role} --id {args.id}\n```\n\n"
            f"Complete the claimed task and log evidence.\n\n"
            f"{role_boundary_instruction()}\n\n"
            f"{worker_plan_worktree_block()}\n\n"
            f"{artifact_registration_instruction(args.id)}\n\n"
            f"{completion_instruction()}"
            f"If you notice a prompt or process issue that would help improve future Sprint Engine runs, include it with repeatable `--issue-json` on your final feedback command. "
            f"If your role reviews work, report concrete bugs, security issues, requirement violations, or test gaps with repeatable `--finding-json`. "
            f"After completion, stop unless your current launch instructions explicitly tell you to keep claiming ready {args.role} tasks.\n\n"
            "**IMPORTANT: Do not edit .multi-code/sprintengine/state.yaml directly. "
            "All updates must go through the Sprint Engine tool.**"
        )
        return {"ok": True, "role": args.role, "agentId": args.id, "action": "work", "readyTaskCount": len(ready), "prompt": prompt + directive, "write": runtime["dirty"]}

    return with_locked_state(args.state, run)


def cmd_merge_start(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state(args.state)
    target = args.target.strip()
    if not target:
        raise SystemExit("--target is required.")
    return {
        "ok": True,
        "role": "architect",
        "action": "merge_start",
        "id": args.id,
        "target": target,
        "prompt": build_merge_start_prompt(state, args.state, args.id, target),
    }


def build_recovery_prompt(state: Dict[str, Any], state_path: Path, backup_path: Path) -> str:
    sprintengine = state.get("sprintengine", {})
    goal = sprintengine.get("goal") or "(not set - read the codebase for context)"
    tasks = state.get("tasks", [])
    task_count = len(tasks)
    return "\n".join([
        "You are the recovery architect for this sprintengine.",
        f"Goal: {goal}",
        f"State file: {state_path}",
        f"Backup created: {backup_path}",
        f"Existing task count: {task_count}",
        "",
        "Keep this deliberately simple. This is an audit-only recovery pass, not a planning pass.",
        "Your only job is to compare the existing tasks against the current codebase and update each existing task status/evidence through the Sprint Engine tool.",
        "",
        "Hard rules:",
        "- Do NOT run `sprintengine init`.",
        "- Do NOT rewrite, replace, delete, or add tasks.",
        "- Do NOT run `Sprint Engine plan delete-task`, `Sprint Engine plan add-task`, `Sprint Engine plan update-task`, `Sprint Engine plan add-dependency`, `Sprint Engine plan remove-dependency`, or any task-board replanning command.",
        "- Do NOT edit plan.md or create a new plan.",
        "- Do NOT clear the board because tasks look stale.",
        "- Preserve task IDs, titles, descriptions, paths, dependencies, and acceptance criteria.",
        "- Only change status, notes, and evidence for tasks that already exist in state.yaml.",
        "",
        "Work through every existing task in state.yaml in order.",
        "",
        "For each task:",
        "1. Read the task title, description, owned paths, acceptance criteria, notes, and existing evidence.",
        "2. Inspect the current codebase for the relevant implementation.",
        "3. Decide the real status: todo, in_progress, needs_input, or done.",
        "4. Update only that task's status.",
        "5. If marking done or in_progress, append evidence with files checked, commands run, and a short result.",
        "6. If uncertain, mark needs_input or add a note. Do not guess.",
        "",
        "Use command discovery before your first mutation:",
        "- `sprintengine --help`",
        "- `sprintengine task status --help`",
        "- `sprintengine task log --help`",
        "- `sprintengine task note --help`",
        "",
        "Allowed write commands are limited to:",
        "- `sprintengine task status`",
        "- `sprintengine task log`",
        "- `sprintengine task note`",
        "",
        "If a needed command is unavailable or fails, stop and explain the blocker instead of changing the plan shape.",
    ])


def cmd_recover(args: argparse.Namespace) -> Dict[str, Any]:
    backup_path = backup_state_file(args.state)
    state = load_state(args.state)
    prompt = build_recovery_prompt(state, args.state, backup_path)
    return {
        "ok": True,
        "role": "architect",
        "action": "recover",
        "backupPath": str(backup_path),
        "taskCount": len(state.get("tasks", [])),
        "prompt": prompt,
    }


def cmd_roster_add(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        clean_id = args.id.strip()
        before = dict(state.get("agents", {}))
        agent = add_roster_agent(state, args.role, clean_id, args.actor or "architect")
        created = clean_id not in before
        return {
            "ok": True,
            "action": "added" if created else "exists",
            "agentId": clean_id,
            "role": args.role,
            "agent": agent,
        }

    return with_locked_state(args.state, run)


def cmd_roster_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        agents = [
            {"id": str(agent_id), "role": agent.get("role"), "status": agent.get("status"), "currentTaskId": agent.get("currentTaskId")}
            for agent_id, agent in state.get("agents", {}).items()
            if isinstance(agent, dict)
        ]
        return {
            "ok": True,
            "rosterConfigured": roster_is_configured(state),
            "agents": sorted(agents, key=lambda item: (str(item.get("role")), item["id"])),
            "write": False,
        }

    return with_locked_state(args.state, run)


def cmd_task_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ready = []
        for t in state.get("tasks", []):
            if getattr(args, "role", None) and t.get("role") != args.role:
                continue
            if task_is_ready(state, t):
                ready.append({"id": t.get("id"), "title": t.get("title"), "role": t.get("role"), "dependsOn": t.get("dependsOn", [])})
        return {"ok": True, "readyTasks": ready, "write": False}
    return with_locked_state(args.state, run)


def cmd_task_next(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ensure_agent_in_roster(state, args.id, args.role)
        runtime = reconcile_agent(state, args.id, args.role)
        agent = runtime["agent"]
        active = runtime["activeTask"]
        if active:
            return {"ok": True, "claimed": False, "reason": "agent_already_has_active_task", "task": active, "agent": agent, "write": runtime["dirty"]}

        for t in state.get("tasks", []):
            if t.get("role") != args.role or not task_is_ready(state, t):
                continue
            result = assign_task(state, t, args.id)
            recompute_phase(state)
            event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {t.get('id')}.")
            return {"ok": True, "claimed": True, "task": t, "agent": result["agent"], "event": event}

        phase_dirty = recompute_phase(state)
        return {"ok": True, "claimed": False, "reason": "no_ready_task", "message": f"No ready {args.role} tasks. Stop.", "write": runtime["dirty"] or phase_dirty}

    return with_locked_state(args.state, run)


def cmd_task_claim(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_agent_in_roster(state, args.id, str(task.get("role") or ""))
        agent = ensure_agent(state, args.id, task.get("role"))
        if not task_is_ready(state, task):
            return {"ok": False, "error": "Task is not ready.", "task": {"id": task.get("id"), "status": task.get("status")}, "write": False}
        result = assign_task(state, task, args.id)
        recompute_phase(state)
        event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {args.task_id}.")
        return {"ok": True, "task": task, "agent": result["agent"], "event": event}
    return with_locked_state(args.state, run)


def cmd_task_status(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        if feedback_args_present(args) and args.status != "done":
            raise SystemExit("Feedback flags on `sprintengine task status` are only supported with --status done.")
        task["status"] = args.status
        if args.status == "in_progress" and not task.get("startedAt"):
            task["startedAt"] = now_iso()
        if args.status == "done":
            task["completedAt"] = now_iso()
        if getattr(args, "summary", None):
            ensure_evidence(task)["summary"] = args.summary
        if task.get("ownerAgentId"):
            agent = ensure_agent(state, task["ownerAgentId"], task.get("role"))
            if args.status == "in_progress":
                agent["status"] = "running"
                agent["currentTaskId"] = args.task_id
            elif args.status == "needs_input":
                agent["status"] = "needs_input"
                agent["currentTaskId"] = args.task_id
        cleared = []
        if args.status not in ACTIVE_TASK_STATUSES:
            cleared = clear_task_refs(state, args.task_id)
        if args.status == "done" and task.get("ownerAgentId"):
            set_agent_idle(ensure_agent(state, task["ownerAgentId"], task.get("role")))
        feedback_payload = build_feedback_payload(args, state, args.state, task, actor)
        if feedback_payload:
            task["feedback"] = feedback_payload["stateFeedback"]
            append_event(state, "task_feedback_recorded", actor, f"{actor} recorded feedback for {args.task_id}.")
        recompute_phase(state)
        event = append_event(state, "task_status_changed", actor, f"{actor} moved {args.task_id} to {args.status}.")
        return {
            "ok": True,
            "task": task,
            "event": event,
            "clearedAgents": cleared,
            "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
        }
    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result


def cmd_task_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        dispatch = task.get("dispatch")
        actor = args.id or "user"
        if not isinstance(dispatch, dict) or dispatch.get("mode") != "manual":
            return {
                "ok": False,
                "error": "Task does not use manual dispatch.",
                "task": {"id": task.get("id"), "dispatch": dispatch},
                "write": False,
            }
        if task.get("status") != "todo" or task.get("ownerAgentId"):
            return {
                "ok": False,
                "error": "Only unclaimed todo tasks can be moved to Ready.",
                "task": {"id": task.get("id"), "status": task.get("status"), "ownerAgentId": task.get("ownerAgentId")},
                "write": False,
            }

        if dispatch.get("status") != "ready":
            dispatch["status"] = "ready"
            dispatch["triagedBy"] = args.triaged_by
            dispatch["readyAt"] = now_iso()
        else:
            dispatch.setdefault("triagedBy", args.triaged_by)
            dispatch.setdefault("readyAt", now_iso())

        recompute_phase(state)
        event = append_event(state, "task_dispatch_ready", actor, f"{actor} moved {args.task_id} to Ready.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)


def cmd_task_log(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ev = ensure_evidence(task)
        if getattr(args, "summary", None):
            ev["summary"] = args.summary
        add_unique_values(ev, "touchedFiles", args.file or [])
        ev["commandsRan"].extend(args.command or [])
        ev["results"].extend(args.result or [])
        event = append_event(state, "task_evidence_appended", args.id, f"{args.id} logged evidence for {args.task_id}.")
        return {"ok": True, "task": task, "event": event}
    return with_locked_state(args.state, run)


def cmd_task_note(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        task.setdefault("notes", []).append(args.note)
        event = append_event(state, "task_note_added", args.id, f"{args.id} added note to {args.task_id}.")
        return {"ok": True, "task": task, "event": event}
    return with_locked_state(args.state, run)


def cmd_plan_add_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ensure_role_in_roster(state, args.role)
        task = build_task_from_args(args, state)
        state.setdefault("tasks", []).append(task)
        recompute_phase(state)
        event = append_event(state, "task_added", args.actor, f"{args.actor} added {task['id']}: {task['title']}.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)


def cmd_plan_update_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)

        if args.title is not None:
            title = args.title.strip()
            if not title:
                raise SystemExit("Task title cannot be empty.")
            task["title"] = title
        if args.description is not None:
            task["description"] = args.description.strip()
        if args.clear_description:
            task["description"] = ""
        if args.role is not None:
            ensure_role_in_roster(state, args.role)
            task["role"] = args.role

        if args.clear_paths:
            task["ownedPaths"] = []
        set_unique_list(task, "ownedPaths", args.path)

        if args.clear_acceptance:
            task["acceptanceCriteria"] = []
        set_unique_list(task, "acceptanceCriteria", args.acceptance)

        if args.clear_notes:
            task["implementationNotes"] = []
        set_unique_list(task, "implementationNotes", args.note)

        recompute_phase(state)
        event = append_event(state, "task_updated", args.actor, f"{args.actor} updated {args.task_id}.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)


def cmd_plan_delete_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)

        dependents = task_dependents(state, args.task_id)
        if dependents and not args.unlink_dependents:
            return {
                "ok": False,
                "error": f"Task {args.task_id} is still a dependency of: {', '.join(dependents)}. Use --unlink-dependents to remove those links.",
                "write": False,
            }
        if args.unlink_dependents:
            for candidate in state.get("tasks", []):
                if isinstance(candidate, dict):
                    candidate["dependsOn"] = [dep for dep in candidate.get("dependsOn", []) if dep != args.task_id]

        clear_task_refs(state, args.task_id)
        state["tasks"] = [
            candidate for candidate in state.get("tasks", [])
            if not (isinstance(candidate, dict) and candidate.get("id") == args.task_id)
        ]
        recompute_phase(state)
        event = append_event(state, "task_deleted", args.actor, f"{args.actor} deleted {args.task_id}.")
        return {"ok": True, "deletedTaskId": args.task_id, "unlinkedDependents": dependents if args.unlink_dependents else [], "event": event}

    return with_locked_state(args.state, run)


def cmd_plan_add_dependency(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)
        ids = task_ids(state)
        deps = args.depends_on or []
        missing = [dep for dep in deps if dep not in ids]
        if missing:
            raise SystemExit(f"Unknown dependency for {args.task_id}: {', '.join(missing)}")
        if args.task_id in deps:
            raise SystemExit("A task cannot depend on itself.")

        added = add_unique_values(task, "dependsOn", deps)
        recompute_phase(state)
        event = append_event(state, "task_dependencies_added", args.actor, f"{args.actor} added dependencies to {args.task_id}: {', '.join(added) or 'none'}.")
        return {"ok": True, "task": task, "added": added, "event": event}

    return with_locked_state(args.state, run)


def cmd_plan_remove_dependency(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)
        removed = remove_values(task, "dependsOn", args.depends_on or [])
        recompute_phase(state)
        event = append_event(state, "task_dependencies_removed", args.actor, f"{args.actor} removed dependencies from {args.task_id}: {', '.join(removed) or 'none'}.")
        return {"ok": True, "task": task, "removed": removed, "event": event}

    return with_locked_state(args.state, run)


def cmd_plan_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        tasks = state.get("tasks", [])
        rows = [
            {
                "id": t.get("id"),
                "title": t.get("title"),
                "role": t.get("role"),
                "status": t.get("status"),
                "dependsOn": t.get("dependsOn", []),
                "descriptionPresent": bool(str(t.get("description", "")).strip()),
                "pathCount": len(t.get("ownedPaths", []) if isinstance(t.get("ownedPaths"), list) else []),
                "acceptanceCount": len(t.get("acceptanceCriteria", []) if isinstance(t.get("acceptanceCriteria"), list) else []),
                "noteCount": len(t.get("implementationNotes", []) if isinstance(t.get("implementationNotes"), list) else []),
            }
            for t in tasks
            if isinstance(t, dict)
        ]
        return {"ok": True, "tasks": rows, "write": False}

    return with_locked_state(args.state, run)


def cmd_plan_start_review(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state(args.state)
    ensure_role_in_roster(state, args.role)
    plan_path = plan_path_for_state(args.state)
    reviews_dir = plan_reviews_dir_for_state(args.state)
    fingerprint = plan_fingerprint(plan_path)
    reviews_dir.mkdir(parents=True, exist_ok=True)

    review_path = reviews_dir / safe_review_filename(args.id)
    existing_review = review_path.exists()
    if not existing_review:
        review_path.write_text(
            build_plan_review_template(args.id, args.role, plan_path, fingerprint),
            encoding="utf-8",
        )

    prompt = build_plan_review_prompt(
        args.id,
        args.role,
        args.state,
        plan_path,
        review_path,
        fingerprint,
        existing_review,
    )
    known_reviewers = expected_plan_reviewers(state)
    return {
        "ok": True,
        "role": args.role,
        "agentId": args.id,
        "action": "plan_review",
        "planPath": project_relative_display_path(args.state, plan_path),
        "reviewPath": project_relative_display_path(args.state, review_path),
        "reviewExisted": existing_review,
        "planFingerprint": fingerprint,
        "knownReviewers": known_reviewers,
        "prompt": prompt,
    }


def cmd_plan_review_status(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state(args.state)
    return {"ok": True, "action": "plan_review_status", **build_plan_review_status(state, args.state)}


def cmd_plan_address_reviews(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_state(args.state)
    reviews_dir = plan_reviews_dir_for_state(args.state)
    status = build_plan_review_status(state, args.state)
    review_contents = []

    if reviews_dir.exists():
        for path in sorted(reviews_dir.glob("*.md")):
            metadata = parse_review_metadata(path)
            review_contents.append({"path": str(path), "content": metadata["content"]})

    prompt = build_address_reviews_prompt(state, args.state, status, review_contents)
    return {
        "ok": True,
        "role": "architect",
        "actor": args.actor,
        "action": "address_plan_reviews",
        "planPath": status["planPath"],
        "reviewsDirectory": status["reviewsDirectory"],
        "reviewCount": len(review_contents),
        "status": status,
        "prompt": prompt,
    }


def cmd_artifact_add(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = build_artifact_from_args(args, state, args.state)
        state.setdefault("artifacts", []).append(artifact)
        event = append_event(state, "artifact_added", args.actor, f"{args.actor} registered artifact {artifact['id']} for {artifact['taskId']}.")
        ready_result = None
        if args.ready:
            ready_result = set_artifact_ready(state, artifact, args.actor, args.state)
        recompute_phase(state)
        return {"ok": True, "artifact": artifact, "ready": ready_result, "event": event}

    return with_locked_state(args.state, run)


def cmd_artifact_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifacts = []
        for artifact in state.get("artifacts", []):
            if not isinstance(artifact, dict):
                continue
            if args.task_id and artifact.get("taskId") != args.task_id:
                continue
            if args.kind and artifact.get("kind") != args.kind:
                continue
            if args.status and artifact.get("status") != args.status:
                continue
            artifacts.append(artifact)
        return {"ok": True, "artifacts": artifacts, "write": False}

    return with_locked_state(args.state, run)


def set_artifact_ready(
    state: Dict[str, Any],
    artifact: Dict[str, Any],
    actor: str,
    state_path: Path,
) -> Dict[str, Any]:
    if artifact.get("status") == "superseded":
        raise SystemExit("Superseded artifacts cannot be marked ready for review.")
    if artifact.get("status") == "approved":
        raise SystemExit("Approved artifacts cannot be marked ready for review.")

    task = find_task(state, str(artifact.get("taskId")))
    owner_id = str(task.get("ownerAgentId") or "").strip()
    task_role = str(task.get("role") or "").strip()
    created_by = str(artifact.get("createdBy") or "").strip()
    if owner_id and (not created_by or created_by in {task_role, "sprintengine"}):
        artifact["createdBy"] = owner_id
    path_info = normalize_artifact_path(state_path, str(artifact.get("path", "")), require_file=True)
    artifact["path"] = path_info["path"]
    artifact["fingerprint"] = file_fingerprint(path_info["absolutePath"])
    artifact["status"] = "ready_for_review"
    artifact["updatedAt"] = now_iso()
    artifact.pop("approvedBy", None)
    artifact.pop("approvedAt", None)
    artifact.pop("changesRequestedBy", None)
    artifact.pop("changesRequestedAt", None)
    append_artifact_history(artifact, "ready_for_review", actor)
    mark_task_needs_input_for_artifact(state, task)
    return {"taskId": task.get("id"), "taskStatus": task.get("status"), "artifactStatus": artifact.get("status")}


def cmd_artifact_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        ready_result = set_artifact_ready(state, artifact, args.id, args.state)
        task = find_task(state, str(artifact.get("taskId")))
        feedback_payload = build_feedback_payload(args, state, args.state, task, args.id)
        if feedback_payload:
            task["feedback"] = feedback_payload["stateFeedback"]
            append_event(state, "task_feedback_recorded", args.id, f"{args.id} recorded feedback for {task.get('id')}.")
        recompute_phase(state)
        event = append_event(state, "artifact_ready_for_review", args.id, f"{args.id} marked artifact {args.artifact_id} ready for review.")
        return {
            "ok": True,
            "artifact": artifact,
            "transition": ready_result,
            "event": event,
            "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
        }

    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result


def cmd_artifact_approve(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        if artifact.get("status") == "superseded":
            raise SystemExit("Superseded artifacts cannot be approved.")
        if artifact.get("status") == "draft":
            raise SystemExit("Draft artifacts must be marked ready before approval.")

        task = find_task(state, str(artifact.get("taskId")))
        artifact["status"] = "approved"
        artifact["approvedBy"] = args.id
        artifact["approvedAt"] = now_iso()
        artifact["updatedAt"] = artifact["approvedAt"]
        append_artifact_history(artifact, "approved", args.id)
        task_completed = mark_task_done_if_artifacts_approved(state, task)
        recompute_phase(state)
        event = append_event(state, "artifact_approved", args.id, f"{args.id} approved artifact {args.artifact_id}.")
        return {
            "ok": True,
            "artifact": artifact,
            "task": task,
            "taskCompleted": task_completed,
            "event": event,
        }

    return with_locked_state(args.state, run)


def cmd_artifact_request_changes(args: argparse.Namespace) -> Dict[str, Any]:
    feedback = args.feedback.strip()
    if not feedback:
        raise SystemExit("Change request feedback cannot be empty.")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        artifact = find_artifact(state, args.artifact_id)
        if artifact.get("status") == "superseded":
            raise SystemExit("Superseded artifacts cannot receive change requests.")

        task = find_task(state, str(artifact.get("taskId")))
        artifact["status"] = "changes_requested"
        artifact["changesRequestedBy"] = args.id
        artifact["changesRequestedAt"] = now_iso()
        artifact["updatedAt"] = artifact["changesRequestedAt"]
        artifact.pop("approvedBy", None)
        artifact.pop("approvedAt", None)
        append_artifact_history(artifact, "changes_requested", args.id, feedback)

        note = f"Changes requested for artifact {artifact.get('id')} ({artifact.get('title')}): {feedback}"
        task.setdefault("notes", []).append(note)
        reopened_status = reopen_task_for_artifact_changes(state, task)
        recompute_phase(state)
        event = append_event(state, "artifact_changes_requested", args.id, f"{args.id} requested changes for artifact {args.artifact_id}.")
        return {
            "ok": True,
            "artifact": artifact,
            "task": task,
            "reopenedStatus": reopened_status,
            "event": event,
        }

    return with_locked_state(args.state, run)


def cmd_summary(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": True, "summary": build_run_summary(state), "write": False}
    return with_locked_state(args.state, run)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

TOP_LEVEL_HELP = """\
Sprint Engine - all state mutations go through here. Never edit state.yaml directly.

Entry points (return full system prompt for the agent):
  sprintengine handover --name my-team --goal "..." --handover handover.md
  sprintengine init [--goal "..."]                                # bootstraps the board; agents claim ready tasks separately
  sprintengine recover
  sprintengine join --role developer --id developer-1
  sprintengine merge start --id architect --target main

Roster commands:
  sprintengine roster add --role security --id security
  sprintengine roster list

Task commands:
  sprintengine task next   --role developer --id developer-1
  sprintengine task claim  --task-id T3 --id developer-1
  sprintengine task status --task-id T3 --status done --id developer-1
  sprintengine task status --task-id T3 --status done --id developer-1 --confidence-pct 85 --hallucination-risk-pct 10
  sprintengine task log    --task-id T3 --id developer-1 --summary "..." --file src/foo.ts --command "npm test" --result "Passed"
  sprintengine task note   --task-id T3 --id developer-1 --note "Blocked on X"
  sprintengine task list   --role developer

Plan commands (architect only):
  sprintengine plan add-task --title "..." --role developer --description "Concrete worker brief..." --path src/foo --acceptance "..." --note "Implementation detail..."
  sprintengine plan add-task --title "Review and fix implementation quality" --role code_reviewer --depends-on T3 --path src/foo --description "Review-and-fix the completed implementation for correctness, modularity, maintainability, and verification gaps. Make targeted source or test changes when the fix is clear and bounded; record unresolved findings for the architect." --acceptance "Reviewer logs changed files and verification commands" --acceptance "Clear bounded issues are fixed directly or recorded with severity and recommended follow-up"
  sprintengine plan add-task --title "Review performance" --role performance --depends-on T4 --path src/foo --acceptance "Performance review artifact documents measured evidence, findings, or approval"
  sprintengine plan update-task --task-id T1 --title "..." --description "Concrete worker brief..." --path src/foo --acceptance "..." --note "Implementation detail..."
  sprintengine plan add-dependency --task-id T2 --depends-on T1
  sprintengine plan remove-dependency --task-id T2 --depends-on T1
  sprintengine plan delete-task --task-id T3 --unlink-dependents
  sprintengine plan start-review --role frontend --id frontend
  sprintengine plan review-status
  sprintengine plan address-reviews --actor architect
  sprintengine plan list

Artifact commands:
  sprintengine artifact add --task-id T1 --kind product_strategy --title "Strategy" --path .multi-code/sprintengine/team/documents/strategy.md --created-by product
  sprintengine artifact add --task-id T4 --kind code_review --title "Code review" --path .multi-code/sprintengine/team/reviews/review.md --created-by code-reviewer --recommended-task "Fix missing validation"
  sprintengine artifact add --task-id T5 --kind performance_review --title "Performance review" --path .multi-code/sprintengine/team/reviews/performance-review.md --created-by performance --recommended-task "Fix unbounded render work"
  sprintengine artifact list --task-id T1
  sprintengine artifact ready --artifact-id A1 --id product
  sprintengine artifact ready --artifact-id A1 --id product --confidence-pct 85 --hallucination-risk-pct 10
  sprintengine artifact approve --artifact-id A1 --id user
  sprintengine artifact request-changes --artifact-id A1 --id user --feedback "Tighten the scope."

Run summary:
  sprintengine summary

Post-run merge:
  sprintengine merge start --id architect --target main
"""


def add_handover_parser(sub: argparse._SubParsersAction, name: str, help_text: str) -> None:
    p = sub.add_parser(name, help=help_text)
    p.add_argument("--name", required=True, help="Team name; converted to a stable folder slug.")
    p.add_argument("--goal", default="", help="Goal for the future architect/sprintengine run.")
    handover = p.add_mutually_exclusive_group()
    handover.add_argument("--handover", type=Path, help="Path to markdown handover context to copy into handover.md.")
    handover.add_argument("--handover-text", help="Inline handover context to write to handover.md.")
    handover.add_argument("--handover-stdin", action="store_true", help="Read markdown handover context from stdin.")
    p.add_argument("--actor", default="handoff", help="Actor name for the team creation event.")
    p.add_argument("--agent", action="append", default=[], help="Selected roster member as role:id. Repeat for each specialist.")
    p.add_argument(
        "--use-worktrees",
        type=parse_bool,
        default=False,
        help=argparse.SUPPRESS,
    )
    p.add_argument("--force", action="store_true", help="Replace existing state/handover bootstrap files.")
    p.set_defaults(handler=cmd_handover, uses_state=False)


def add_feedback_arguments(parser: argparse.ArgumentParser) -> None:
    feedback = parser.add_argument_group("optional agent feedback")
    issue_categories = ", ".join(sorted(VALID_FEEDBACK_ISSUE_CATEGORIES))
    issue_severities = ", ".join(sorted(VALID_FEEDBACK_ISSUE_SEVERITIES))
    finding_kinds = ", ".join(sorted(VALID_FEEDBACK_FINDING_KINDS))
    finding_severities = ", ".join(sorted(VALID_FEEDBACK_FINDING_SEVERITIES))
    finding_areas = ", ".join(sorted(VALID_FEEDBACK_FINDING_AREAS))
    for attr, _, _ in FEEDBACK_SCORE_FIELDS:
        feedback.add_argument(
            f"--{attr.replace('_', '-')}",
            dest=attr,
            type=int,
            help="Optional agent self-assessment percentage from 0 to 100.",
        )
    feedback.add_argument("--top-friction", default="", help="Optional short note on the biggest friction point.")
    feedback.add_argument("--suggested-improvement", default="", help="Optional short prompt, task, or tool improvement suggestion.")
    feedback.add_argument(
        "--issue-json",
        action="append",
        default=[],
        help=(
            "Optional repeatable JSON object describing a prompt/process improvement issue. "
            "Required fields: category, severity, title, detail. "
            f"category: {issue_categories}. severity: {issue_severities}."
        ),
    )
    feedback.add_argument(
        "--finding-json",
        action="append",
        default=[],
        help=(
            "Optional repeatable JSON object describing a role-specific review finding. "
            "Required fields: kind, severity, area, title, detail. "
            f"kind: {finding_kinds}. severity: {finding_severities}. area: {finding_areas}."
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sprint Engine coordination tool",
        epilog=TOP_LEVEL_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--state",
        type=Path,
        default=None,
        help="Path to state file (auto-detected from cwd).",
    )

    sub = parser.add_subparsers(dest="group", required=True)

    # handover
    add_handover_parser(sub, "handover", "Create a Sprint Engine team bootstrap and canonical handover.md.")

    # init
    p = sub.add_parser("init", help="Bootstrap Sprint Engine state and initial gates.")
    p.add_argument("--goal", help="Goal for the run (stored in state).")
    p.add_argument("--agent", action="append", default=[], help="Selected roster member as role:id. Repeat for each specialist.")
    p.add_argument(
        "--use-worktrees",
        type=parse_bool,
        default=False,
        help=argparse.SUPPRESS,
    )
    p.set_defaults(handler=cmd_init)

    # recover
    p = sub.add_parser("recover", help="Start audit-only recovery mode, backs up state and returns full prompt.")
    p.set_defaults(handler=cmd_recover)

    # roster
    roster_p = sub.add_parser("roster", help="Roster operations.")
    roster_sub = roster_p.add_subparsers(dest="action", required=True)

    p = roster_sub.add_parser("add", help="Add a specialist to the canonical Sprint Engine roster.")
    p.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    p.add_argument("--id", required=True, help="Stable agent id, e.g. security or developer-2.")
    p.add_argument("--actor", default="architect")
    p.set_defaults(handler=cmd_roster_add)

    p = roster_sub.add_parser("list", help="List the canonical Sprint Engine roster.")
    p.set_defaults(handler=cmd_roster_list)

    # join
    p = sub.add_parser("join", help="Join Sprint Engine as worker, returns full role prompt.")
    p.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    p.add_argument("--id", required=True, help="Stable agent id, e.g. developer-1.")
    p.set_defaults(handler=cmd_join)

    # task
    task_p = sub.add_parser("task", help="Task operations.")
    task_sub = task_p.add_subparsers(dest="action", required=True)

    p = task_sub.add_parser("next", help="Claim the next ready task for your role.")
    p.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    p.add_argument("--id", required=True)
    p.set_defaults(handler=cmd_task_next)

    p = task_sub.add_parser("claim", help="Claim a specific task by ID.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.set_defaults(handler=cmd_task_claim)

    p = task_sub.add_parser("status", help="Update task status.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--status", required=True, choices=sorted(VALID_TASK_STATUSES))
    p.add_argument("--id", help="Agent id.")
    p.add_argument("--summary", help="Completion summary (used when status=done).")
    add_feedback_arguments(p)
    p.set_defaults(handler=cmd_task_status)

    p = task_sub.add_parser("ready", help="Move a manual-dispatch todo task to Ready.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", default="user", help="Actor id.")
    p.add_argument("--triaged-by", default="user", choices=sorted(VALID_TASK_DISPATCH_TRIAGED_BY))
    p.set_defaults(handler=cmd_task_ready)

    p = task_sub.add_parser("log", help="Log work evidence (files, commands, results).")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.add_argument("--summary")
    p.add_argument("--file", action="append", metavar="PATH")
    p.add_argument("--command", action="append", metavar="CMD")
    p.add_argument("--result", action="append", metavar="RESULT")
    p.set_defaults(handler=cmd_task_log)

    p = task_sub.add_parser("note", help="Add a freeform note to a task.")
    p.add_argument("--task-id", required=True)
    p.add_argument("--id", required=True, help="Agent id.")
    p.add_argument("--note", required=True)
    p.set_defaults(handler=cmd_task_note)

    p = task_sub.add_parser("list", help="List ready tasks for a role.")
    p.add_argument("--role", choices=sorted(VALID_ROLES))
    p.set_defaults(handler=cmd_task_list)

    # plan
    plan_p = sub.add_parser("plan", help="Plan operations (architect only).")
    plan_sub = plan_p.add_subparsers(dest="action", required=True)

    p = plan_sub.add_parser("add-task", help="Append a planned task to the board.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id")
    p.add_argument("--title", required=True)
    p.add_argument("--description", default="", help="Concrete task brief for the worker.")
    p.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    p.add_argument("--depends-on", action="append", default=[])
    p.add_argument("--path", action="append", default=[], help="Owned path or directory.")
    p.add_argument("--acceptance", action="append", default=[], help="Acceptance criterion.")
    p.add_argument("--note", action="append", default=[], help="Repeatable implementation detail from the plan.")
    p.set_defaults(handler=cmd_plan_add_task)

    p = plan_sub.add_parser("update-task", help="Edit an existing planned task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--title")
    p.add_argument("--description", help="Concrete task brief for the worker.")
    p.add_argument("--clear-description", action="store_true")
    p.add_argument("--role", choices=sorted(VALID_ROLES))
    p.add_argument("--path", action="append", help="Replace owned paths with this repeatable list.")
    p.add_argument("--clear-paths", action="store_true")
    p.add_argument("--acceptance", action="append", help="Replace acceptance criteria with this repeatable list.")
    p.add_argument("--clear-acceptance", action="store_true")
    p.add_argument("--note", action="append", help="Replace implementation notes with this repeatable list of details from the plan.")
    p.add_argument("--clear-notes", action="store_true")
    p.add_argument("--force", action="store_true", help="Allow editing an active or completed task.")
    p.set_defaults(handler=cmd_plan_update_task)

    p = plan_sub.add_parser("delete-task", help="Delete a planned task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--unlink-dependents", action="store_true", help="Remove this task from dependent tasks before deleting it.")
    p.add_argument("--force", action="store_true", help="Allow deleting an active or completed task.")
    p.set_defaults(handler=cmd_plan_delete_task)

    p = plan_sub.add_parser("add-dependency", help="Add dependency links to a task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--depends-on", action="append", required=True)
    p.add_argument("--force", action="store_true", help="Allow editing an active or completed task.")
    p.set_defaults(handler=cmd_plan_add_dependency)

    p = plan_sub.add_parser("remove-dependency", help="Remove dependency links from a task.")
    p.add_argument("--actor", default="architect")
    p.add_argument("--task-id", required=True)
    p.add_argument("--depends-on", action="append", required=True)
    p.add_argument("--force", action="store_true", help="Allow editing an active or completed task.")
    p.set_defaults(handler=cmd_plan_remove_dependency)

    p = plan_sub.add_parser("start-review", help="Start a specialist review of the architect plan.")
    p.add_argument("--role", required=True, choices=sorted(PLAN_REVIEW_ROLES))
    p.add_argument("--id", required=True, help="Stable agent id, e.g. frontend or developer-1.")
    p.set_defaults(handler=cmd_plan_start_review)

    p = plan_sub.add_parser("review-status", help="Summarize specialist plan review files.")
    p.set_defaults(handler=cmd_plan_review_status)

    p = plan_sub.add_parser("address-reviews", help="Start architect mode for addressing plan review feedback.")
    p.add_argument("--actor", default="architect")
    p.set_defaults(handler=cmd_plan_address_reviews)

    p = plan_sub.add_parser("list", help="List planned tasks.")
    p.set_defaults(handler=cmd_plan_list)

    # artifact
    artifact_p = sub.add_parser("artifact", help="Review artifact operations.")
    artifact_sub = artifact_p.add_subparsers(dest="action", required=True)

    p = artifact_sub.add_parser("add", help="Register a review artifact linked to a producing task.")
    p.add_argument("--actor", default="agent", help="Actor recording the artifact registration.")
    p.add_argument("--artifact-id", help="Stable artifact id. Defaults to the next A<number> id.")
    p.add_argument("--task-id", required=True, help="Producing task id.")
    p.add_argument("--kind", required=True, choices=sorted(VALID_ARTIFACT_KINDS))
    p.add_argument("--title", required=True, help="Human-readable review title.")
    p.add_argument("--path", required=True, help="Artifact file path under the active Sprint Engine team folder.")
    p.add_argument("--created-by", help="Agent or actor that produced the artifact.")
    p.add_argument("--recommended-task", action="append", default=[], help="Optional downstream task recommendation.")
    p.add_argument("--ready", action="store_true", help="Immediately mark the artifact ready for review.")
    p.set_defaults(handler=cmd_artifact_add)

    p = artifact_sub.add_parser("list", help="List review artifacts.")
    p.add_argument("--task-id", help="Filter by linked producing task id.")
    p.add_argument("--kind", choices=sorted(VALID_ARTIFACT_KINDS), help="Filter by artifact kind.")
    p.add_argument("--status", choices=sorted(VALID_ARTIFACT_STATUSES), help="Filter by artifact status.")
    p.set_defaults(handler=cmd_artifact_list)

    p = artifact_sub.add_parser("ready", help="Mark an artifact ready for human review and move its task to needs_input.")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--id", required=True, help="Actor or agent id.")
    add_feedback_arguments(p)
    p.set_defaults(handler=cmd_artifact_ready)

    p = artifact_sub.add_parser("approve", help="Approve an artifact and complete its task when all linked artifacts are approved.")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--id", required=True, help="Approving actor id.")
    p.set_defaults(handler=cmd_artifact_approve)

    p = artifact_sub.add_parser("request-changes", help="Request artifact changes, record feedback, and reopen the linked task.")
    p.add_argument("--artifact-id", required=True)
    p.add_argument("--id", required=True, help="Reviewing actor id.")
    p.add_argument("--feedback", required=True, help="Feedback to append to the linked task.")
    p.set_defaults(handler=cmd_artifact_request_changes)

    # summary
    p = sub.add_parser("summary", help="Print final run summary.")
    p.set_defaults(handler=cmd_summary)

    # merge
    merge_p = sub.add_parser("merge", help="Post-run merge instructions.")
    merge_sub = merge_p.add_subparsers(dest="action", required=True)
    p = merge_sub.add_parser("start", help="Return canonical architect merge instructions.")
    p.add_argument("--id", required=True, help="Architect actor id.")
    p.add_argument("--target", required=True, help="Target branch for the user-authorized merge.")
    p.set_defaults(handler=cmd_merge_start)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "uses_state", True):
        state_path = args.state or default_state_path()
        reject_invalid_posix_state_path(state_path)
        args.state = state_path.resolve()
    elif args.state is not None:
        reject_invalid_posix_state_path(args.state)
        args.state = args.state.resolve()
    result = args.handler(args)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
