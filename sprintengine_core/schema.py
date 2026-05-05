"""Canonical Sprint Engine execution schema.

The schema is intentionally close to the current Swarm state shape so storage
and compatibility layers can adapt existing `swarm/<team>/state.yaml` files
without introducing planning, entitlement, or desktop-app concepts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

TASK_STATUSES = ("todo", "in_progress", "needs_input", "done")
AGENT_STATUSES = ("idle", "running", "needs_input", "done")
ARTIFACT_STATUSES = (
    "draft",
    "ready_for_review",
    "approved",
    "changes_requested",
    "superseded",
)
ARTIFACT_KINDS = (
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
)
SPECIALIST_ROLES = (
    "architect",
    "product",
    "developer",
    "frontend",
    "tester",
    "security",
    "code_reviewer",
    "performance",
    "devops",
)
AUTO_RUN_STATUSES = ("idle", "running", "paused", "stopped", "completed", "failed")

TaskStatus = Literal["todo", "in_progress", "needs_input", "done"]
AgentStatus = Literal["idle", "running", "needs_input", "done"]
ArtifactStatus = Literal[
    "draft",
    "ready_for_review",
    "approved",
    "changes_requested",
    "superseded",
]
AutoRunStatus = Literal["idle", "running", "paused", "stopped", "completed", "failed"]


JsonDict = dict[str, Any]


def _copy_strings(values: list[str]) -> list[str]:
    return [str(value) for value in values]


@dataclass(frozen=True, slots=True)
class SourceMetadata:
    """Where a Sprint Engine object was loaded from or persisted."""

    format: str
    path: str | None = None
    key_path: str | None = None
    version: int | str | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {"format": self.format}
        if self.path is not None:
            data["path"] = self.path
        if self.key_path is not None:
            data["keyPath"] = self.key_path
        if self.version is not None:
            data["version"] = self.version
        return data


@dataclass(frozen=True, slots=True)
class SpecialistRoleRef:
    """Reference to the role registry entry that should execute a task."""

    id: str
    label: str | None = None
    prompt_path: str | None = None
    expected_artifact_kinds: list[str] = field(default_factory=list)
    stop_conditions: list[str] = field(default_factory=list)

    def to_dict(self) -> JsonDict:
        data: JsonDict = {"id": self.id}
        if self.label is not None:
            data["label"] = self.label
        if self.prompt_path is not None:
            data["promptPath"] = self.prompt_path
        if self.expected_artifact_kinds:
            data["expectedArtifactKinds"] = _copy_strings(self.expected_artifact_kinds)
        if self.stop_conditions:
            data["stopConditions"] = _copy_strings(self.stop_conditions)
        return data


@dataclass(frozen=True, slots=True)
class Evidence:
    """Task evidence recorded by an executing agent."""

    summary: str = ""
    touched_files: list[str] = field(default_factory=list)
    commands_ran: list[str] = field(default_factory=list)
    results: list[str] = field(default_factory=list)

    def to_dict(self) -> JsonDict:
        return {
            "summary": self.summary,
            "touchedFiles": _copy_strings(self.touched_files),
            "commandsRan": _copy_strings(self.commands_ran),
            "results": _copy_strings(self.results),
        }


@dataclass(frozen=True, slots=True)
class Blocker:
    """A concrete execution blocker on a task."""

    id: str
    summary: str
    created_at: str | None = None
    resolved_at: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {"id": self.id, "summary": self.summary}
        if self.created_at is not None:
            data["createdAt"] = self.created_at
        if self.resolved_at is not None:
            data["resolvedAt"] = self.resolved_at
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class SprintTask:
    """Execution-native unit of work."""

    id: str
    title: str
    role: str
    status: TaskStatus = "todo"
    description: str = ""
    owner_agent_id: str | None = None
    depends_on: list[str] = field(default_factory=list)
    owned_paths: list[str] = field(default_factory=list)
    acceptance_criteria: list[str] = field(default_factory=list)
    implementation_notes: list[str] = field(default_factory=list)
    evidence: Evidence = field(default_factory=Evidence)
    notes: list[str] = field(default_factory=list)
    learned_facts: list[str] = field(default_factory=list)
    blockers: list[Blocker] = field(default_factory=list)
    started_at: str | None = None
    completed_at: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "role": self.role,
            "status": self.status,
            "ownerAgentId": self.owner_agent_id,
            "dependsOn": _copy_strings(self.depends_on),
            "ownedPaths": _copy_strings(self.owned_paths),
            "acceptanceCriteria": _copy_strings(self.acceptance_criteria),
            "implementationNotes": _copy_strings(self.implementation_notes),
            "evidence": self.evidence.to_dict(),
            "notes": _copy_strings(self.notes),
            "learnedFacts": _copy_strings(self.learned_facts),
            "blockers": [blocker.to_dict() for blocker in self.blockers],
            "startedAt": self.started_at,
            "completedAt": self.completed_at,
        }
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class ReviewHistoryEntry:
    """Artifact review transition history."""

    action: str
    actor: str
    timestamp: str
    feedback: str | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "action": self.action,
            "actor": self.actor,
            "timestamp": self.timestamp,
        }
        if self.feedback is not None:
            data["feedback"] = self.feedback
        return data


@dataclass(frozen=True, slots=True)
class SprintArtifact:
    """Reviewable or durable output attached to an execution task."""

    id: str
    kind: str
    title: str
    path: str
    status: ArtifactStatus
    created_by: str
    task_id: str | None = None
    review_history: list[ReviewHistoryEntry] = field(default_factory=list)
    recommended_tasks: list[str] = field(default_factory=list)
    approved_by: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "path": self.path,
            "status": self.status,
            "createdBy": self.created_by,
            "taskId": self.task_id,
            "reviewHistory": [entry.to_dict() for entry in self.review_history],
            "recommendedTasks": _copy_strings(self.recommended_tasks),
        }
        if self.approved_by is not None:
            data["approvedBy"] = self.approved_by
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class SprintAgent:
    """Agent slot participating in a run."""

    id: str
    role: str
    status: AgentStatus = "idle"
    current_task_id: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "id": self.id,
            "role": self.role,
            "status": self.status,
            "currentTaskId": self.current_task_id,
        }
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class SprintEvent:
    """Append-only execution event."""

    id: str
    timestamp: str
    type: str
    actor: str
    message: str
    task_id: str | None = None
    artifact_id: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "id": self.id,
            "timestamp": self.timestamp,
            "type": self.type,
            "actor": self.actor,
            "message": self.message,
        }
        if self.task_id is not None:
            data["taskId"] = self.task_id
        if self.artifact_id is not None:
            data["artifactId"] = self.artifact_id
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class AutoRunState:
    """Headless execution state; terminal spawning remains outside the core."""

    status: AutoRunStatus = "idle"
    enabled: bool = False
    requested_by: str | None = None
    started_at: str | None = None
    stopped_at: str | None = None
    last_error: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "status": self.status,
            "enabled": self.enabled,
            "requestedBy": self.requested_by,
            "startedAt": self.started_at,
            "stoppedAt": self.stopped_at,
            "lastError": self.last_error,
        }
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class SprintRun:
    """Top-level Sprint Engine run metadata."""

    id: str
    name: str
    goal: str = ""
    status: str = "planning"
    updated_at: str | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "id": self.id,
            "name": self.name,
            "goal": self.goal,
            "status": self.status,
            "updatedAt": self.updated_at,
        }
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class SprintReport:
    """Serializable run report payload for export commands."""

    run_id: str
    generated_at: str
    summary: str = ""
    evidence: list[Evidence] = field(default_factory=list)
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "runId": self.run_id,
            "generatedAt": self.generated_at,
            "summary": self.summary,
            "evidence": [record.to_dict() for record in self.evidence],
        }
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


@dataclass(frozen=True, slots=True)
class SprintEngineState:
    """Complete execution state exposed by Sprint Engine read APIs."""

    schema_version: int
    run: SprintRun
    tasks: list[SprintTask] = field(default_factory=list)
    artifacts: list[SprintArtifact] = field(default_factory=list)
    agents: list[SprintAgent] = field(default_factory=list)
    events: list[SprintEvent] = field(default_factory=list)
    specialist_roles: list[SpecialistRoleRef] = field(default_factory=list)
    auto_run: AutoRunState | None = None
    source: SourceMetadata | None = None

    def to_dict(self) -> JsonDict:
        data: JsonDict = {
            "schemaVersion": self.schema_version,
            "run": self.run.to_dict(),
            "tasks": [task.to_dict() for task in self.tasks],
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
            "agents": [agent.to_dict() for agent in self.agents],
            "events": [event.to_dict() for event in self.events],
            "specialistRoles": [role.to_dict() for role in self.specialist_roles],
            "autoRun": self.auto_run.to_dict() if self.auto_run is not None else None,
        }
        if self.source is not None:
            data["source"] = self.source.to_dict()
        return data


def to_json_dict(value: Any) -> JsonDict:
    """Return a JSON-compatible dictionary for any Sprint Engine schema object."""

    to_dict = getattr(value, "to_dict", None)
    if not callable(to_dict):
        raise TypeError(
            "Object does not support Sprint Engine serialization: "
            f"{type(value).__name__}"
        )
    data = to_dict()
    if not isinstance(data, dict):
        raise TypeError(
            f"Sprint Engine serializer returned {type(data).__name__}, expected dict"
        )
    return data
