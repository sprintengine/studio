"""Standalone local-first MCP boundary for the Sprint Engine coordination core."""

from __future__ import annotations

import argparse
from contextvars import ContextVar
from dataclasses import dataclass
import json
import os
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

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
    cmd_handover,
    load_mutation_state,
)
from sprintengine_core.tool.constants import VALID_ARTIFACT_KINDS
from sprintengine_core.tool.plans import plan_path_for_state
from sprintengine_core.skill_layers import SPRINTENGINE_SOUL_EXTRA_SKILLS
from sprintengine_core.tool.prompts import (
    compose_prompt,
    load_general_soul_prompt,
    load_sprintengine_coordination_prompt,
)
from sprintengine_core.tool.state import (
    append_event,
    append_task_activity,
    clear_task_refs,
    create_task_comment,
    ensure_agent,
    find_task,
    record_agent_heartbeat,
    record_agent_join,
    release_agent_targets,
    set_agent_idle,
    with_locked_state,
)
from sprintengine_core.tool.tasks import ensure_evidence, recompute_phase

from .auth import MUTATING_TOOLS, ActorContext, AuthorizationError, authorize_tool
from .capabilities import (
    CALLER_ROLE_PAYLOAD_TOOLS,
    allowed_tools_for_classification,
    classify_role,
    permitted_alternative,
)
from .payloads import command_payload_to_namespace
from .response_shapes import shape_tool_result
from .schemas import TOOL_SCHEMAS, list_tool_schemas
from .tool_contracts import MCP_TOOL_CONTRACTS


@dataclass(frozen=True)
class McpRequestContext:
    """Server-owned routing context for one authenticated HTTP MCP session."""

    actor: ActorContext | None
    state_path: Path
    workspace_root: Path
    allowed_roots: tuple[Path, ...]
    plugin_registry_roots: tuple[dict[str, str] | str | Path, ...] = ()
    user_root: Path | None = None
    actor_id: str = ""
    agent_id: str = ""
    role: str = ""
    cli: str = ""


_REQUEST_CONTEXT: ContextVar[McpRequestContext | None] = ContextVar("sprintengine_mcp_request_context", default=None)


