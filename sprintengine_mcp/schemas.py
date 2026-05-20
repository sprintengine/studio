"""Typed tool schemas for the local sprintengine MCP boundary."""

from __future__ import annotations

from typing import Any


STATE_PATH_PROPERTY = {
    "type": "string",
    "description": "Path to the active Sprint Engine run.yaml file. Must resolve under an allowed root.",
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

TASK_ID_PROPERTY = {"type": "string", "description": "Sprint Engine task id, for example T3."}
GATE_ID_PROPERTY = {"type": "string", "description": "Sprint Engine quality gate id."}
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


def object_schema(required: list[str], properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "required": required,
        "additionalProperties": True,
        "properties": {"statePath": STATE_PATH_PROPERTY, **properties},
    }


MCP_V1_CONTRACT_SCHEMAS: dict[str, dict[str, Any]] = {
    "sprintengine.init": object_schema(["statePath"], {"goal": {"type": "string"}, "useWorktrees": {"type": "boolean"}, "agent": {"type": "array", "items": {"type": "string"}}}),
    "sprintengine.recover": object_schema(["statePath"], {}),
    "sprintengine.roster.add": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}, "actor": {"type": "string"}}),
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
    "sprintengine.agent.heartbeat": object_schema(["statePath", "agentId"], {"agentId": AGENT_ID_PROPERTY}),
    "sprintengine.agent.leave": object_schema(["statePath", "agentId"], {"agentId": AGENT_ID_PROPERTY, "reason": {"type": "string"}}),
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
    "sprintengine.roles.list": object_schema(["workspaceRoot"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "includeShadowed": {"type": "boolean"}}),
    "sprintengine.roles.get": object_schema(["workspaceRoot", "roleId"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "roleId": ROLE_PROPERTY}),
    "sprintengine.soul.get": object_schema(["workspaceRoot", "roleId"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "roleId": ROLE_PROPERTY, "runId": {"type": "string"}}),
    "sprintengine.skills.list": object_schema(["workspaceRoot"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "includeBody": {"type": "boolean"}}),
    "sprintengine.skill.get": object_schema(["workspaceRoot", "skillId"], {"workspaceRoot": WORKSPACE_ROOT_PROPERTY, "skillId": {"type": "string"}}),
    "sprintengine.task.get": object_schema(["statePath", "taskId"], {"taskId": TASK_ID_PROPERTY}),
    "sprintengine.task.next": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.task.claim": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.task.status": object_schema(["statePath", "taskId", "status", "id"], {"taskId": {"type": "string"}, "status": {"type": "string"}, "id": {"type": "string"}, "summary": {"type": "string"}, "needsInputKind": {"type": "string"}, "needsInputReason": {"type": "string"}, "needsInputArtifactId": {"type": "string"}, "needsInputQuestion": {"type": "string"}, "needsInputSuggestedResolution": {"type": "string"}}),
    "sprintengine.task.resolve_input": object_schema(["statePath", "taskId", "id", "resolution"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "resolution": {"type": "string"}, "complete": {"type": "boolean"}}),
    "sprintengine.task.release": object_schema(["statePath", "taskId", "id", "reason"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "reason": {"type": "string"}}),
    "sprintengine.task.ready": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "triagedBy": {"type": "string"}}),
    "sprintengine.task.log": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "summary": {"type": "string"}, "file": {"type": "array"}, "command": {"type": "array"}, "result": {"type": "array"}, "scopeExpansionJson": {"type": "array"}}),
    "sprintengine.task.note": object_schema(["statePath", "taskId", "id", "note"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "note": {"type": "string"}}),
    "sprintengine.task.comment": object_schema(["statePath", "taskId", "id", "body"], {"taskId": TASK_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "body": {"type": "string"}, "source": {"type": "string"}, "commentType": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "data": {"type": "object"}}),
    "sprintengine.task.comment.list": object_schema(["statePath", "taskId"], {"taskId": TASK_ID_PROPERTY}),
    "sprintengine.task.list": object_schema(["statePath"], {"role": ROLE_PROPERTY, "status": {"type": "string"}, "includeDone": {"type": "boolean"}}),
    "sprintengine.task.publish": object_schema(["statePath", "taskId", "id", "summary"], {"taskId": TASK_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "summary": {"type": "string"}, "path": {"type": "array", "items": {"type": "string"}}, "file": {"type": "array", "items": {"type": "string"}}, "data": {"type": "object"}, "summaryDataJson": {"type": "string"}}),
    "sprintengine.task.request_changes": object_schema(["statePath", "taskId", "id", "reason"], {"taskId": TASK_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "reason": {"type": "string"}, "source": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "needsInputKind": {"type": "string"}, "needsInputReason": {"type": "string"}, "needsInputArtifactId": {"type": "string"}, "needsInputQuestion": {"type": "string"}, "needsInputSuggestedResolution": {"type": "string"}}),
    "sprintengine.gate.list": object_schema(["statePath"], {"taskId": TASK_ID_PROPERTY, "phase": {"type": "string"}, "role": ROLE_PROPERTY}),
    "sprintengine.gate.next": object_schema(["statePath", "role", "id"], {"role": ROLE_PROPERTY, "id": AGENT_ID_PROPERTY}),
    "sprintengine.gate.claim": object_schema(["statePath", "taskId", "gateId", "role", "id"], {"taskId": TASK_ID_PROPERTY, "gateId": GATE_ID_PROPERTY, "role": ROLE_PROPERTY, "id": AGENT_ID_PROPERTY}),
    "sprintengine.gate.verdict": object_schema(["statePath", "taskId", "gateId", "role", "id", "verdict", "summary"], {"taskId": TASK_ID_PROPERTY, "gateId": GATE_ID_PROPERTY, "role": ROLE_PROPERTY, "id": AGENT_ID_PROPERTY, "verdict": {"type": "string"}, "summary": {"type": "string"}, "requiredAction": {"type": "array", "items": {"type": "string"}}, "artifactPath": {"type": "string"}, "artifactTitle": {"type": "string"}, "artifactKind": {"type": "string"}, "needsInputKind": {"type": "string"}, "needsInputReason": {"type": "string"}, "needsInputQuestion": {"type": "string"}, "needsInputSuggestedResolution": {"type": "string"}}),
    "sprintengine.gate.publish": object_schema(["statePath", "taskId", "gateId", "role", "id", "verdict", "summary"], {"taskId": TASK_ID_PROPERTY, "gateId": GATE_ID_PROPERTY, "role": ROLE_PROPERTY, "id": AGENT_ID_PROPERTY, "verdict": {"type": "string"}, "summary": {"type": "string"}, "requiredAction": {"type": "array", "items": {"type": "string"}}, "artifactPath": {"type": "string"}, "artifactTitle": {"type": "string"}, "artifactKind": {"type": "string"}}),
    "sprintengine.gate.skip": object_schema(["statePath", "taskId", "gateId", "role", "id", "rationale"], {"taskId": TASK_ID_PROPERTY, "gateId": GATE_ID_PROPERTY, "role": ROLE_PROPERTY, "id": AGENT_ID_PROPERTY, "rationale": {"type": "string"}}),
    "sprintengine.plan.add_task": object_schema(["statePath", "title", "role"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "title": {"type": "string"}, "description": {"type": "string"}, "role": {"type": "string"}, "dependsOn": {"type": "array"}, "path": {"type": "array"}, "acceptance": {"type": "array"}, "note": {"type": "array"}, "taskNote": {"type": "array"}, "producesImplementation": {"type": "boolean"}, "noQualityGates": {"type": "boolean"}, "noReview": {"type": "boolean"}, "noTesting": {"type": "boolean"}, "productFacing": {"type": "boolean"}, "notProductFacing": {"type": "boolean"}, "noProductAcceptance": {"type": "boolean"}, "requireGate": {"type": "array"}, "skipGate": {"type": "array"}, "manualDispatch": {"type": "boolean"}, "dispatchStatus": {"type": "string"}, "triagedBy": {"type": "string"}}),
    "sprintengine.plan.update_task": object_schema(["statePath", "taskId"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "title": {"type": "string"}, "description": {"type": "string"}, "role": {"type": "string"}, "path": {"type": "array"}, "acceptance": {"type": "array"}, "note": {"type": "array"}, "taskNote": {"type": "array"}, "clearTaskNotes": {"type": "boolean"}, "producesImplementation": {"type": "boolean"}, "noQualityGates": {"type": "boolean"}, "noReview": {"type": "boolean"}, "noTesting": {"type": "boolean"}, "productFacing": {"type": "boolean"}, "notProductFacing": {"type": "boolean"}, "noProductAcceptance": {"type": "boolean"}, "requireGate": {"type": "array"}, "skipGate": {"type": "array"}}),
    "sprintengine.plan.delete_task": object_schema(["statePath", "taskId"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "unlinkDependents": {"type": "boolean"}}),
    "sprintengine.plan.add_dependency": object_schema(["statePath", "taskId", "dependsOn"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "dependsOn": {"type": "array"}}),
    "sprintengine.plan.remove_dependency": object_schema(["statePath", "taskId", "dependsOn"], {"actor": {"type": "string"}, "taskId": {"type": "string"}, "dependsOn": {"type": "array"}}),
    "sprintengine.plan.start_review": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.plan.review_status": object_schema(["statePath"], {}),
    "sprintengine.plan.address_reviews": object_schema(["statePath"], {"actor": {"type": "string"}}),
    "sprintengine.artifact.add": object_schema(["statePath", "taskId", "kind", "title", "path"], {"actor": {"type": "string"}, "artifactId": {"type": "string"}, "taskId": {"type": "string"}, "kind": {"type": "string"}, "title": {"type": "string"}, "path": {"type": "string"}, "createdBy": {"type": "string"}, "recommendedTask": {"type": "array"}, "ready": {"type": "boolean"}}),
    "sprintengine.artifact.list": object_schema(["statePath"], {"taskId": {"type": "string"}, "kind": {"type": "string"}, "status": {"type": "string"}}),
    "sprintengine.artifact.ready": object_schema(["statePath", "artifactId", "id"], {"artifactId": ARTIFACT_ID_PROPERTY, "id": AGENT_ID_PROPERTY}),
    "sprintengine.artifact.approve": object_schema(["statePath", "artifactId", "id"], {"artifactId": ARTIFACT_ID_PROPERTY, "id": AGENT_ID_PROPERTY}),
    "sprintengine.artifact.request_changes": object_schema(["statePath", "artifactId", "id", "feedback"], {"artifactId": ARTIFACT_ID_PROPERTY, "id": AGENT_ID_PROPERTY, "feedback": {"type": "string"}}),
    "sprintengine.run.get": object_schema(["statePath"], {}),
    "sprintengine.run.policy.get": object_schema(["statePath"], {}),
    "sprintengine.run.projection": object_schema(["statePath"], {}),
    "sprintengine.run.subscribe": object_schema(["statePath"], {"lastEventId": {"type": "string"}, "transport": {"type": "string", "enum": ["mcp_notifications", "poll"]}}),
    "sprintengine.feedback.summarize": object_schema(["statePath"], {}),
    "sprintengine.feedback.recommend_actions": object_schema(["statePath"], {}),
    "sprintengine.health": object_schema([], {"statePath": STATE_PATH_PROPERTY}),
}

