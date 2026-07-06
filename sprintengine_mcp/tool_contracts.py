"""Single registry for active Sprint Engine MCP tool contracts."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from sprintengine_core.tool import (
    build_agent_next_directive,
    cmd_artifact_add,
    cmd_artifact_approve,
    cmd_artifact_list,
    cmd_artifact_ready,
    cmd_artifact_request_changes,
    cmd_handover,
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
    cmd_roster_configure,
    cmd_roster_list,
    cmd_roster_replenish,
    cmd_roster_retire,
    cmd_summary,
    cmd_task_claim,
    cmd_task_comment,
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
    cmd_task_release,
    cmd_task_resolve_input,
    cmd_task_status,
    cmd_triage_needs_input,
    cmd_vcs_commit,
    cmd_vcs_pr,
    cmd_vcs_status,
)

from .auth import ActorContext
from .payloads import command_payload_to_namespace

CommandHandler = Callable[[Any], dict[str, Any]]
PayloadAdapter = Callable[[str, Path, dict[str, Any], ActorContext | None], SimpleNamespace]


@dataclass(frozen=True)
class McpToolContract:
    name: str
    command_handler: CommandHandler | None = None
    payload_adapter: PayloadAdapter | None = None
    requires_state_path: bool = True

    @property
    def command_backed(self) -> bool:
        return self.command_handler is not None


def _command(name: str, handler: CommandHandler) -> McpToolContract:
    return McpToolContract(name=name, command_handler=handler, payload_adapter=command_payload_to_namespace)


def _special(name: str, *, requires_state_path: bool = True) -> McpToolContract:
    return McpToolContract(name=name, requires_state_path=requires_state_path)


MCP_TOOL_CONTRACTS: dict[str, McpToolContract] = {
    contract.name: contract
    for contract in [
        _special("sprintengine.help", requires_state_path=False),
        _command("sprintengine.handover", cmd_handover),
        _command("sprintengine.init", cmd_init),
        _command("sprintengine.recover", cmd_recover),
        _command("sprintengine.roster.add", cmd_roster_add),
        _command("sprintengine.roster.configure", cmd_roster_configure),
        _command("sprintengine.roster.retire", cmd_roster_retire),
        _command("sprintengine.roster.replenish", cmd_roster_replenish),
        _command("sprintengine.roster.list", cmd_roster_list),
        _special("sprintengine.agent.join"),
        _command("sprintengine.agent.next_directive", build_agent_next_directive),
        _special("sprintengine.agent.heartbeat"),
        _special("sprintengine.agent.leave"),
        _special("sprintengine.subscribe"),
        _command("sprintengine.join", cmd_join),
        _command("sprintengine.summary", cmd_summary),
        _special("sprintengine.dispatch.next"),
        _special("sprintengine.dispatch.ack"),
        _command("sprintengine.triage.needs_input", cmd_triage_needs_input),
        _special("sprintengine.roles.list", requires_state_path=False),
        _special("sprintengine.roles.get", requires_state_path=False),
        _special("sprintengine.soul.get", requires_state_path=False),
        _special("sprintengine.skills.list", requires_state_path=False),
        _special("sprintengine.skill.get", requires_state_path=False),
        _special("sprintengine.task.get"),
        _command("sprintengine.task.next", cmd_task_next),
        _command("sprintengine.task.claim", cmd_task_claim),
        _command("sprintengine.task.status", cmd_task_status),
        _command("sprintengine.task.resolve_input", cmd_task_resolve_input),
        _command("sprintengine.task.release", cmd_task_release),
        _command("sprintengine.task.log", cmd_task_log),
        _command("sprintengine.task.publish", cmd_task_publish),
        _command("sprintengine.task.note", cmd_task_note),
        _command("sprintengine.task.comment", cmd_task_comment),
        _command("sprintengine.task.comment.list", cmd_task_comment_list),
        _command("sprintengine.task.list", cmd_task_list),
        _special("sprintengine.task.request_changes"),
        _command("sprintengine.gate.list", cmd_task_gate_list),
        _command("sprintengine.gate.next", cmd_task_gate_next),
        _command("sprintengine.gate.claim", cmd_task_gate_claim),
        # `gate.publish` and `gate.skip` were aliases of `gate.verdict`
        # (skip = verdict "skipped" with the rationale as summary). They were
        # removed to shrink every reviewer's tool surface; the CLI wrappers
        # are unaffected.
        _command("sprintengine.gate.verdict", cmd_task_gate_verdict),
        _command("sprintengine.plan.add_task", cmd_plan_add_task),
        _command("sprintengine.plan.update_task", cmd_plan_update_task),
        _command("sprintengine.plan.delete_task", cmd_plan_delete_task),
        _command("sprintengine.plan.add_dependency", cmd_plan_add_dependency),
        _command("sprintengine.plan.remove_dependency", cmd_plan_remove_dependency),
        _command("sprintengine.plan.start_review", cmd_plan_start_review),
        _command("sprintengine.plan.review_status", cmd_plan_review_status),
        _command("sprintengine.plan.address_reviews", cmd_plan_address_reviews),
        _command("sprintengine.plan.list", cmd_plan_list),
        _special("sprintengine.plan.read"),
        _command("sprintengine.artifact.add", cmd_artifact_add),
        _command("sprintengine.artifact.list", cmd_artifact_list),
        _command("sprintengine.artifact.ready", cmd_artifact_ready),
        _command("sprintengine.artifact.approve", cmd_artifact_approve),
        _command("sprintengine.artifact.request_changes", cmd_artifact_request_changes),
        _command("sprintengine.vcs.status", cmd_vcs_status),
        _command("sprintengine.vcs.commit", cmd_vcs_commit),
        _command("sprintengine.vcs.pr", cmd_vcs_pr),
        _special("sprintengine.run.get"),
        _special("sprintengine.run.policy.get"),
        # `sprintengine.run.projection` is deliberately not an MCP tool. The
        # projection exists for the UI, which reads `projection.json` from
        # disk; over MCP it returned ~242k tokens in one call — more than an
        # entire agent context window.
        _special("sprintengine.run.subscribe"),
        _special("sprintengine.feedback.summarize"),
        _special("sprintengine.feedback.recommend_actions"),
        _special("sprintengine.health", requires_state_path=False),
    ]
}

ACTIVE_TOOL_NAMES = set(MCP_TOOL_CONTRACTS)