def _leave_released_payload(entry: dict[str, Any]) -> dict[str, Any]:
    """Shape one release descriptor into the agent.leave releasedTargets item."""
    if entry.get("kind") == "gate":
        return {"kind": "gate", "taskId": entry.get("taskId"), "gateId": entry.get("gateId"), "attemptId": entry.get("attemptId")}
    return {"kind": "task", "taskId": entry.get("taskId"), "previousOwnerAgentId": entry.get("previousOwnerAgentId"), "status": entry.get("status")}


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
        plugin_registry_roots: list[dict[str, str] | str | Path] | None = None,
        user_root: str | Path | None = None,
        stdio_actor: ActorContext | dict[str, Any] | None = None,
        default_state_path: str | Path | None = None,
    ):
        self.allowed_roots = [Path(root).expanduser().resolve() for root in (allowed_roots or [])]
        self.plugin_registry_roots = tuple(plugin_registry_roots or [])
        self.user_root = Path(user_root).expanduser().resolve() if user_root is not None else None
        self.stdio_actor = self._actor(stdio_actor)
        self.default_state_path = Path(default_state_path).expanduser().resolve() if default_state_path is not None else None

    def list_tools(self, context: McpRequestContext | None = None) -> list[dict[str, Any]]:
        """List tool schemas, filtered to the session's role surface.

        Role-bound sessions (per-agent HTTP tokens) see only their
        capability surface. Run-scoped sessions, the app's operator actor,
        and stdio debug sessions see the full surface.
        """
        schemas = list_tool_schemas()
        role = (context.role if context else "") or ""
        classification = classify_role(
            role,
            workspace_root=context.workspace_root if context else None,
            plugin_registry_roots=context.plugin_registry_roots if context else (),
            user_root=context.user_root if context else None,
        )
        allowed = allowed_tools_for_classification(classification, TOOL_SCHEMAS)
        return [schema for schema in schemas if schema["name"] in allowed]

    def call_tool(
        self,
        tool_name: str,
        payload: dict[str, Any] | None = None,
        actor: ActorContext | dict[str, Any] | None = None,
        context: McpRequestContext | None = None,
    ) -> dict[str, Any]:
        start = time.monotonic()
        payload = payload or {}
        actor_context: ActorContext | None = None
        state_path: Path | None = None
        context_token = _REQUEST_CONTEXT.set(context)
        try:
            actor_context = context.actor if context is not None else self._actor(actor)
            if tool_name not in TOOL_SCHEMAS:
                raise McpToolError("unknown_tool", f"Unknown sprintengine MCP tool: {tool_name}")
            if not isinstance(payload, dict):
                raise McpToolError("invalid_payload", "Tool payload must be an object.")
            self._validate_session_identity_payload(tool_name, payload)
            contract = MCP_TOOL_CONTRACTS[tool_name]
            state_path = self._state_path(payload, required=contract.requires_state_path)
            self._validate_request_workspace_root(payload)
            authorize_tool(tool_name, payload, actor_context, state_path)
            self._authorize_role_capability(tool_name, payload, actor_context, state_path)
            if tool_name == "sprintengine.health":
                result = build_health_report(
                    state_path=state_path,
                    allowed_root=self.allowed_roots[0] if self.allowed_roots else None,
                    backend_mode="mcp-local",
                )
            else:
                if contract.requires_state_path:
                    assert state_path is not None
                result = self._dispatch(tool_name, state_path, payload, actor_context)
            result = shape_tool_result(tool_name, payload, result)
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
        finally:
            _REQUEST_CONTEXT.reset(context_token)

    def _dispatch(
        self,
        tool_name: str,
        state_path: Path | None,
        payload: dict[str, Any],
        actor: ActorContext | None,
    ) -> dict[str, Any]:
        if tool_name == "sprintengine.help":
            return self._help(payload)
        if tool_name == "sprintengine.agent.join":
            assert state_path is not None
            return self._agent_join(state_path, payload)
        if tool_name == "sprintengine.handover":
            assert state_path is not None
            return self._handover(state_path, payload, actor)
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
        if tool_name == "sprintengine.plan.read":
            assert state_path is not None
            return self._plan_read(state_path)
        if tool_name == "sprintengine.task.request_changes":
            assert state_path is not None
            return self._task_request_changes(state_path, payload, actor)
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
        contract = MCP_TOOL_CONTRACTS[tool_name]
        if contract.command_handler is None or contract.payload_adapter is None:
            raise McpToolError("unknown_tool", f"Unknown command-backed tool: {tool_name}")
        handler = contract.command_handler
        args = contract.payload_adapter(tool_name, state_path, payload, actor)
        result = handler(args)
        return self._with_progress_context(tool_name, result)

    def _help(self, payload: dict[str, Any]) -> dict[str, Any]:
        role = str(payload.get("role") or "<role>").strip() or "<role>"
        agent_id = str(payload.get("agentId") or "<agent-id>").strip() or "<agent-id>"
        topic = str(payload.get("topic") or "agent_workflow").strip() or "agent_workflow"
        if topic not in {"agent_workflow", "tools", "needs_input", "artifacts", "gates"}:
            raise McpToolError("invalid_payload", "topic must be one of agent_workflow, tools, needs_input, artifacts, or gates.")

        sections = {
            "agent_workflow": [
                "After this help call, call sprintengine.agent.join, then claim work with the claim tool your prompt names — sprintengine.task.next for tasks, sprintengine.gate.next for quality gates — using {role, id}.",
                "Work what the claim returns; it resumes your active item or claims the next ready one.",
                "If the claim returns no work, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.",
                "After a task or gate, publish evidence or a verdict, then stop. In worktree-mode runs, task.publish commits task-scoped changes under the git commit lock before routing the task onward. Multicode owns dispatch and continuation.",
                "Headless CLI agents outside the managed runtime use sprintengine.agent.next_directive for routing instead.",
                "If Auto Mode is off, you are blocked, need user input, or are near context limit, stop after recording the appropriate note or status.",
            ],
            # The triage line names an architect-only tool, so it is filtered
            # out for every other role: help must never direct a role at a
            # tool outside its capability surface.
            "tools": [
                f"Claim next ready role work: sprintengine.task.next with {{role: \"{role}\", id: \"{agent_id}\"}}.",
                f"Claim next ready quality gate: sprintengine.gate.next with {{role: \"{role}\", id: \"{agent_id}\"}}.",
                *(
                    [f"Architect-actionable triage: sprintengine.triage.needs_input with {{id: \"{agent_id}\"}}."]
                    if normalize_role_id(role) == "architect"
                    else []
                ),
                "Read a task card: sprintengine.task.get with {taskId}. The card is slim by default; pass include: [\"activity\", \"comments\", \"evidence_log\", \"diffs\"] for deep history.",
                "Log evidence: sprintengine.task.log with {taskId, id, summary, file, command, result, scopeExpansionJson}.",
                "Publish implementation evidence: sprintengine.task.publish with {taskId, id, summary, ...}; in worktree mode this also commits task-scoped changes under the git commit lock.",
                "Inspect or manually commit the shared run worktree only when needed: sprintengine.vcs.status and sprintengine.vcs.commit.",
                "Request ordinary task rework outside an active gate: sprintengine.task.request_changes with {taskId, id, reason, source?, paths?}.",
                "Use sprintengine.task.status as a low-level repair/admin transition when a normal workflow tool cannot represent the correction.",
            ],
            "needs_input": [
                "Move a task to needs_input with sprintengine.task.status and {taskId, id, status: \"needs_input\", needsInputKind, needsInputReason, needsInputQuestion, needsInputArtifactId?, needsInputSuggestedResolution?}.",
                "needsInputKind: architect when Sprint Engine should route automatic architect triage; user when the human operator must answer before the owner resumes.",
                "needsInputReason: task_scope, artifact_review, tooling, verification, product_decision, or blocked_other.",
                "needsInputQuestion is shown verbatim to a person. When needsInputKind is user, write it for the human operator, not for another agent: plain language, and no tool names, command flags, code symbols, file paths, or acceptance-criteria shorthand unless it is essential and you explain it.",
                "Structure a user question so it is scannable: open with one line naming the decision or action you need, then short '- ' bullet lines covering what is blocked, why you cannot resolve it yourself, and the concrete options or steps the user can take (recommended option first). End with the single thing you need back. Use line breaks and bullets, never one dense paragraph.",
                "Put your recommended default in needsInputSuggestedResolution when there is a clear one. A question the operator cannot act on without reading the code is not finished.",
                "Do not use needs_input for ordinary compile, test, review, or validation failures that an assigned role can fix; use gate.verdict changes_requested for an active gate or task.request_changes outside an active gate.",
            ],
            "artifacts": [
                "Register an artifact with sprintengine.artifact.add and {taskId, kind, title, path, createdBy, ready}.",
                f"kind must be one of: {', '.join(sorted(VALID_ARTIFACT_KINDS))}. Other values are rejected.",
                "Set ready: true only when the artifact must wait for human approval.",
            ],
            "gates": [
                "Record a gate verdict with sprintengine.gate.verdict and {taskId, gateId, role, id, verdict, summary}.",
                "Use approved when the gate passes; changes_requested or failed for rework; blocked when routed input is needed; skipped records the summary as the skip rationale.",
                "If no active gate attempt is claimed but later evidence shows rework is needed, use sprintengine.task.request_changes instead of forcing a gate verdict.",
            ],
        }
        ordered_topics = [topic] if topic != "agent_workflow" else ["agent_workflow", "tools", "needs_input", "artifacts", "gates"]
        markdown_parts = [f"## {name.replace('_', ' ').title()}\n" + "\n".join(f"- {line}" for line in sections[name]) for name in ordered_topics]
        return {
            "ok": True,
            "topic": topic,
            "role": role,
            "agentId": agent_id,
            "markdown": "\n\n".join(markdown_parts),
            "sections": {name: sections[name] for name in ordered_topics},
        }

    def _agent_join(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        workspace_root = self._workspace_root(payload, required=False) or _default_workspace_root(state_path)
        registry = discover_role_registry(
            workspace_root=workspace_root,
            plugin_roots=self._plugin_registry_roots(payload),
            user_root=self._effective_user_root(),
        )
        if normalize_role_id(str(payload["role"])) == "general":
            # `general` is a built-in soulless identity with no role manifest
            # (recognised by id in capabilities). Accept the join and compose its
            # manifest-less prompt instead of rejecting it as an unknown role.
            role = "general"
            role_entry = None
        else:
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
        role_payload = _general_role_manifest_payload() if role_entry is None else _role_payload(role_entry)
        prompt = _compose_registry_prompt(registry, role, workspace_root, str(lifecycle["run"].get("name") or ""))
        # `legacyJoin` (the cmd_join prose containing CLI-laden directives) is intentionally
        # omitted from the MCP response. Agents are MCP-native: managed agents read `prompt`
        # and then call the claim tool their startup/wake prompt names; headless CLI agents
        # route through `sprintengine.agent.next_directive`.
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
        }

    def _agent_heartbeat(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            agents = state.get("agents") if isinstance(state.get("agents"), dict) else {}
            existing = agents.get(agent_id) if isinstance(agents, dict) else None
            if not isinstance(existing, dict):
                return {
                    "ok": True,
                    "known": False,
                    "agent": None,
                    "previous": {},
                    "write": False,
                }
            before = dict(existing)
            role = payload.get("role") or before.get("role")
            agent = record_agent_heartbeat(state, agent_id, str(role) if role else None)
            return {
                "ok": True,
                "known": True,
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
        agent = result.get("agent") if isinstance(result.get("agent"), dict) else None
        return {
            "ok": True,
            "known": result.get("known", True),
            "agent": agent,
            "currentDispatch": agent.get("currentDispatch") if agent else None,
            "assignmentUnchanged": {
                "status": bool(agent) and agent.get("status") == result["previous"].get("status"),
                "currentTaskId": bool(agent) and agent.get("currentTaskId") == result["previous"].get("currentTaskId"),
                "currentGateId": bool(agent) and agent.get("currentGateId") == result["previous"].get("currentGateId"),
                "currentDispatch": bool(agent) and agent.get("currentDispatch") == result["previous"].get("currentDispatch"),
            },
        }

    def _agent_leave(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(payload["agentId"]).strip()
        if not agent_id:
            raise McpToolError("invalid_payload", "agentId cannot be empty.")
        reason = str(payload.get("reason") or "agent left")

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            agents = state.get("agents") if isinstance(state.get("agents"), dict) else {}
            agent = agents.get(agent_id)
            known = isinstance(agent, dict)
            # Single release authority: frees the departing agent's owned
            # in_progress task and any live gate claim (needs_input tasks stay
            # owned) and resets it to idle. Runs for unknown agents too, as
            # defensive cleanup of stale ownership; it never mints a roster entry.
            released = [
                _leave_released_payload(entry)
                for entry in release_agent_targets(state, agent_id, reason=reason, actor=agent_id)
            ]
            if not known:
                if not released:
                    return {"ok": True, "known": False, "agent": None, "releasedTargets": [], "event": None, "write": False}
                event = append_event(
                    state,
                    "agent_left",
                    agent_id,
                    f"Unknown agent {agent_id} left Sprint Engine. Released targets: {len(released)}.",
                    {"releasedTargets": released, "reason": reason},
                )
                return {"ok": True, "known": False, "agent": None, "releasedTargets": released, "event": event, "write": True}
            event = append_event(
                state,
                "agent_left",
                agent_id,
                f"{agent_id} left Sprint Engine. Released targets: {len(released)}.",
                {"releasedTargets": released, "reason": reason},
            )
            return {"ok": True, "known": True, "agent": agent, "releasedTargets": released, "event": event, "write": True}

        result = with_locked_state(state_path, mutate)
        return {
            "ok": True,
            "known": result["known"],
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
            # Default the replay cursor to the agent's last acked dispatch so
            # a caller that omits lastDispatchId gets the delta since its own
            # ack instead of the run's full ledger history.
            cursor = last_dispatch_id
            if not cursor and isinstance(agent, dict):
                subscription = agent.get("subscription")
                if isinstance(subscription, dict):
                    cursor = str(subscription.get("lastDispatchId") or "").strip()
            dispatches = [
                record for record in folder_store.read_jsonl_file(state_path.parent / folder_store.DISPATCH_FILE)
                if record.get("agentId") == agent_id
            ]
            if cursor:
                seen = False
                filtered = []
                for record in dispatches:
                    if seen:
                        filtered.append(record)
                    elif record.get("id") == cursor:
                        seen = True
                # A cursor absent from the agent's ledger rows (mistyped ack,
                # pruned/recreated dispatch.jsonl) must not blank the replay
                # forever: fall back to the full (shaper-capped) history so
                # delivery self-heals instead of trusting a poisoned cursor.
                if seen:
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

    # Without a cursor, the full event log is unbounded over a run's life
    # (~11k tokens observed on a real store). Cold subscribers get only the
    # newest window plus a truncation marker; they can page back via
    # lastEventId if they genuinely need history.
    RUN_SUBSCRIBE_NO_CURSOR_LIMIT = 50

    def _run_subscribe(self, state_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        last_event_id = str(payload.get("lastEventId") or "").strip()

        def run(state: dict[str, Any]) -> dict[str, Any]:
            events = [event for event in state.get("events", []) if isinstance(event, dict)]
            truncated = False
            oldest_returned_id = None
            if last_event_id:
                seen = False
                filtered = []
                for event in events:
                    if seen:
                        filtered.append(event)
                    elif event.get("id") == last_event_id:
                        seen = True
                events = filtered
            elif len(events) > self.RUN_SUBSCRIBE_NO_CURSOR_LIMIT:
                events = events[-self.RUN_SUBSCRIBE_NO_CURSOR_LIMIT:]
                truncated = True
            if events:
                oldest_returned_id = events[0].get("id") if isinstance(events[0], dict) else None
            latest_event = events[-1] if events else None
            return {
                "ok": True,
                "events": events,
                "truncated": truncated,
                "oldestReturnedEventId": oldest_returned_id,
                "latestEvent": latest_event,
                "latestEventId": latest_event.get("id") if isinstance(latest_event, dict) else None,
                "state": "events_available" if events else "idle",
                "write": False,
            }

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
        needs_input_fields = sorted(
            field
            for field in (
                "needsInputKind",
                "needsInputReason",
                "needsInputArtifactId",
                "needsInputQuestion",
                "needsInputSuggestedResolution",
            )
            if payload.get(field) is not None
        )
        if needs_input_fields:
            raise McpToolError(
                "invalid_payload",
                "sprintengine.task.request_changes routes ordinary rework to changes_requested. "
                "Use sprintengine.task.status with status=\"needs_input\" for routed blockers.",
                {"fields": needs_input_fields},
            )
        task_id = str(payload["taskId"])
        requester_id = str(payload.get("id") or (actor.id if actor else "mcp")).strip() or "mcp"
        reason = str(payload["reason"] or "").strip()
        paths = list(payload.get("paths") or [])
        source = str(payload.get("source") or "user").strip() or "user"

        def mutate(state: dict[str, Any]) -> dict[str, Any]:
            task = find_task(state, task_id)
            previous_owner_id = task.get("ownerAgentId")
            comment = create_task_comment(
                state,
                task,
                actor=requester_id,
                body=reason,
                comment_type="review_feedback",
                source=source,
                paths=paths,
                data={"status": "open", "reason": reason},
            )
            task["status"] = "changes_requested"
            task["completedAt"] = None
            task.pop("needsInput", None)
            ensure_evidence(task)["summary"] = reason
            cleared = clear_task_refs(state, task_id)
            if previous_owner_id:
                set_agent_idle(ensure_agent(state, previous_owner_id, task.get("role")))
            task["ownerAgentId"] = None
            append_task_activity(
                task,
                "status_change",
                requester_id,
                f"{requester_id} moved {task_id} to changes_requested.",
                {"status": "changes_requested"},
            )
            recompute_phase(state)
            event = append_event(
                state,
                "task_status_changed",
                requester_id,
                f"{requester_id} moved {task_id} to changes_requested.",
            )
            return {"ok": True, "comment": comment, "task": task, "event": event, "clearedAgents": cleared}

        return with_locked_state(state_path, mutate)

    def _handover(self, state_path: Path, payload: dict[str, Any], actor: ActorContext | None) -> dict[str, Any]:
        handover_payload = dict(payload)
        workspace_root = self._workspace_root(payload, required=False) or _default_workspace_root(state_path)
        if handover_payload.get("handoverPath"):
            handover_payload["handoverPath"] = self._input_file_path(
                handover_payload["handoverPath"],
                base_root=workspace_root,
            )
        if handover_payload.get("sourceBundle"):
            handover_payload["source"] = self._source_bundle_args(
                handover_payload["sourceBundle"],
                base_root=workspace_root,
            )
        args = command_payload_to_namespace("sprintengine.handover", state_path, handover_payload, actor)
        result = cmd_handover(args)
        result.pop("architectStartupPrompt", None)
        result["bootstrap"] = {
            "owner": "app",
            "nextMcpToolName": "sprintengine.init",
            "nextMcpArguments": {"statePath": str(state_path)},
            "terminalAgentRequired": False,
            "message": "Bootstrap was created through MCP/core. The app should call sprintengine.init through MCP when ready.",
        }
        return result

    def _plan_read(self, state_path: Path) -> dict[str, Any]:
        plan_path = plan_path_for_state(state_path)
        if not plan_path.exists():
            return {"ok": True, "exists": False, "path": str(plan_path), "content": "", "write": False}
        if not plan_path.is_file():
            raise McpToolError("invalid_plan_path", "Sprint Engine plan path is not a file.")
        return {
            "ok": True,
            "exists": True,
            "path": str(plan_path),
            "content": plan_path.read_text(encoding="utf-8"),
            "write": False,
        }

    def _registry_tool(self, tool_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        workspace_root = self._workspace_root(payload, required=True)
        assert workspace_root is not None
        registry = discover_role_registry(
            workspace_root=workspace_root,
            plugin_roots=self._plugin_registry_roots(payload),
            user_root=self._effective_user_root(),
        )
        if tool_name == "sprintengine.roles.list":
            include_shadowed = bool(payload.get("includeShadowed", False))
            roles = [_role_payload(entry, include_shadowed=include_shadowed) for _, entry in sorted(registry.roles.items())]
            return {"ok": True, "roles": roles, "aliases": dict(sorted(registry.aliases.items())), "warnings": _warning_payloads(registry.warnings)}
        if tool_name == "sprintengine.roles.get":
            try:
                entry = registry.role_entry(str(payload["roleId"]))
            except KeyError as exc:
                raise McpToolError("unknown_role", _unknown_role_message(str(payload["roleId"]), registry.roles)) from exc
            return {"ok": True, "role": _role_payload(entry, include_shadowed=True), "warnings": _warning_payloads(registry.warnings)}
        if tool_name == "sprintengine.soul.get":
            run_id = str(payload.get("runId") or "")
            try:
                rendered = registry.render_soul(str(payload["roleId"]), workspace_root=workspace_root, run_id=run_id)
            except KeyError as exc:
                raise McpToolError("unknown_role", _unknown_role_message(str(payload["roleId"]), registry.roles)) from exc
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
                raise McpToolError("unknown_skill", _unknown_skill_message(str(payload["skillId"]), registry.skills))
            return {"ok": True, "skill": _skill_payload(entry, include_body=True), "warnings": _warning_payloads(registry.warnings)}
        raise McpToolError("unknown_tool", f"Unknown registry tool: {tool_name}")

    def _plugin_registry_roots(self, payload: dict[str, Any]) -> list[dict[str, str]]:
        roots: list[dict[str, str]] = []
        roots.extend(self._configured_plugin_registry_roots())
        for raw in payload.get("pluginRegistryRoots") or []:
            if not isinstance(raw, dict):
                raise McpToolError("invalid_plugin_registry_root", "pluginRegistryRoots entries must be objects.")
            root = self._registry_root_path(raw.get("root"))
            plugin_id = raw.get("id") or raw.get("pluginId")
            entry = {"root": str(root)}
            if isinstance(plugin_id, str) and plugin_id.strip():
                entry["id"] = plugin_id.strip()
            roots.append(entry)
        for raw in payload.get("extraDirs") or []:
            root = self._registry_root_path(raw)
            roots.append({"root": str(root)})
        return roots

    def _configured_plugin_registry_roots(self) -> list[dict[str, str]]:
        roots: list[dict[str, str]] = []
        for raw in self._effective_plugin_registry_roots():
            if isinstance(raw, dict):
                root = self._registry_root_path(raw.get("root") or raw.get("path"), enforce_allowed=False)
                plugin_id = raw.get("id") or raw.get("pluginId") or raw.get("plugin_id")
                entry = {"root": str(root)}
                if isinstance(plugin_id, str) and plugin_id.strip():
                    entry["id"] = plugin_id.strip()
                roots.append(entry)
                continue
            root = self._registry_root_path(raw, enforce_allowed=False)
            roots.append({"root": str(root)})
        return roots

    def _registry_root_path(self, raw: Any, *, enforce_allowed: bool = True) -> Path:
        if not isinstance(raw, str) or not raw.strip():
            raise McpToolError("invalid_plugin_registry_root", "Plugin registry root must be a non-empty string.")
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                "invalid_plugin_registry_root",
                "Plugin registry root appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        path = Path(raw).expanduser().resolve()
        allowed_roots = self._effective_allowed_roots()
        if enforce_allowed and allowed_roots and not any(_is_relative_to(path, root) for root in allowed_roots):
            raise McpToolError("plugin_registry_root_not_allowed", "Plugin registry root is outside the configured allowed roots.")
        return path

    def _with_progress_context(self, tool_name: str, result: dict[str, Any]) -> dict[str, Any]:
        events = _result_events(result)
        if events:
            latest_event = events[-1]
            result.setdefault("events", events)
            result.setdefault("latestEvent", latest_event)
            result.setdefault("latestEventId", latest_event.get("id"))
        if tool_name in {"sprintengine.task.next", "sprintengine.task.claim", "sprintengine.gate.next", "sprintengine.gate.claim"}:
            agent = result.get("agent") if isinstance(result.get("agent"), dict) else {}
            current = agent.get("currentDispatch") if isinstance(agent, dict) else None
            result.setdefault("currentDispatch", current)
            if not current:
                result.setdefault("state", "idle" if not result.get("claimed") else "blocked")
            else:
                result.setdefault("state", "dispatched")
        if tool_name in {"sprintengine.gate.verdict", "sprintengine.task.publish", "sprintengine.task.status"}:
            next_command = result.get("nextCommand")
            result.setdefault("progression", {"nextCommand": next_command, "state": "continuation_available" if next_command else "idle"})
        return result

    def _state_path(self, payload: dict[str, Any], *, required: bool) -> Path | None:
        context = self._request_context()
        raw = payload.get("statePath")
        if context is not None:
            if raw:
                if not isinstance(raw, str):
                    raise McpToolError("invalid_state_path", "statePath must be a string.")
                supplied = self._path_from_string(raw, "statePath", "invalid_state_path")
                if supplied != context.state_path:
                    raise McpToolError("state_path_not_allowed", "HTTP run cannot access a different Sprint Engine statePath.")
            return context.state_path if (required or raw or context.state_path is not None) else None
        if not raw:
            if not required:
                return None
            raw = os.environ.get("SPRINTENGINE_STATE_PATH")
        if not raw:
            if self.default_state_path is not None:
                path = self.default_state_path
                if self.allowed_roots and not any(_is_relative_to(path, root) for root in self.allowed_roots):
                    raise McpToolError("state_path_not_allowed", "statePath is outside the configured allowed roots.")
                return path
            raise McpToolError("invalid_state_path", "statePath is required.")
        if not isinstance(raw, str):
            raise McpToolError("invalid_state_path", "statePath must be a string.")
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                "invalid_state_path",
                "statePath appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        path = Path(raw).expanduser().resolve()
        allowed_roots = self._effective_allowed_roots()
        if allowed_roots and not any(_is_relative_to(path, root) for root in allowed_roots):
            raise McpToolError("state_path_not_allowed", "statePath is outside the configured allowed roots.")
        return path

    def _workspace_root(self, payload: dict[str, Any], *, required: bool) -> Path | None:
        context = self._request_context()
        raw = payload.get("workspaceRoot")
        if context is not None:
            if raw:
                if not isinstance(raw, str):
                    raise McpToolError("invalid_workspace_root", "workspaceRoot must be a string.")
                supplied = self._path_from_string(raw, "workspaceRoot", "invalid_workspace_root")
                if supplied != context.workspace_root:
                    raise McpToolError("workspace_root_not_allowed", "HTTP run cannot access a different workspaceRoot.")
            return context.workspace_root
        # Resolution chain so autonomous agents don't need to pass workspaceRoot in payloads:
        #   1. explicit `workspaceRoot` in payload (debug / CLI overrides)
        #   2. `SPRINTENGINE_WORKSPACE_ROOT` env var (set by Multicode at MCP server launch)
        #   3. derive from `statePath` (payload → `SPRINTENGINE_STATE_PATH` env → default_state_path)
        if not raw:
            raw = os.environ.get("SPRINTENGINE_WORKSPACE_ROOT")
        if raw:
            if not isinstance(raw, str):
                raise McpToolError("invalid_workspace_root", "workspaceRoot must be a string.")
            if _looks_like_foreign_platform_path(raw):
                raise McpToolError(
                    "invalid_workspace_root",
                    "workspaceRoot appears to mix Windows and POSIX path formats. Use the path format for this process.",
                )
            path = Path(raw).expanduser().resolve()
            allowed_roots = self._effective_allowed_roots()
            if allowed_roots and not any(_is_relative_to(path, root) for root in allowed_roots):
                raise McpToolError("workspace_root_not_allowed", "workspaceRoot is outside the configured allowed roots.")
            return path
        derived_state: Path | None = None
        state_raw = payload.get("statePath") or os.environ.get("SPRINTENGINE_STATE_PATH")
        if state_raw and isinstance(state_raw, str):
            try:
                derived_state = Path(state_raw).expanduser().resolve()
            except (OSError, ValueError):
                derived_state = None
        if derived_state is None and self.default_state_path is not None:
            derived_state = self.default_state_path
        if derived_state is not None:
            derived = _default_workspace_root(derived_state)
            allowed_roots = self._effective_allowed_roots()
            if allowed_roots and not any(_is_relative_to(derived, root) for root in allowed_roots):
                # Derived root isn't allowed; fall through to required-error or None.
                pass
            else:
                return derived
        if required:
            raise McpToolError("invalid_workspace_root", "workspaceRoot is required.")
        return None

    def _input_file_path(self, raw: Any, *, base_root: Path | None = None) -> Path:
        if not isinstance(raw, str) or not raw.strip():
            raise McpToolError("invalid_input_path", "Input file path must be a non-empty string.")
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                "invalid_input_path",
                "Input file path appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        raw_path = Path(raw).expanduser()
        if not raw_path.is_absolute() and base_root is not None:
            raw_path = base_root / raw_path
        path = raw_path.resolve()
        allowed_roots = self._effective_allowed_roots()
        if allowed_roots and not any(_is_relative_to(path, root) for root in allowed_roots):
            raise McpToolError("input_path_not_allowed", "Input file path is outside the configured allowed roots.")
        return path

    def _source_bundle_args(self, raw: Any, *, base_root: Path | None = None) -> list[str]:
        if not isinstance(raw, list):
            raise McpToolError("invalid_source_bundle", "sourceBundle must be an array.")
        values: list[str] = []
        for index, item in enumerate(raw):
            if not isinstance(item, dict):
                raise McpToolError("invalid_source_bundle", f"sourceBundle[{index}] must be an object.")
            kind = str(item.get("kind") or "").strip()
            source_path = item.get("sourcePath") or item.get("path")
            if not kind:
                raise McpToolError("invalid_source_bundle", f"sourceBundle[{index}].kind is required.")
            path = self._input_file_path(source_path, base_root=base_root)
            values.append(f"{kind}:{path}")
        return values

    def _validate_session_identity_payload(self, tool_name: str, payload: dict[str, Any]) -> None:
        # HTTP run tokens scope routing to a workspace/run store. Agents still
        # self-identify with their own role and id in tool payloads.
        return

    def _authorize_role_capability(
        self,
        tool_name: str,
        payload: dict[str, Any],
        actor: ActorContext | None,
        state_path: Path | None,
    ) -> None:
        """Reject calls outside the session role's tool surface.

        The effective role is the session-bound role for agent-scoped HTTP
        tokens, falling back to the actor's self-declared role. Operator
        actors (the app, the human/debug CLI, stdio) keep the full surface.
        Visibility and authorization share one capability table, so a tool
        hidden from a role's `tools/list` also fails when called by name.
        """
        context = self._request_context()
        bound_role = (context.role if context else "") or ""
        effective_role = bound_role or (actor.role if actor else "")
        workspace_root: Path | str | None = context.workspace_root if context else None
        if workspace_root is None:
            raw_workspace_root = payload.get("workspaceRoot")
            if isinstance(raw_workspace_root, str) and raw_workspace_root.strip():
                workspace_root = raw_workspace_root
            elif state_path is not None:
                workspace_root = _default_workspace_root(state_path)
        classification = classify_role(
            effective_role,
            workspace_root=workspace_root,
            plugin_registry_roots=context.plugin_registry_roots if context else self.plugin_registry_roots,
            user_root=(context.user_root if context else None) or self.user_root,
        )
        if classification == "operator":
            return
        if bound_role and tool_name in CALLER_ROLE_PAYLOAD_TOOLS:
            payload_role = str(payload.get("role") or "").strip()
            if payload_role and normalize_role_id(payload_role) != normalize_role_id(bound_role):
                raise McpToolError(
                    "tool_not_permitted_for_role",
                    f"This session is bound to role {bound_role!r} and cannot call {tool_name} as role {payload_role!r}.",
                    {"role": bound_role, "payloadRole": payload_role},
                )
        allowed = allowed_tools_for_classification(classification, TOOL_SCHEMAS)
        if tool_name in allowed:
            return
        alternative = permitted_alternative(tool_name)
        raise McpToolError(
            "tool_not_permitted_for_role",
            f"{tool_name} is not in the {effective_role!r} role's tool surface."
            + (f" Use {alternative} instead." if alternative else ""),
            {
                "role": effective_role,
                **({"permittedAlternative": alternative} if alternative else {}),
            },
        )

    def _validate_request_workspace_root(self, payload: dict[str, Any]) -> None:
        context = self._request_context()
        if context is None or not payload.get("workspaceRoot"):
            return
        raw = payload["workspaceRoot"]
        if not isinstance(raw, str):
            raise McpToolError("invalid_workspace_root", "workspaceRoot must be a string.")
        supplied = self._path_from_string(raw, "workspaceRoot", "invalid_workspace_root")
        if supplied != context.workspace_root:
            raise McpToolError("workspace_root_not_allowed", "HTTP run cannot access a different workspaceRoot.")

    def _request_context(self) -> McpRequestContext | None:
        return _REQUEST_CONTEXT.get()

    def _effective_allowed_roots(self) -> list[Path]:
        context = self._request_context()
        return list(context.allowed_roots) if context is not None else self.allowed_roots

    def _effective_plugin_registry_roots(self) -> tuple[dict[str, str] | str | Path, ...]:
        context = self._request_context()
        return context.plugin_registry_roots if context is not None else self.plugin_registry_roots

    def _effective_user_root(self) -> Path | None:
        context = self._request_context()
        return context.user_root if context is not None else self.user_root

    def _path_from_string(self, raw: str, field: str, code: str) -> Path:
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                code,
                f"{field} appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        return Path(raw).expanduser().resolve()

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
    parser.add_argument("--workspace", action="append", default=[], help="Workspace root allowed to contain Sprint Engine state paths.")
    parser.add_argument("--allowed-root", action="append", default=[], help="Workspace root allowed to contain Sprint Engine state paths.")
    parser.add_argument("--state-path", help="Default Sprint Engine run.yaml path used when tool arguments omit statePath.")
    parser.add_argument("--extra-dir", action="append", default=[], help="Additional plugin registry root containing roles/ and skills/.")
    parser.add_argument("--user-dir", help="User registry base directory; the server reads <user-dir>/.sprintengine.")
    parser.add_argument("--http", action="store_true", help="Serve MCP over local Streamable HTTP instead of stdio.")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host for --http mode. Defaults to 127.0.0.1.")
    parser.add_argument("--port", type=int, default=0, help="HTTP port for --http mode. Use 0 to choose a free port.")
    parser.add_argument("--auth-token", help="Bearer token required by --http mode. Defaults to SPRINTENGINE_MCP_HTTP_TOKEN.")
    args = parser.parse_args(argv)
    allowed_roots = [*args.workspace, *args.allowed_root]
    server = SprintEngineMcpServer(
        allowed_roots=allowed_roots,
        plugin_registry_roots=args.extra_dir,
        user_root=args.user_dir,
        stdio_actor=ActorContext.from_environment(),
        default_state_path=args.state_path,
    )
    if args.http:
        from .http_server import serve_http

        return serve_http(
            server,
            host=args.host,
            port=args.port,
            actor=server.stdio_actor,
            auth_token=args.auth_token or os.environ.get("SPRINTENGINE_MCP_HTTP_TOKEN"),
        )
    for line in sys.stdin:
        if not line.strip():
            continue
        response = _handle_stdio_message(server, line)
        if response is None:
            continue
        print(json.dumps(response, sort_keys=True), flush=True)
    return 0


def _handle_stdio_message(server: SprintEngineMcpServer, line: str) -> dict[str, Any] | None:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": {"code": "invalid_json", "message": exc.msg}}
    return _handle_jsonrpc_message(server, message, server.stdio_actor)


def _handle_jsonrpc_message(
    server: SprintEngineMcpServer,
    message: dict[str, Any],
    actor: ActorContext | dict[str, Any] | None,
    context: McpRequestContext | None = None,
) -> dict[str, Any] | None:
    method = message.get("method")
    # JSON-RPC 2.0 notifications have a method but no id and MUST NOT receive a response.
    # The MCP protocol relies on this for notifications/initialized, notifications/cancelled,
    # notifications/progress, etc. Replying (even with an error) violates the spec and
    # strict clients (e.g. Claude Code) close the transport with code -32603.
    if method is not None and "id" not in message:
        return None
    request_id = message.get("id")
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
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": server.list_tools(context)}}
    if method == "tools/call":
        params = message.get("params") or {}
        raw = server.call_tool(params.get("name", ""), params.get("arguments") or {}, actor, context=context)
        # MCP spec: tools/call result must be a CallToolResult ({ content, isError }).
        # Strict clients (recent Codex/Claude Code) reject the raw envelope with
        # "Unexpected response type". Wrap the envelope as a JSON-encoded text content
        # so callers can parse it back to the original { ok, tool, result/error } shape.
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(raw, sort_keys=True)}],
                "isError": not raw.get("ok", True),
            },
        }
    if "tool" in message:
        return server.call_tool(message.get("tool", ""), message.get("payload") or {}, actor, context=context)
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": "method_not_found", "message": f"Unsupported method: {method}"}}


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


def _compose_registry_prompt(registry: RegistryDiscovery, role: str, workspace_root: Path, run_id: str) -> str:
    if normalize_role_id(role) == "general":
        # The soulless General has no role manifest, so it would otherwise fall
        # through the render_soul fallback below and silently lose the universal
        # norms. Compose its layer deliberately: no role-personality Soul, but the
        # full norm + Multicode product layer plus the orchestration skill. Reuse
        # the workspace-scoped registry so skill overrides apply as for a soul.
        soul_prompt = load_general_soul_prompt(registry)
    else:
        try:
            soul_prompt = registry.render_soul(
                role,
                workspace_root=workspace_root,
                run_id=run_id,
                extra_skills=SPRINTENGINE_SOUL_EXTRA_SKILLS,
            ).content
        except (KeyError, SoulRenderError):
            soul_prompt = None
    return compose_prompt(
        "# SprintEngine Coordination Rules",
        load_sprintengine_coordination_prompt(role),
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


def _general_role_manifest_payload() -> dict[str, Any]:
    # `general` has no registry manifest; describe the built-in soulless identity
    # so the join response keeps the same `roleManifest` shape as a real role.
    return {
        "id": "general",
        "label": "General",
        "aliases": [],
        "summary": "Soulless General agent that plans, builds, reviews, and tests a sprint by itself.",
        "icon": None,
        "soul": [],
        "capabilities": [],
        "source": _source_payload("builtin"),
    }


def _role_manifest_payload(role: RoleManifest) -> dict[str, Any]:
    return {
        "id": role.id,
        "label": role.label,
        "aliases": list(role.aliases),
        "summary": role.summary,
        "icon": role.icon,
        "soul": [{"skill": entry.skill} for entry in role.soul],
        "capabilities": [
            {
                "kind": capability.kind,
                **({"phase": capability.phase} if capability.phase else {}),
                **({"reviews": list(capability.reviews)} if capability.reviews else {}),
                **({"defaultFocus": capability.default_focus} if capability.default_focus else {}),
            }
            for capability in role.capabilities
        ],
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


def _unknown_role_message(role_id: str, roles: dict[str, RegistryEntry]) -> str:
    known = ", ".join(sorted(roles))
    detail = f" Known roles: {known}." if known else ""
    return f"Unknown registry role: {role_id}.{detail}"


def _unknown_skill_message(skill_id: str, skills: dict[str, RegistryEntry]) -> str:
    known = ", ".join(sorted(skills))
    detail = f" Known skills: {known}." if known else ""
    return f"Unknown registry skill: {skill_id}.{detail}"


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


def _result_events(result: dict[str, Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for key in ("event", "notification"):
        value = result.get(key)
        if isinstance(value, dict):
            events.append(value)
    for key in ("events", "notifications"):
        values = result.get(key)
        if isinstance(values, list):
            events.extend(value for value in values if isinstance(value, dict))
    return events


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
