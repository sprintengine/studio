"""Standalone local-first MCP boundary for the Sprint Engine coordination core."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from sprintengine_core.analysis import analyze_feedback_metrics
from sprintengine_core.audit import record_audit_event
from sprintengine_core.health import build_health_report
from sprintengine_core import store as folder_store
from sprintengine_core.role_registry import (
    RegistryDiscovery,
    RegistryEntry,
    RegistryWarning,
    RoleManifest,
    SkillDocument,
    SoulRenderError,
    discover_role_registry,
    normalize_role_id,
)
from sprintengine_core.tool import (
    FEEDBACK_SCORE_FIELDS,
    cmd_artifact_add,
    cmd_artifact_approve,
    cmd_artifact_list,
    cmd_artifact_ready,
    cmd_artifact_request_changes,
    cmd_init,
    cmd_join,
    cmd_plan_add_dependency,
    cmd_plan_add_task,
    cmd_plan_address_reviews,
    cmd_plan_delete_task,
    cmd_plan_list,
    cmd_plan_remove_dependency,
    cmd_plan_review_status,
    cmd_plan_start_review,
    cmd_plan_update_task,
    cmd_recover,
    cmd_roster_add,
    cmd_roster_list,
    cmd_roster_replenish,
    cmd_roster_retire,
    cmd_summary,
    cmd_task_claim,
    cmd_task_comment_list,
    cmd_task_gate_claim,
    cmd_task_gate_list,
    cmd_task_gate_next,
    cmd_task_gate_verdict,
    cmd_task_list,
    cmd_task_log,
    cmd_task_next,
    cmd_task_note,
    cmd_task_publish,
    cmd_task_comment,
    cmd_task_ready,
    cmd_task_release,
    cmd_task_resolve_input,
    cmd_task_status,
    cmd_projection,
    load_mutation_state,
)
from sprintengine_core.tool.artifacts import release_task_from_owner
from sprintengine_core.tool.gates import find_active_gate_claim
from sprintengine_core.tool.prompts import compose_prompt, generic_role_swarm_prompt
from sprintengine_core.tool.state import (
    append_event,
    append_task_activity,
    ensure_agent,
    record_agent_heartbeat,
    record_agent_join,
    record_agent_leave,
    set_agent_idle,
    with_locked_state,
)

from .auth import MUTATING_TOOLS, ActorContext, AuthorizationError, authorize_tool
from .schemas import TOOL_SCHEMAS, list_tool_schemas


class McpToolError(Exception):
    """Structured MCP boundary error."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        error = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return error