ACTIVE_TOOL_NAMES = {
    "sprintengine.init",
    "sprintengine.recover",
    "sprintengine.roster.add",
    "sprintengine.roster.retire",
    "sprintengine.roster.replenish",
    "sprintengine.roster.list",
    "sprintengine.agent.join",
    "sprintengine.agent.heartbeat",
    "sprintengine.agent.leave",
    "sprintengine.subscribe",
    "sprintengine.join",
    "sprintengine.summary",
    "sprintengine.dispatch.next",
    "sprintengine.dispatch.ack",
    "sprintengine.roles.list",
    "sprintengine.roles.get",
    "sprintengine.soul.get",
    "sprintengine.skills.list",
    "sprintengine.skill.get",
    "sprintengine.task.get",
    "sprintengine.task.next",
    "sprintengine.task.claim",
    "sprintengine.task.status",
    "sprintengine.task.resolve_input",
    "sprintengine.task.release",
    "sprintengine.task.ready",
    "sprintengine.task.log",
    "sprintengine.task.publish",
    "sprintengine.task.note",
    "sprintengine.task.comment",
    "sprintengine.task.comment.list",
    "sprintengine.task.list",
    "sprintengine.task.request_changes",
    "sprintengine.gate.list",
    "sprintengine.gate.next",
    "sprintengine.gate.claim",
    "sprintengine.gate.verdict",
    "sprintengine.gate.publish",
    "sprintengine.gate.skip",
    "sprintengine.plan.add_task",
    "sprintengine.plan.update_task",
    "sprintengine.plan.delete_task",
    "sprintengine.plan.add_dependency",
    "sprintengine.plan.remove_dependency",
    "sprintengine.plan.start_review",
    "sprintengine.plan.review_status",
    "sprintengine.plan.address_reviews",
    "sprintengine.artifact.add",
    "sprintengine.artifact.list",
    "sprintengine.artifact.ready",
    "sprintengine.artifact.approve",
    "sprintengine.artifact.request_changes",
    "sprintengine.run.get",
    "sprintengine.run.policy.get",
    "sprintengine.run.projection",
    "sprintengine.run.subscribe",
    "sprintengine.feedback.summarize",
    "sprintengine.feedback.recommend_actions",
    "sprintengine.health",
}

TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    name: MCP_V1_CONTRACT_SCHEMAS[name]
    for name in ACTIVE_TOOL_NAMES
}


def list_tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": f"Local sprintengine operation {name}.",
            "inputSchema": schema,
        }
        for name, schema in sorted(TOOL_SCHEMAS.items())
    ]
