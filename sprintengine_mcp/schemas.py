"""Typed tool schemas for the local sprintengine MCP boundary."""

from __future__ import annotations

from typing import Any

from sprintengine_core.tool.constants import (
    FEEDBACK_COUNT_FIELDS,
    FEEDBACK_SCORE_FIELDS,
    FEEDBACK_TEXT_FIELDS,
    NEEDS_INPUT_KIND_INPUT_CHOICES,
    VALID_NEEDS_INPUT_REASONS,
    VALID_PHASE_OUTCOMES,
    VALID_TASK_PHASES,
    VALID_TASK_STATUSES,
)

from .tool_contracts import ACTIVE_TOOL_NAMES


STATE_PATH_PROPERTY = {
    "type": "string",
    "description": "Run state path; server-resolved, agents normally omit it.",
}

WORKSPACE_ROOT_PROPERTY = {
    "type": "string",
    "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root.",
}

AGENT_ID_PROPERTY = {
    "type": "string",
    "description": "Stable Sprint Engine agent id, for example developer-1.",
}

ROLE_PROPERTY = {
    "type": "string",
    "description": "Canonical Sprint Engine role id, after registry alias resolution.",
}

PLUGIN_REGISTRY_ROOTS_PROPERTY = {
    "type": "array",
    "description": "Loaded plugin registry roots that contain Sprint Engine roles/ and skills/ directories.",
    "items": {
        "type": "object",
        "required": ["root"],
        "properties": {
            "id": {"type": "string"},
            "root": {"type": "string"},
        },
    },
}

EXTRA_DIRS_PROPERTY = {
    "type": "array",
    "description": "Additional path-only registry roots containing roles/ and skills/ directories.",
    "items": {"type": "string"},
}

TASK_ID_PROPERTY = {"type": "string", "description": "Sprint Engine task id, for example T3."}
ARTIFACT_ID_PROPERTY = {"type": "string", "description": "Sprint Engine artifact id."}
DISPATCH_ID_PROPERTY = {"type": "string", "description": "Stable idempotent dispatch ledger id."}

ACTOR_SCHEMA = {
    "type": "object",
    "required": ["id"],
    "properties": {
        "id": {"type": "string"},
        "role": {"type": "string"},
        "authenticated": {"type": "boolean"},
        "mcpAuthorized": {"type": "boolean"},
    },
}


# `statePath` and `workspaceRoot` are server-resolvable from launch env
# (`SPRINTENGINE_STATE_PATH`, `SPRINTENGINE_WORKSPACE_ROOT`) and from
# state-path-to-workspace-root derivation. Autonomous agents should not need to
# pass them, so the schema marks them optional even when callers list them in
# `required` for documentation. Debug/CLI callers can still pass them explicitly.
_SERVER_RESOLVABLE_REQUIRED = {"statePath", "workspaceRoot"}


def object_schema(required: list[str], properties: dict[str, Any]) -> dict[str, Any]:
    filtered_required = [name for name in required if name not in _SERVER_RESOLVABLE_REQUIRED]
    return {
        "type": "object",
        "required": filtered_required,
        "additionalProperties": True,
        "properties": {"statePath": STATE_PATH_PROPERTY, **properties},
    }


def feedback_properties() -> dict[str, Any]:
    properties: dict[str, Any] = {}
    percent_schema = {"type": "integer", "minimum": 0, "maximum": 100}
    count_schema = {"type": "integer", "minimum": 0}
    text_schema = {"type": "string"}
    json_list_schema = {
        "type": "array",
        "items": {
            "anyOf": [
                {"type": "object", "additionalProperties": True},
                {"type": "string"},
            ]
        },
    }
    # Schemas advertise camelCase only; the payload adapter still accepts the
    # snake_case spellings for compatibility (`add_feedback_defaults`).
    for _attr, camel, _ in FEEDBACK_SCORE_FIELDS:
        properties[camel] = percent_schema
    for _attr, camel, _ in FEEDBACK_COUNT_FIELDS:
        properties[camel] = count_schema
    for _attr, camel, _ in FEEDBACK_TEXT_FIELDS:
        properties[camel] = text_schema
    properties.update(
        {
            "reviewTargetTaskId": {"type": "string"},
            "reviewTargetAgentId": {"type": "string"},
            "reviewTargetExecutionId": {"type": "string"},
            "issueJson": json_list_schema,
            "findingJson": json_list_schema,
        }
    )
    return properties


