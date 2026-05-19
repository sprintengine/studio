"""Typed tool schemas for the local sprintengine MCP boundary."""

from __future__ import annotations

from typing import Any


STATE_PATH_PROPERTY = {
    "type": "string",
    "description": "Path to the active Sprint Engine run.yaml file. Must resolve under an allowed root.",
}

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


TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "sprintengine.init": object_schema(["statePath"], {"goal": {"type": "string"}, "useWorktrees": {"type": "boolean"}, "agent": {"type": "array", "items": {"type": "string"}}}),
    "sprintengine.recover": object_schema(["statePath"], {}),
    "sprintengine.roster.add": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}, "actor": {"type": "string"}}),
    "sprintengine.roster.retire": object_schema(["statePath", "id", "reason"], {"id": {"type": "string"}, "reason": {"type": "string"}, "actor": {"type": "string"}}),
    "sprintengine.roster.replenish": object_schema(["statePath"], {"role": {"type": "string"}, "actor": {"type": "string"}}),
    "sprintengine.roster.list": object_schema(["statePath"], {}),
    "sprintengine.join": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.summary": object_schema(["statePath"], {}),
    "sprintengine.task.next": object_schema(["statePath", "role", "id"], {"role": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.task.claim": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.task.status": object_schema(["statePath", "taskId", "status", "id"], {"taskId": {"type": "string"}, "status": {"type": "string"}, "id": {"type": "string"}, "summary": {"type": "string"}, "needsInputKind": {"type": "string"}, "needsInputReason": {"type": "string"}, "needsInputArtifactId": {"type": "string"}, "needsInputQuestion": {"type": "string"}, "needsInputSuggestedResolution": {"type": "string"}}),
    "sprintengine.task.resolve_input": object_schema(["statePath", "taskId", "id", "resolution"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "resolution": {"type": "string"}, "complete": {"type": "boolean"}}),
    "sprintengine.task.release": object_schema(["statePath", "taskId", "id", "reason"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "reason": {"type": "string"}}),
    "sprintengine.task.ready": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "triagedBy": {"type": "string"}}),
    "sprintengine.task.log": object_schema(["statePath", "taskId", "id"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "summary": {"type": "string"}, "file": {"type": "array"}, "command": {"type": "array"}, "result": {"type": "array"}, "scopeExpansionJson": {"type": "array"}}),
    "sprintengine.task.note": object_schema(["statePath", "taskId", "id", "note"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "note": {"type": "string"}}),
    "sprintengine.task.comment": object_schema(["statePath", "taskId", "id", "body"], {"taskId": {"type": "string"}, "id": {"type": "string"}, "body": {"type": "string"}, "source": {"type": "string"}}),
    "sprintengine.task.list": object_schema(["statePath"], {"role": {"type": "string"}}),
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
    "sprintengine.artifact.ready": object_schema(["statePath", "artifactId", "id"], {"artifactId": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.artifact.approve": object_schema(["statePath", "artifactId", "id"], {"artifactId": {"type": "string"}, "id": {"type": "string"}}),
    "sprintengine.artifact.request_changes": object_schema(["statePath", "artifactId", "id", "feedback"], {"artifactId": {"type": "string"}, "id": {"type": "string"}, "feedback": {"type": "string"}}),
    "sprintengine.feedback.summarize": object_schema(["statePath"], {}),
    "sprintengine.feedback.recommend_actions": object_schema(["statePath"], {}),
    "sprintengine.health": object_schema([], {"statePath": STATE_PATH_PROPERTY}),
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