class SprintEngineMcpServer:
    """Dependency-free local MCP tool dispatcher over Sprint Engine handlers."""

    def __init__(
        self,
        allowed_roots: list[str | Path] | None = None,
        stdio_actor: ActorContext | dict[str, Any] | None = None,
    ):
        self.allowed_roots = [Path(root).expanduser().resolve() for root in (allowed_roots or [])]
        self.stdio_actor = self._actor(stdio_actor)

    def list_tools(self) -> list[dict[str, Any]]:
        return list_tool_schemas()

    def call_tool(
        self,
        tool_name: str,
        payload: dict[str, Any] | None = None,
        actor: ActorContext | dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        start = time.monotonic()
        payload = payload or {}
        actor_context: ActorContext | None = None
        state_path: Path | None = None
        try:
            actor_context = self._actor(actor)
            if tool_name not in TOOL_SCHEMAS:
                raise McpToolError("unknown_tool", f"Unknown sprintengine MCP tool: {tool_name}")
            if not isinstance(payload, dict):
                raise McpToolError("invalid_payload", "Tool payload must be an object.")
            state_path = self._state_path(payload, required=_tool_requires_state_path(tool_name))
            authorize_tool(tool_name, payload, actor_context, state_path)
            if tool_name == "sprintengine.health":
                result = build_health_report(
                    state_path=state_path,
                    allowed_root=self.allowed_roots[0] if self.allowed_roots else None,
                    backend_mode="mcp-local",
                )
            else:
                if _tool_requires_state_path(tool_name):
                    assert state_path is not None
                result = self._dispatch(tool_name, state_path, payload, actor_context)
            self._audit(tool_name, state_path, actor_context, payload, start, "success", None)
            return {"ok": True, "tool": tool_name, "result": result}
        except McpToolError as exc:
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", exc)
            return {"ok": False, "tool": tool_name, "error": exc.to_dict()}
        except AuthorizationError as exc:
            mapped = McpToolError("unauthorized", str(exc))
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", mapped)
            return {"ok": False, "tool": tool_name, "error": mapped.to_dict()}
        except SystemExit as exc:
            mapped = McpToolError("core_error", _system_exit_message(exc))
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", mapped)
            return {"ok": False, "tool": tool_name, "error": mapped.to_dict()}
        except Exception as exc:
            mapped = McpToolError("internal_error", "SprintEngine MCP operation failed.", {"errorClass": exc.__class__.__name__})
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", mapped)
            return {"ok": False, "tool": tool_name, "error": mapped.to_dict()}

    def _dispatch(
        self,
        tool_name: str,
        state_path: Path | None,
        payload: dict[str, Any],
        actor: ActorContext | None,
    ) -> dict[str, Any]:
        handlers: dict[str, Callable[[Any], dict[str, Any]]] = {
            "sprintengine.init": cmd_init,
            "sprintengine.recover": cmd_recover,
            "sprintengine.roster.add": cmd_roster_add,
            "sprintengine.roster.retire": cmd_roster_retire,
            "sprintengine.roster.replenish": cmd_roster_replenish,
            "sprintengine.roster.list": cmd_roster_list,
            "sprintengine.join": cmd_join,
            "sprintengine.summary": cmd_summary,
            "sprintengine.run.projection": cmd_projection,
            "sprintengine.task.next": cmd_task_next,
            "sprintengine.task.claim": cmd_task_claim,
            "sprintengine.task.status": cmd_task_status,
            "sprintengine.task.resolve_input": cmd_task_resolve_input,
            "sprintengine.task.release": cmd_task_release,
            "sprintengine.task.ready": cmd_task_ready,
            "sprintengine.task.log": cmd_task_log,
            "sprintengine.task.publish": cmd_task_publish,
            "sprintengine.task.note": cmd_task_note,
            "sprintengine.task.comment": cmd_task_comment,
            "sprintengine.task.comment.list": cmd_task_comment_list,
            "sprintengine.task.list": cmd_task_list,
            "sprintengine.gate.list": cmd_task_gate_list,
            "sprintengine.gate.next": cmd_task_gate_next,
            "sprintengine.gate.claim": cmd_task_gate_claim,
            "sprintengine.gate.verdict": cmd_task_gate_verdict,
            "sprintengine.gate.publish": cmd_task_gate_verdict,
            "sprintengine.plan.add_task": cmd_plan_add_task,
            "sprintengine.plan.update_task": cmd_plan_update_task,
            "sprintengine.plan.delete_task": cmd_plan_delete_task,
            "sprintengine.plan.add_dependency": cmd_plan_add_dependency,
            "sprintengine.plan.remove_dependency": cmd_plan_remove_dependency,
            "sprintengine.plan.start_review": cmd_plan_start_review,
            "sprintengine.plan.review_status": cmd_plan_review_status,
            "sprintengine.plan.address_reviews": cmd_plan_address_reviews,
            "sprintengine.artifact.add": cmd_artifact_add,
            "sprintengine.artifact.list": cmd_artifact_list,
            "sprintengine.artifact.ready": cmd_artifact_ready,
            "sprintengine.artifact.approve": cmd_artifact_approve,
            "sprintengine.artifact.request_changes": cmd_artifact_request_changes,
        }
        if tool_name == "sprintengine.agent.join":
            assert state_path is not None
            return self._agent_join(state_path, payload)
        if tool_name == "sprintengine.agent.heartbeat":
            assert state_path is not None
            return self._agent_heartbeat(state_path, payload)
        if tool_name == "sprintengine.agent.leave":
            assert state_path is not None
            return self._agent_leave(state_path, payload)
        if tool_name == "sprintengine.dispatch.next":
            assert state_path is not None
            return self._dispatch_next(state_path, payload)
        if tool_name == "sprintengine.dispatch.ack":
            assert state_path is not None
            return self._dispatch_ack(state_path, payload)
        if tool_name == "sprintengine.subscribe":
            assert state_path is not None
            return self._subscribe(state_path, payload)
        if tool_name == "sprintengine.run.get":
            assert state_path is not None
            return self._run_get(state_path)
        if tool_name == "sprintengine.run.policy.get":
            assert state_path is not None
            return self._run_policy_get(state_path)
        if tool_name == "sprintengine.run.subscribe":
            assert state_path is not None
            return self._run_subscribe(state_path, payload)
        if tool_name == "sprintengine.task.get":
            assert state_path is not None
            return self._task_get(state_path, payload)
        if tool_name == "sprintengine.task.request_changes":
            assert state_path is not None
            return self._task_request_changes(state_path, payload, actor)
        if tool_name == "sprintengine.gate.skip":
            payload = {**payload, "verdict": "skipped", "summary": payload["rationale"]}
            tool_name = "sprintengine.gate.verdict"
        if tool_name in {
            "sprintengine.roles.list",
            "sprintengine.roles.get",
            "sprintengine.soul.get",
            "sprintengine.skills.list",
            "sprintengine.skill.get",
        }:
            return self._registry_tool(tool_name, payload)
        if tool_name == "sprintengine.feedback.summarize":
            assert state_path is not None
            state = load_mutation_state(state_path)
            return {"ok": True, "summary": analyze_feedback_metrics(state_path.parent, state)["summary"]}
        if tool_name == "sprintengine.feedback.recommend_actions":
            assert state_path is not None
            state = load_mutation_state(state_path)
            return {"ok": True, "recommendations": analyze_feedback_metrics(state_path.parent, state)["recommendations"]}
        assert state_path is not None
        handler = handlers[tool_name]
        args = self._namespace(tool_name, state_path, payload, actor)
        result = handler(args)
        return self._with_progress_context(tool_name, result)

    def _agent_join(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        workspace_root = self._workspace_root(payload, required=False) or _default_workspace_root(state_path)
        registry = discover_role_registry(workspace_root=workspace_root)
        try:
            role_entry = registry.role_entry(str(payload["role"]))
        except KeyError as exc:
            raise McpToolError("unknown_role", str(exc)) from exc
        role_manifest = role_entry.value
        if not isinstance(role_manifest, RoleManifest):
            raise McpToolError("unknown_role", f"Unknown registry role: {payload['role']}")
        role = role_manifest.normalized_id
        agent_id = str(payload["agentId"]).strip()
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")
        subscription_mode = str(payload.get("subscriptionMode") or ("mcp_notifications" if payload.get("subscribe") else "none"))
        if subscription_mode not in {"none", "poll", "mcp_notifications"}:
            raise McpToolError("invalid_payload", "subscriptionMode must be one of none, poll, or mcp_notifications.")

        legacy_payload = _legacy_join_payload(state_path, role, agent_id)

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            agent = record_agent_join(state, agent_id, role, subscription_mode=subscription_mode)
            run = state.get("sprintengine", {})
            return {
                "ok": True,
                "agent": agent,
                "run": _run_metadata(run, state_path),
                "write": True,
            }

        lifecycle = with_locked_state(state_path, mutate)
        role_payload = _role_payload(role_entry)
        prompt = _compose_registry_prompt(registry, role, workspace_root, str(lifecycle["run"].get("name") or ""))
        return {
            "ok": True,
            "agentId": agent_id,
            "role": role,
            "agent": lifecycle["agent"],
            "currentDispatch": lifecycle["agent"].get("currentDispatch"),
            "run": lifecycle["run"],
            "roleManifest": role_payload,
            "prompt": prompt,
            "promptContext": {
                "format": "composed_soul_coordination_prompt",
                "role": role,
                "length": len(prompt),
            },
            "legacyJoin": legacy_payload,
        }

    def _agent_heartbeat(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            before = dict(state.get("agents", {}).get(agent_id) or {})
            agent = record_agent_heartbeat(state, agent_id, before.get("role"))
            return {
                "ok": True,
                "agent": agent,
                "previous": {
                    "status": before.get("status"),
                    "currentTaskId": before.get("currentTaskId"),
                    "currentGateId": before.get("currentGateId"),
                    "currentDispatch": before.get("currentDispatch"),
                },
                "write": True,
            }

        result = with_locked_state(state_path, mutate)
        return {
            "ok": True,
            "agent": result["agent"],
            "currentDispatch": result["agent"].get("currentDispatch"),
            "assignmentUnchanged": {
                "status": result["agent"].get("status") == result["previous"].get("status"),
                "currentTaskId": result["agent"].get("currentTaskId") == result["previous"].get("currentTaskId"),
                "currentGateId": result["agent"].get("currentGateId") == result["previous"].get("currentGateId"),
                "currentDispatch": result["agent"].get("currentDispatch") == result["previous"].get("currentDispatch"),
            },
        }

    def _agent_leave(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")
        reason = str(payload.get("reason") or "agent left")

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            agent = state.get("agents", {}).get(agent_id)
            role = agent.get("role") if isinstance(agent, dict) else None
            released: list[dict[str, Any]] = []
            current_task_id = str(agent.get("currentTaskId") or "") if isinstance(agent, dict) else ""
            if current_task_id:
                for task in state.get("tasks", []) or []:
                    if not isinstance(task, dict) or str(task.get("id") or "") != current_task_id:
                        continue
                    if task.get("ownerAgentId") == agent_id:
                        release = release_task_from_owner(state, task, agent_id, reason)
                        released.append({"kind": "task", "taskId": task.get("id"), **release})
                    break
            active_gate = find_active_gate_claim(state, agent_id, str(role or ""))
            if active_gate:
                gate = active_gate["gate"]
                attempt = active_gate["attempt"]
                attempt["status"] = "released"
                attempt["completedAt"] = folder_store.now_iso()
                gate["status"] = "pending"
                task = active_gate["task"]
                append_task_activity(
                    task,
                    "gate_release",
                    agent_id,
                    f"Gate {gate.get('id')} released by {agent_id}: {reason}",
                    {"gateId": gate.get("id"), "attemptId": attempt.get("id")},
                )
                released.append({"kind": "gate", "taskId": task.get("id"), "gateId": gate.get("id"), "attemptId": attempt.get("id")})
            left = record_agent_leave(state, agent_id, role, reason=reason)
            event = append_event(
                state,
                "agent_left",
                agent_id,
                f"{agent_id} left Sprint Engine. Released targets: {len(released)}.",
                {"releasedTargets": released, "reason": reason},
            )
            set_agent_idle(left)
            left["status"] = "left"
            return {"ok": True, "agent": left, "releasedTargets": released, "event": event, "write": True}

        result = with_locked_state(state_path, mutate)
        return {
            "ok": True,
            "agent": result["agent"],
            "releasedTargets": result["releasedTargets"],
            "event": result["event"],
        }

    def _dispatch_next(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        last_dispatch_id = str(payload.get("lastDispatchId") or "").strip()
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")

        def run(state: dict[str, Any]) -> dict[str, Any]:
            agent = state.get("agents", {}).get(agent_id)
            current = agent.get("currentDispatch") if isinstance(agent, dict) else None
            dispatches = [
                record for record in folder_store.read_jsonl_file(state_path.parent / folder_store.DISPATCH_FILE)
                if record.get("agentId") == agent_id
            ]
            if last_dispatch_id:
                seen = False
                filtered = []
                for record in dispatches:
                    if seen:
                        filtered.append(record)
                    elif record.get("id") == last_dispatch_id:
                        seen = True
                dispatches = filtered
            return {
                "ok": True,
                "agentId": agent_id,
                "currentDispatch": current,
                "dispatches": dispatches,
                "state": "dispatched" if current else "idle",
                "write": False,
            }

        return with_locked_state(state_path, run)

    def _dispatch_ack(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        dispatch_id = str(payload["dispatchId"]).strip()
        outcome = str(payload.get("outcome") or "acknowledged").strip() or "acknowledged"
        if not agent_id or not dispatch_id:
            raise McpToolError("invalid_payload", "agentId and dispatchId cannot be empty.")

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            agent = ensure_agent(state, agent_id, None)
            subscription = agent.setdefault("subscription", {})
            subscription["lastDispatchId"] = dispatch_id
            subscription["lastDispatchAckAt"] = folder_store.now_iso()
            subscription["lastDispatchOutcome"] = outcome
            event = append_event(
                state,
                "dispatch_acknowledged",
                agent_id,
                f"{agent_id} acknowledged dispatch {dispatch_id}.",
                {"dispatchId": dispatch_id, "outcome": outcome},
            )
            return {"ok": True, "agent": agent, "currentDispatch": agent.get("currentDispatch"), "event": event, "write": True}

        return with_locked_state(state_path, mutate)

    def _subscribe(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        transport = str(payload.get("transport") or "poll")
        if transport not in {"poll", "mcp_notifications"}:
            raise McpToolError("invalid_payload", "transport must be one of poll or mcp_notifications.")
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            agent = ensure_agent(state, agent_id, None)
            subscription = agent.setdefault("subscription", {})
            subscription["mode"] = transport
            if payload.get("lastDispatchId"):
                subscription["lastDispatchId"] = str(payload["lastDispatchId"])
            subscription.setdefault("subscribedAt", folder_store.now_iso())
            return {"ok": True, "agent": agent, "subscription": subscription, "currentDispatch": agent.get("currentDispatch"), "write": True}

        return with_locked_state(state_path, mutate)

    def _run_get(self, state_path: Path) -> dict[str, Any]:
        def run(state: dict[str, Any]) -> dict[str, Any]:
            return {
                "ok": True,
                "run": _run_metadata(state.get("sprintengine", {}), state_path),
                "runner": folder_store.normalize_runner_policy(state.get("runner")),
                "write": False,
            }

        return with_locked_state(state_path, run)

    def _run_policy_get(self, state_path: Path) -> dict[str, Any]:
        def run(state: dict[str, Any]) -> dict[str, Any]:
            return {"ok": True, "runner": folder_store.normalize_runner_policy(state.get("runner")), "write": False}

        return with_locked_state(state_path, run)

    def _run_subscribe(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        last_event_id = str(payload.get("lastEventId") or "").strip()

        def run(state: dict[str, Any]) -> dict[str, Any]:
            events = [event for event in state.get("events", []) if isinstance(event, dict)]
            if last_event_id:
                seen = False
                filtered = []
                for event in events:
                    if seen:
                        filtered.append(event)
                    elif event.get("id") == last_event_id:
                        seen = True
                events = filtered
            return {"ok": True, "events": events, "state": "events_available" if events else "idle", "write": False}

        return with_locked_state(state_path, run)

    def _task_get(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        task_id = str(payload["taskId"])

        def run(state: dict[str, Any]) -> dict[str, Any]:
            task = next((candidate for candidate in state.get("tasks", []) if isinstance(candidate, dict) and candidate.get("id") == task_id), None)
            if task is None:
                raise McpToolError("not_found", f"Task not found: {task_id}")
            return {"ok": True, "task": task, "write": False}

        return with_locked_state(state_path, run)

    def _task_request_changes(self, state_path: Path, payload: dict[str, Any], actor: ActorContext | None) -> dict[str, Any]:
        args = SimpleNamespace(
            state=state_path,
            task_id=payload["taskId"],
            id=payload.get("id") or (actor.id if actor else "mcp"),
            body=payload["reason"],
            source=payload.get("source") or "user",
            comment_type="review_feedback",
            path=list(payload.get("paths") or []),
            data_json=json.dumps({"status": "open", "reason": payload["reason"]}),
        )
        comment_result = cmd_task_comment(args)
        status_args = SimpleNamespace(
            state=state_path,
            task_id=payload["taskId"],
            status="needs_input",
            id=args.id,
            summary=payload["reason"],
            needs_input_kind=payload.get("needsInputKind") or "owner",
            needs_input_reason=payload.get("needsInputReason") or "blocked_other",
            needs_input_artifact_id=payload.get("needsInputArtifactId"),
            needs_input_question=payload.get("needsInputQuestion") or payload["reason"],
            needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
        )
        _add_feedback_defaults(status_args.__dict__, payload)
        status_result = cmd_task_status(status_args)
        return {"ok": True, "comment": comment_result["comment"], "task": status_result["task"], "event": status_result["event"]}

    def _registry_tool(self, tool_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        workspace_root = self._workspace_root(payload, required=True)
        assert workspace_root is not None
        registry = discover_role_registry(workspace_root=workspace_root)
        if tool_name == "sprintengine.roles.list":
            include_shadowed = bool(payload.get("includeShadowed", False))
            roles = [_role_payload(entry, include_shadowed=include_shadowed) for _, entry in sorted(registry.roles.items())]
            return {"ok": True, "roles": roles, "aliases": dict(sorted(registry.aliases.items())), "warnings": _warning_payloads(registry.warnings)}
        if tool_name == "sprintengine.roles.get":
            entry = registry.role_entry(str(payload["roleId"]))
            return {"ok": True, "role": _role_payload(entry, include_shadowed=True), "warnings": _warning_payloads(registry.warnings)}
        if tool_name == "sprintengine.soul.get":
            run_id = str(payload.get("runId") or "")
            try:
                rendered = registry.render_soul(str(payload["roleId"]), workspace_root=workspace_root, run_id=run_id)
            except SoulRenderError as exc:
                raise McpToolError("soul_render_failed", str(exc), {"warnings": _warning_payloads(exc.warnings)}) from exc
            return {
                "ok": True,
                "role": _role_manifest_payload(rendered.role),
                "soul": {"content": rendered.content, "contentLength": len(rendered.content)},
                "warnings": _warning_payloads(rendered.warnings),
            }
        if tool_name == "sprintengine.skills.list":
            include_body = bool(payload.get("includeBody", False))
            skills = [_skill_payload(entry, include_body=include_body) for _, entry in sorted(registry.skills.items())]
            return {"ok": True, "skills": skills, "warnings": _warning_payloads(registry.warnings)}
        if tool_name == "sprintengine.skill.get":
            skill_id = normalize_role_id(str(payload["skillId"]))
            entry = registry.skills.get(skill_id)
            if entry is None or not isinstance(entry.value, SkillDocument):
                raise McpToolError("unknown_skill", f"Unknown registry skill: {payload['skillId']}")
            return {"ok": True, "skill": _skill_payload(entry, include_body=True), "warnings": _warning_payloads(registry.warnings)}
        raise McpToolError("unknown_tool", f"Unknown registry tool: {tool_name}")

    def _namespace(
        self,
        tool_name: str,
        state_path: Path,
        payload: dict[str, Any],
        actor: ActorContext | None,
    ) -> SimpleNamespace:
        base: dict[str, Any] = {"state": state_path}
        if tool_name == "sprintengine.init":
            base["goal"] = payload.get("goal")
            base["use_worktrees"] = bool(payload.get("useWorktrees", False))
            base["agent"] = list(payload.get("agent") or [])
        elif tool_name == "sprintengine.join":
            base.update(
                role=payload["role"],
                id=payload["id"],
                watch=bool(payload.get("watch", False)),
                max_wait_seconds=payload.get("maxWaitSeconds"),
            )
        elif tool_name == "sprintengine.roster.add":
            base.update(role=payload["role"], id=payload["id"], actor=payload.get("actor") or (actor.id if actor else "architect"))
        elif tool_name == "sprintengine.roster.retire":
            base.update(id=payload["id"], reason=payload["reason"], actor=payload.get("actor") or (actor.id if actor else payload["id"]))
        elif tool_name == "sprintengine.roster.replenish":
            base.update(role=payload.get("role"), actor=payload.get("actor") or (actor.id if actor else "runner"))
        elif tool_name == "sprintengine.roster.list":
            pass
        elif tool_name == "sprintengine.task.next":
            base.update(role=payload["role"], id=payload["id"])
        elif tool_name == "sprintengine.task.claim":
            base.update(task_id=payload["taskId"], id=payload["id"])
        elif tool_name == "sprintengine.task.status":
            base.update(task_id=payload["taskId"], status=payload["status"], id=payload["id"], summary=payload.get("summary"))
            base.update(
                needs_input_kind=payload.get("needsInputKind"),
                needs_input_reason=payload.get("needsInputReason"),
                needs_input_artifact_id=payload.get("needsInputArtifactId"),
                needs_input_question=payload.get("needsInputQuestion"),
                needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
            )
            _add_feedback_defaults(base, payload)
        elif tool_name == "sprintengine.task.resolve_input":
            base.update(task_id=payload["taskId"], id=payload["id"], resolution=payload["resolution"], complete=bool(payload.get("complete", False)))
        elif tool_name == "sprintengine.task.release":
            base.update(task_id=payload["taskId"], id=payload["id"], reason=payload["reason"])
        elif tool_name == "sprintengine.task.ready":
            base.update(task_id=payload["taskId"], id=payload["id"], triaged_by=payload.get("triagedBy") or "user")
        elif tool_name == "sprintengine.task.log":
            base.update(
                task_id=payload["taskId"],
                id=payload["id"],
                summary=payload.get("summary"),
                file=list(payload.get("file") or []),
                command=list(payload.get("command") or []),
                result=list(payload.get("result") or []),
                scope_expansion_json=list(payload.get("scopeExpansionJson") or payload.get("scopeExpansion") or []),
            )
        elif tool_name == "sprintengine.task.publish":
            base.update(
                task_id=payload["taskId"],
                id=payload["id"],
                summary=payload["summary"],
                path=list(payload.get("path") or payload.get("file") or []),
                summary_data_json=json.dumps(payload.get("data")) if isinstance(payload.get("data"), dict) else payload.get("summaryDataJson"),
            )
        elif tool_name == "sprintengine.task.note":
            base.update(task_id=payload["taskId"], id=payload["id"], note=payload["note"])
        elif tool_name == "sprintengine.task.comment":
            base.update(
                task_id=payload["taskId"],
                id=payload["id"],
                body=payload["body"],
                source=payload.get("source") or "user",
                comment_type=payload.get("commentType"),
                path=list(payload.get("paths") or payload.get("path") or []),
                data_json=json.dumps(payload.get("data")) if isinstance(payload.get("data"), dict) else payload.get("dataJson"),
            )
        elif tool_name == "sprintengine.task.comment.list":
            base.update(task_id=payload["taskId"])
        elif tool_name == "sprintengine.task.list":
            base["role"] = payload.get("role")
        elif tool_name == "sprintengine.gate.list":
            base.update(task_id=payload.get("taskId"), role=payload.get("role"))
        elif tool_name == "sprintengine.gate.next":
            base.update(role=payload["role"], id=payload["id"])
        elif tool_name == "sprintengine.gate.claim":
            base.update(task_id=payload["taskId"], gate_id=payload["gateId"], role=payload["role"], id=payload["id"])
        elif tool_name in {"sprintengine.gate.verdict", "sprintengine.gate.publish"}:
            base.update(
                task_id=payload["taskId"],
                gate_id=payload["gateId"],
                role=payload["role"],
                id=payload["id"],
                verdict=payload["verdict"],
                summary=payload["summary"],
                required_action=list(payload.get("requiredAction") or []),
                artifact_path=payload.get("artifactPath"),
                artifact_title=payload.get("artifactTitle"),
                artifact_kind=payload.get("artifactKind"),
                needs_input_kind=payload.get("needsInputKind"),
                needs_input_reason=payload.get("needsInputReason"),
                needs_input_question=payload.get("needsInputQuestion"),
                needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
            )
            _add_feedback_defaults(base, payload)
        elif tool_name == "sprintengine.plan.add_task":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload.get("taskId"),
                title=payload["title"],
                description=payload.get("description", ""),
                role=payload["role"],
                depends_on=list(payload.get("dependsOn") or []),
                path=list(payload.get("path") or []),
                acceptance=list(payload.get("acceptance") or []),
                note=list(payload.get("note") or []),
                task_note=list(payload.get("taskNote") or []),
                produces_implementation=bool(payload.get("producesImplementation", False)),
                needs_triage=bool(payload.get("needsTriage", False)),
                no_quality_gates=bool(payload.get("noQualityGates", False)),
                no_review=bool(payload.get("noReview", False)),
                no_testing=bool(payload.get("noTesting", False)),
                product_facing=bool(payload.get("productFacing", False)),
                not_product_facing=bool(payload.get("notProductFacing", False)),
                no_product_acceptance=bool(payload.get("noProductAcceptance", False)),
                require_gate=list(payload.get("requireGate") or []),
                skip_gate=list(payload.get("skipGate") or []),
                manual_dispatch=bool(payload.get("manualDispatch", False)),
                dispatch_status=payload.get("dispatchStatus") or "todo",
                triaged_by=payload.get("triagedBy") or "none",
            )
        elif tool_name == "sprintengine.plan.update_task":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload["taskId"],
                title=payload.get("title"),
                description=payload.get("description"),
                clear_description=bool(payload.get("clearDescription", False)),
                role=payload.get("role"),
                path=payload.get("path"),
                clear_paths=bool(payload.get("clearPaths", False)),
                acceptance=payload.get("acceptance"),
                clear_acceptance=bool(payload.get("clearAcceptance", False)),
                note=payload.get("note"),
                clear_notes=bool(payload.get("clearNotes", False)),
                task_note=payload.get("taskNote"),
                clear_task_notes=bool(payload.get("clearTaskNotes", False)),
                produces_implementation=bool(payload.get("producesImplementation", False)),
                needs_triage=payload.get("needsTriage") if "needsTriage" in payload else None,
                clear_needs_triage=bool(payload.get("clearNeedsTriage", False)),
                no_quality_gates=bool(payload.get("noQualityGates", False)),
                no_review=bool(payload.get("noReview", False)),
                no_testing=bool(payload.get("noTesting", False)),
                product_facing=bool(payload.get("productFacing", False)),
                not_product_facing=bool(payload.get("notProductFacing", False)),
                no_product_acceptance=bool(payload.get("noProductAcceptance", False)),
                require_gate=list(payload.get("requireGate") or []),
                skip_gate=list(payload.get("skipGate") or []),
                force=bool(payload.get("force", False)),
            )
        elif tool_name == "sprintengine.plan.delete_task":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload["taskId"],
                unlink_dependents=bool(payload.get("unlinkDependents", False)),
                force=bool(payload.get("force", False)),
            )
        elif tool_name in {"sprintengine.plan.add_dependency", "sprintengine.plan.remove_dependency"}:
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload["taskId"],
                depends_on=list(payload.get("dependsOn") or []),
                force=bool(payload.get("force", False)),
            )
        elif tool_name == "sprintengine.plan.start_review":
            base.update(role=payload["role"], id=payload["id"])
        elif tool_name == "sprintengine.plan.address_reviews":
            base["actor"] = payload.get("actor") or (actor.id if actor else "architect")
        elif tool_name == "sprintengine.artifact.add":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "agent"),
                artifact_id=payload.get("artifactId"),
                task_id=payload["taskId"],
                kind=payload["kind"],
                title=payload["title"],
                path=payload["path"],
                created_by=payload.get("createdBy"),
                recommended_task=list(payload.get("recommendedTask") or []),
                ready=bool(payload.get("ready", False)),
            )
        elif tool_name == "sprintengine.artifact.list":
            base.update(task_id=payload.get("taskId"), kind=payload.get("kind"), status=payload.get("status"))
        elif tool_name == "sprintengine.artifact.ready":
            base.update(artifact_id=payload["artifactId"], id=payload["id"])
            _add_feedback_defaults(base, payload)
        elif tool_name == "sprintengine.artifact.approve":
            base.update(artifact_id=payload["artifactId"], id=payload["id"])
        elif tool_name == "sprintengine.artifact.request_changes":
            base.update(artifact_id=payload["artifactId"], id=payload["id"], feedback=payload["feedback"])
        return SimpleNamespace(**base)

    def _with_progress_context(self, tool_name: str, result: dict[str, Any]) -> dict[str, Any]:
        if tool_name in {"sprintengine.task.next", "sprintengine.task.claim", "sprintengine.gate.next", "sprintengine.gate.claim"}:
            agent = result.get("agent") if isinstance(result.get("agent"), dict) else {}
            current = agent.get("currentDispatch") if isinstance(agent, dict) else None
            result.setdefault("currentDispatch", current)
            if not current:
                result.setdefault("state", "idle" if not result.get("claimed") else "blocked")
            else:
                result.setdefault("state", "dispatched")
        if tool_name in {"sprintengine.gate.verdict", "sprintengine.gate.publish", "sprintengine.task.publish", "sprintengine.task.status"}:
            next_command = result.get("nextCommand")
            result.setdefault("progression", {"nextCommand": next_command, "state": "continuation_available" if next_command else "idle"})
        return result

    def _state_path(self, payload: dict[str, Any], *, required: bool) -> Path | None:
        raw = payload.get("statePath")
        if not raw:
            if required:
                raise McpToolError("invalid_state_path", "statePath is required.")
            return None
        if not isinstance(raw, str):
            raise McpToolError("invalid_state_path", "statePath must be a string.")
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                "invalid_state_path",
                "statePath appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        path = Path(raw).expanduser().resolve()
        if self.allowed_roots and not any(_is_relative_to(path, root) for root in self.allowed_roots):
            raise McpToolError("state_path_not_allowed", "statePath is outside the configured allowed roots.")
        return path

    def _workspace_root(self, payload: dict[str, Any], *, required: bool) -> Path | None:
        raw = payload.get("workspaceRoot")
        if not raw:
            if required:
                raise McpToolError("invalid_workspace_root", "workspaceRoot is required.")
            return None
        if not isinstance(raw, str):
            raise McpToolError("invalid_workspace_root", "workspaceRoot must be a string.")
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                "invalid_workspace_root",
                "workspaceRoot appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        path = Path(raw).expanduser().resolve()
        if self.allowed_roots and not any(_is_relative_to(path, root) for root in self.allowed_roots):
            raise McpToolError("workspace_root_not_allowed", "workspaceRoot is outside the configured allowed roots.")
        return path

    def _actor(self, actor: ActorContext | dict[str, Any] | None) -> ActorContext | None:
        try:
            return ActorContext.from_value(actor)
        except AuthorizationError:
            raise
        except Exception as exc:
            raise McpToolError("invalid_actor", "Actor context is invalid.", {"errorClass": exc.__class__.__name__}) from exc

    def _audit(
        self,
        tool_name: str,
        state_path: Path | None,
        actor: ActorContext | None,
        payload: dict[str, Any],
        start: float,
        result: str,
        error: Exception | None,
    ) -> None:
        if state_path is None or tool_name not in MUTATING_TOOLS:
            return
        try:
            record_audit_event(
                state_path,
                operation_name=tool_name,
                actor=actor.id if actor else "anonymous",
                result=result,
                duration_ms=max(0, int((time.monotonic() - start) * 1000)),
                task_id=str(payload.get("taskId") or "") or None,
                artifact_id=str(payload.get("artifactId") or "") or None,
                backend_mode="mcp-local",
                error=error,
            )
        except Exception:
            pass


def call_tool(
    tool_name: str,
    payload: dict[str, Any] | None = None,
    actor: ActorContext | dict[str, Any] | None = None,
    allowed_roots: list[str | Path] | None = None,
) -> dict[str, Any]:
    return SprintEngineMcpServer(allowed_roots=allowed_roots).call_tool(tool_name, payload, actor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local-first sprintengine MCP server")
    parser.add_argument("--allowed-root", action="append", default=[], help="Workspace root allowed to contain Sprint Engine state paths.")
    args = parser.parse_args(argv)
    server = SprintEngineMcpServer(allowed_roots=args.allowed_root, stdio_actor=ActorContext.from_environment())
    for line in sys.stdin:
        if not line.strip():
            continue
        response = _handle_stdio_message(server, line)
        print(json.dumps(response, sort_keys=True), flush=True)
    return 0


def _handle_stdio_message(server: SprintEngineMcpServer, line: str) -> dict[str, Any]:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": {"code": "invalid_json", "message": exc.msg}}
    request_id = message.get("id")
    method = message.get("method")
    if method == "initialize":
        params = message.get("params") or {}
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "sprintengine-mcp", "version": "0.1.0"},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": server.list_tools()}}
    if method == "tools/call":
        params = message.get("params") or {}
        result = server.call_tool(params.get("name", ""), params.get("arguments") or {}, server.stdio_actor)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    if "tool" in message:
        return server.call_tool(message.get("tool", ""), message.get("payload") or {}, server.stdio_actor)
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": "method_not_found", "message": f"Unsupported method: {method}"}}


def _add_feedback_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    for attr, camel, _ in FEEDBACK_SCORE_FIELDS:
        target[attr] = payload.get(attr, payload.get(camel))
    target["top_friction"] = payload.get("topFriction", payload.get("top_friction", ""))
    target["suggested_improvement"] = payload.get("suggestedImprovement", payload.get("suggested_improvement", ""))
    target["issue_json"] = _json_list(payload.get("issueJson", payload.get("issue_json", [])))
    target["finding_json"] = _json_list(payload.get("findingJson", payload.get("finding_json", [])))


def _json_list(values: Any) -> list[str]:
    output = []
    for value in values or []:
        output.append(value if isinstance(value, str) else json.dumps(value))
    return output


def _tool_requires_state_path(tool_name: str) -> bool:
    return tool_name not in {
        "sprintengine.health",
        "sprintengine.roles.list",
        "sprintengine.roles.get",
        "sprintengine.soul.get",
        "sprintengine.skills.list",
        "sprintengine.skill.get",
    }


def _default_workspace_root(state_path: Path) -> Path:
    for parent in state_path.parents:
        if (parent / ".multi-code").exists() or (parent / ".git").exists():
            return parent
    return state_path.parent


def _run_metadata(run: dict[str, Any], state_path: Path) -> dict[str, Any]:
    return {
        "name": run.get("name"),
        "goal": run.get("goal"),
        "status": run.get("status"),
        "phase": run.get("phase"),
        "runner": run.get("runner"),
        "statePath": str(state_path),
        "teamDir": str(state_path.parent),
    }


def _legacy_join_payload(state_path: Path, role: str, agent_id: str) -> dict[str, Any] | None:
    try:
        return cmd_join(SimpleNamespace(state=state_path, role=role, id=agent_id))
    except SystemExit as exc:
        return {"ok": False, "error": _system_exit_message(exc)}


def _compose_registry_prompt(registry: RegistryDiscovery, role: str, workspace_root: Path, run_id: str) -> str:
    try:
        soul_prompt = registry.render_soul(role, workspace_root=workspace_root, run_id=run_id).content
    except (KeyError, SoulRenderError):
        soul_prompt = None
    return compose_prompt(
        "# SprintEngine Coordination Rules",
        generic_role_swarm_prompt(role),
        soul_prompt,
        (
            "Use the Soul prompt above for role personality, judgment, and quality bar. "
            "The Sprint Engine coordination rules below override it for tool mechanics: coordinate through "
            "the Sprint Engine tool, do not edit Sprint Engine state files directly, respect task ownership and owned "
            "paths, log evidence, create artifacts through the artifact commands, and stop when your "
            "Sprint Engine role instructions tell you to stop. Current user and task instructions override both "
            "when they are more specific and do not violate Sprint Engine coordination rules."
        ),
    )


def _role_payload(entry: RegistryEntry, *, include_shadowed: bool = False) -> dict[str, Any]:
    role = entry.value
    if not isinstance(role, RoleManifest):
        return {}
    payload = _role_manifest_payload(role)
    payload["source"] = _source_payload(entry.source.layer.name)
    if include_shadowed:
        payload["shadowedSources"] = [_source_payload(source.layer.name) for source in entry.shadowed]
    return payload


def _role_manifest_payload(role: RoleManifest) -> dict[str, Any]:
    return {
        "id": role.id,
        "label": role.label,
        "aliases": list(role.aliases),
        "summary": role.summary,
        "icon": role.icon,
        "soul": [{"skill": entry.skill} for entry in role.soul],
    }


def _skill_payload(entry: RegistryEntry, *, include_body: bool) -> dict[str, Any]:
    skill = entry.value
    if not isinstance(skill, SkillDocument):
        return {}
    payload: dict[str, Any] = {
        "id": skill.id,
        "frontmatter": dict(skill.frontmatter),
        "source": _source_payload(entry.source.layer.name),
    }
    if include_body:
        payload["body"] = skill.body
    else:
        payload["bodyLength"] = len(skill.body)
    return payload


def _source_payload(layer_name: str) -> dict[str, Any]:
    return {"layer": layer_name}


def _warning_payloads(warnings: tuple[RegistryWarning, ...]) -> list[dict[str, Any]]:
    payloads = []
    for warning in warnings:
        payload = {
            "code": warning.code,
            "message": warning.message,
        }
        if warning.role_id:
            payload["roleId"] = warning.role_id
        if warning.skill_id:
            payload["skillId"] = warning.skill_id
        if warning.source_layer:
            payload["sourceLayer"] = warning.source_layer
        payloads.append(payload)
    return payloads


def _looks_like_foreign_platform_path(raw: str) -> bool:
    if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", raw):
        return True
    if os.name != "nt" and "\\" in raw:
        return True
    if os.name == "nt" and raw.startswith("/mnt/"):
        return True
    return False


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _system_exit_message(exc: SystemExit) -> str:
    if exc.code is None:
        return "SprintEngine core exited."
    return str(exc.code)


if __name__ == "__main__":
    raise SystemExit(main())