FEEDBACK_PROPERTIES = feedback_properties()


# Schemas advertise camelCase only; the payload adapter still accepts the
# snake_case spellings (`add_*_difficulty_defaults`).
def implementer_difficulty_properties() -> dict[str, Any]:
    return {
        "actualDifficultyPct": {"type": "integer", "minimum": 0, "maximum": 100},
        "actualDifficultyReason": {"type": "string"},
    }


IMPLEMENTER_DIFFICULTY_PROPERTIES = implementer_difficulty_properties()
ARCHITECT_DIFFICULTY_PROPERTIES = {
    "difficultyPct": {"type": "integer", "minimum": 0, "maximum": 100},
    "difficultyReason": {"type": "string"},
}
# A task's post-implementation phases. Absent inherits the run's `defaultPhases`;
# `[]` routes publish straight to `done`. Must be a subset of the run's list.
PHASES_PROPERTY = {
    "type": "array",
    "items": {"type": "string", "enum": sorted(VALID_TASK_PHASES)},
    "description": "Ordered post-implementation phases for this task. Omit to inherit the run default; [] for none. Must be a subset of the run's defaultPhases.",
}


MCP_V1_CONTRACT_SCHEMAS: dict[str, dict[str, Any]] = {
    "sprintengine.help": object_schema(
        [],
        {
            "role": ROLE_PROPERTY,
            "agentId": AGENT_ID_PROPERTY,
            "topic": {
                "type": "string",
                "enum": ["agent_workflow", "tools", "needs_input", "artifacts", "phases"],
                "description": "Optional help topic. Defaults to agent_workflow.",
            },
        },
    ),
    "sprintengine.handover": object_schema(
        ["statePath", "name"],
        {
            "name": {"type": "string", "description": "Sprint Engine team name used for the bootstrap."},
            "goal": {"type": "string"},
            "handoverPath": {"type": "string", "description": "Markdown handoff file to import into the canonical handover.md (or reference in place when reference is true)."},
            "handoverText": {"type": "string", "description": "Inline markdown handoff context to write into the canonical handover.md."},
            "sourcePlanKind": {"type": "string", "enum": ["unknown", "product_plan", "architect_plan", "epic"]},
            "reference": {
                "type": "boolean",
                "description": "When true, record handoverPath and every sourceBundle item as project-root-relative references instead of copying them into the run store. The originals stay canonical and are read and updated in place. Used for backlog-sourced sprints (e.g. an epic and its child design documents).",
            },
            "sourceBundle": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["unknown", "product_plan", "architect_plan", "html_mockup", "design_notes", "plan_overview", "generic_context"],
                        },
                        "sourcePath": {"type": "string"},
                    },
                    "required": ["kind", "sourcePath"],
                    "additionalProperties": True,
                },
            },
            "actor": {"type": "string"},
            "force": {"type": "boolean"},
        },
    ),
    "sprintengine.init": object_schema(["statePath"], {"goal": {"type": "string"}, "useWorktrees": {"type": "boolean"}, "agent": {"type": "array", "items": {"type": "string"}}}),
    "sprintengine.recover": object_schema(["statePath"], {}),
    "sprintengine.roster.add": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}, "actor": {"type": "string"}}),
    "sprintengine.roster.configure": object_schema(
        ["statePath", "roles"],
        {
            "roles": {
                "type": "array",
                "description": "Roles to enable with a pinned runtime each. Every cli/model must exactly match an entry in the sprint's allowedRuntimes palette.",
                "items": {
                    "type": "object",
                    "required": ["role", "cli"],
                    "properties": {
                        "role": {"type": "string", "description": "Registry role id to enable."},
                        "cli": {"type": "string", "description": "Runtime CLI/plugin id, e.g. claude-code."},
                        "model": {"type": ["string", "null"], "description": "Model id, or null for the CLI's default (no --model)."},
                    },
                },
            },
            "id": {"type": "string", "description": "Architect actor id recording the configuration."},
        },
    ),
    "sprintengine.roster.retire": object_schema(["statePath", "id", "reason"], {"id": {"type": "string"}, "reason": {"type": "string"}, "actor": {"type": "string"}}),
    "sprintengine.roster.replenish": object_schema(["statePath"], {"role": {"type": "string"}, "actor": {"type": "string"}}),
    "sprintengine.roster.list": object_schema(["statePath"], {}),
    "sprintengine.agent.join": object_schema(
        ["statePath", "role", "agentId"],
        {
            "role": ROLE_PROPERTY,
            "agentId": AGENT_ID_PROPERTY,
            "workspaceRoot": WORKSPACE_ROOT_PROPERTY,
            "subscribe": {"type": "boolean", "description": "Whether the agent wants dispatch subscription metadata recorded during join."},
            "subscriptionMode": {"type": "string", "enum": ["none", "poll", "mcp_notifications"]},
        },
    ),
    "sprintengine.agent.next_directive": object_schema(
        ["statePath", "role", "agentId"],
        {
            "role": ROLE_PROPERTY,
            "agentId": AGENT_ID_PROPERTY,
            "attempts": {
                "type": "integer",
                "minimum": 1,
                "description": "Current watch attempt count, used only to calculate retry timing for idle auto-mode directives.",
            },
        },
    ),
    "sprintengine.agent.heartbeat": object_schema(["statePath", "agentId"], {"agentId": AGENT_ID_PROPERTY, "role": ROLE_PROPERTY}),
    "sprintengine.agent.leave": object_schema(["statePath", "agentId"], {"agentId": AGENT_ID_PROPERTY, "role": ROLE_PROPERTY, "reason": {"type": "string"}}),
    "sprintengine.subscribe": object_schema(
        ["statePath", "agentId"],
        {
            "agentId": AGENT_ID_PROPERTY,
            "lastDispatchId": DISPATCH_ID_PROPERTY,
            "transport": {"type": "string", "enum": ["mcp_notifications", "poll"]},
        },
    ),
    "sprintengine.join": object_schema(
        ["statePath", "role", "id"],
        {
            "role": ROLE_PROPERTY,
            "id": AGENT_ID_PROPERTY,
            "watch": {"type": "boolean", "description": "Compatibility flag for CLI join --watch polling."},
            "maxWaitSeconds": {"type": "number", "description": "Compatibility timeout for CLI join --watch diagnostics."},
        },
    ),
    "sprintengine.summary": object_schema(["statePath"], {}),
    "sprintengine.dispatch.next": object_schema(
        ["statePath", "agentId"],
        {"agentId": AGENT_ID_PROPERTY, "lastDispatchId": DISPATCH_ID_PROPERTY},
    ),
    "sprintengine.dispatch.ack": object_schema(
        ["statePath", "agentId", "dispatchId"],
        {"agentId": AGENT_ID_PROPERTY, "dispatchId": DISPATCH_ID_PROPERTY, "outcome": {"type": "string"}},
    ),
    "sprintengine.triage.needs_input": object_schema(["statePath", "id"], {"id": AGENT_ID_PROPERTY}),
    "sprintengine.roles.list": object_schema(["workspaceRoot"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "includeShadowed": {"type": "boolean"}, "pluginRegistryRoots": PLUGIN_REGISTRY_ROOTS_PROPERTY, "extraDirs": EXTRA_DIRS_PROPERTY}),
    "sprintengine.roles.get": object_schema(["workspaceRoot", "roleId"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "roleId": ROLE_PROPERTY, "pluginRegistryRoots": PLUGIN_REGISTRY_ROOTS_PROPERTY, "extraDirs": EXTRA_DIRS_PROPERTY}),
    "sprintengine.soul.get": object_schema(["workspaceRoot", "roleId"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "roleId": ROLE_PROPERTY, "runId": {"type": "string"}, "pluginRegistryRoots": PLUGIN_REGISTRY_ROOTS_PROPERTY, "extraDirs": EXTRA_DIRS_PROPERTY}),
    "sprintengine.skills.list": object_schema(["workspaceRoot"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "includeBody": {"type": "boolean"}, "pluginRegistryRoots": PLUGIN_REGISTRY_ROOTS_PROPERTY, "extraDirs": EXTRA_DIRS_PROPERTY}),
    "sprintengine.skill.get": object_schema(["workspaceRoot", "skillId"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "skillId": {"type": "string"}, "pluginRegistryRoots": PLUGIN_REGISTRY_ROOTS_PROPERTY, "extraDirs": EXTRA_DIRS_PROPERTY}),
    "sprintengine.task.get": object_schema(["statePath", "taskId"], {"taskId": TASK_ID_PROPERTY, "include": {"type": "array", "items": {"type": "string", "enum": ["activity", "comments", "evidence_log", "diffs"]}, "description": "Deep-read sections to add to the slim task card."}}),
    "sprintengine.task.next": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.task.claim": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.task.status": object_schema(["statePath", "taskId", "status", "id"], {"taskId": {"type": "string"}, "status": {"type": "string", "enum": sorted(VALID_TASK_STATUSES)}, "id": {"type": "string"}, "summary": {"type": "string"}, "needsInputKind": {"type": "string", "enum": NEEDS_INPUT_KIND_INPUT_CHOICES}, "needsInputReason": {"type": "string"}, "needsInputArtifactId": {"type": "string"}, "needsInputQuestion": {"type": "string"}, "needsInputSuggestedResolution": {"type": "string"}, **FEEDBACK_PROPERTIES}),
    "sprintengine.task.resolve_input": object_schema(["statePath", "taskId", "id", "resolution"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "resolution": {"type": "string"}, "complete": {"type": "boolean"}}),
    "sprintengine.task.release": object_schema(["statePath", "taskId", "id", "reason"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "reason": {"type": "string"}}),
    "sprintengine.task.log": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "summary": {"type": "string"}, "file": {"type": "array"}, "command": {"type": "array"}, "result": {"type": "array"}, "scopeExpansionJson": {"type": "array"}}),
    "sprintengine.task.note": object_schema(["statePath", "taskId", "id", "note"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "note": {"type": "string"}}),
    "sprintengine.task.comment": object_schema(["statePath", "taskId", "id", "body"], {"taskId": TASK_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "body": {"type": "string"}, "source": {"type": "string"}, "commentType": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "data": {"type": "object"}}),
    "sprintengine.task.comment.list": object_schema(["statePath", "taskId"], {"taskId": TASK_ID_PROPERTY, "limit": {"type": "integer", "minimum": 1, "description": "Maximum comments returned, newest last. Defaults to 20."}}),
    "sprintengine.task.list": object_schema(["statePath"], {"role": ROLE_PROPERTY, "status": {"type": "string"}, "includeDone": {"type": "boolean"}}),
    "sprintengine.task.publish": object_schema(["statePath", "taskId", "id", "summary"], {"taskId": TASK_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "summary": {"type": "string"}, "path": {"type": "array", "items": {"type": "string"}}, "file": {"type": "array", "items": {"type": "string"}}, "data": {"type": "object"}, "summaryDataJson": {"type": "string"}, **IMPLEMENTER_DIFFICULTY_PROPERTIES}),
    "sprintengine.task.advance": object_schema(
        ["statePath", "taskId", "id", "phase", "outcome", "summary"],
        {
            "taskId": TASK_ID_PROPERTY,
            "id": AGENT_ID_PROPERTY,
            "phase": {"type": "string", "enum": sorted(VALID_TASK_PHASES), "description": "The phase you are closing. Must equal the task's current status."},
            "outcome": {"type": "string", "enum": sorted(VALID_PHASE_OUTCOMES), "description": "pass = nothing to fix; pass_with_fixes = you found and fixed issues; escalate = a plan/scope/product decision blocks you."},
            "summary": {"type": "string", "description": "Short rationale for agent readers (~280 chars)."},
            "needsInputKind": {"type": "string", "enum": NEEDS_INPUT_KIND_INPUT_CHOICES},
            "needsInputReason": {"type": "string", "enum": sorted(VALID_NEEDS_INPUT_REASONS)},
            "needsInputQuestion": {"type": "string", "description": "Required with outcome=escalate."},
            "needsInputSuggestedResolution": {"type": "string"},
            **FEEDBACK_PROPERTIES,
        },
    ),
    "sprintengine.plan.add_task": object_schema(["statePath", "title", "role"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "title": {"type": "string"}, "description": {"type": "string"}, "role": {"type": "string"}, "dependsOn": {"type": "array"}, "path": {"type": "array"}, "acceptance": {"type": "array"}, "note": {"type": "array"}, "taskNote": {"type": "array"}, "producesImplementation": {"type": "boolean"}, "needsTriage": {"type": "boolean"}, "phases": PHASES_PROPERTY, "productFacing": {"type": "boolean"}, "notProductFacing": {"type": "boolean"}, **ARCHITECT_DIFFICULTY_PROPERTIES}),
    "sprintengine.plan.update_task": object_schema(["statePath", "taskId"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "title": {"type": "string"}, "description": {"type": "string"}, "role": {"type": "string"}, "path": {"type": "array"}, "acceptance": {"type": "array"}, "note": {"type": "array"}, "taskNote": {"type": "array"}, "clearTaskNotes": {"type": "boolean"}, "producesImplementation": {"type": "boolean"}, "needsTriage": {"type": "boolean"}, "clearNeedsTriage": {"type": "boolean"}, "phases": PHASES_PROPERTY, "productFacing": {"type": "boolean"}, "notProductFacing": {"type": "boolean"}, **ARCHITECT_DIFFICULTY_PROPERTIES}),
    "sprintengine.plan.delete_task": object_schema(["statePath", "taskId"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "unlinkDependents": {"type": "boolean"}}),
    "sprintengine.plan.add_dependency": object_schema(["statePath", "taskId", "dependsOn"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "dependsOn": {"type": "array"}}),
    "sprintengine.plan.remove_dependency": object_schema(["statePath", "taskId", "dependsOn"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "dependsOn": {"type": "array"}}),
    "sprintengine.plan.start_review": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.plan.review_status": object_schema(["statePath"], {}),
    "sprintengine.plan.address_reviews": object_schema(["statePath"], {"actor": {"type": "string"}}),
    "sprintengine.plan.list": object_schema(["statePath"], {}),
    "sprintengine.plan.read": object_schema(["statePath"], {}),
    "sprintengine.artifact.add": object_schema(["statePath", "taskId", "kind", "title", "path"], {"actor": {"type": "string"}, "artifactId": {"type": "string"}, "taskId": {"type": "string"}, "kind": {"type": "string"}, "title": {"type": "string"}, "path": {"type": "string"}, "createdBy": {"type": "string"}, "recommendedTask": {"type": "array"}, "ready": {"type": "boolean"}}),
    "sprintengine.artifact.list": object_schema(["statePath"], {"taskId": {"type": "string"}, "kind": {"type": "string"}, "status": {"type": "string"}}),
    "sprintengine.artifact.ready": object_schema(["statePath", "artifactId", "id"], {"artifactId": ARTIFACT_ID_PROPERTY, "id": AGENT_ID_PROPERTY, **FEEDBACK_PROPERTIES}),
    "sprintengine.artifact.approve": object_schema(["statePath", "artifactId", "id"], {"artifactId": ARTIFACT_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "approvalMode": {"type": "string", "enum": ["manual", "policy"], "description": "Approval provenance: 'manual' (human) or 'policy' (run auto-approval). Optional; omit for a plain approval."}}),
    "sprintengine.artifact.request_changes": object_schema(["statePath", "artifactId", "id", "feedback"], {"artifactId": ARTIFACT_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "feedback": {"type": "string"}}),
    "sprintengine.vcs.status": object_schema(["statePath"], {}),
    "sprintengine.vcs.commit": object_schema(["statePath", "taskId", "id"], {"taskId": TASK_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "summary": {"type": "string"}, "path": {"type": "array", "items": {"type": "string"}}}),
    "sprintengine.vcs.pr": object_schema(["statePath"], {"id": AGENT_ID_PROPERTY, "base": {"type": "string"}, "title": {"type": "string"}, "body": {"type": "string"}, "draft": {"type": "boolean"}, "noPush": {"type": "boolean"}}),
    "sprintengine.run.get": object_schema(["statePath"], {}),
    "sprintengine.run.policy.get": object_schema(["statePath"], {}),
    "sprintengine.run.subscribe": object_schema(["statePath"], {"lastEventId": {"type": "string"}, "transport": {"type": "string", "enum": ["mcp_notifications", "poll"]}}),
    "sprintengine.feedback.summarize": object_schema(["statePath"], {}),
    "sprintengine.feedback.recommend_actions": object_schema(["statePath"], {}),
    "sprintengine.health": object_schema([], {"statePath": STATE_PATH_PROPERTY}),
}

TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    name: MCP_V1_CONTRACT_SCHEMAS[name]
    for name in ACTIVE_TOOL_NAMES
}


def list_tool_schemas() -> list[dict[str, Any]]:
    # Tool names are self-descriptive; the generic description stays terse
    # because this text lands in every agent context.
    return [
        {
            "name": name,
            "description": name.removeprefix("sprintengine.").replace(".", " ").replace("_", " "),
            "inputSchema": schema,
        }
        for name, schema in sorted(TOOL_SCHEMAS.items())
    ]
