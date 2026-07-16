"""Import-compatible Sprint Engine tool package.

The public module path remains ``sprintengine_core.tool`` for scripts, tests,
and MCP callers. Implementation is split into focused package modules while
legacy command behavior is preserved and re-exported here.
"""

from __future__ import annotations

from .legacy import *  # noqa: F403
from .cli import build_parser, main
from .commands.artifact import (
    cmd_artifact_add,
    cmd_artifact_approve,
    cmd_artifact_list,
    cmd_artifact_ready,
    cmd_artifact_request_changes,
)
from .commands.plan import (
    cmd_plan_add_dependency,
    cmd_plan_add_task,
    cmd_plan_address_reviews,
    cmd_plan_delete_task,
    cmd_plan_list,
    cmd_plan_remove_dependency,
    cmd_plan_review_status,
    cmd_plan_start_review,
    cmd_plan_update_task,
)
from .commands.roster import (
    cmd_roster_configure,
    cmd_roster_enable,
    cmd_roster_runtime,
)
from .commands.run import (
    build_agent_next_directive,
    auto_mode_continuation,
    cmd_handover,
    cmd_init,
    cmd_join,
    cmd_merge_start,
    cmd_projection,
    cmd_recover,
    cmd_runner_set,
    cmd_runner_status,
    cmd_summary,
    cmd_triage_needs_input,
    cmd_vcs_commit,
    cmd_vcs_pr,
    cmd_vcs_status,
    runner_watch_delay_seconds,
)
from .commands.task import (
    cmd_task_advance,
    cmd_task_claim,
    cmd_task_comment,
    cmd_task_comment_list,
    cmd_task_list,
    cmd_task_log,
    cmd_task_next,
    cmd_task_note,
    cmd_task_publish,
    cmd_task_refresh_ready,
    cmd_task_release,
    cmd_task_resolve_input,
    cmd_task_status,
)
from .roles import DEFAULT_ROLE_REGISTRY, PLAN_REVIEW_ROLES, VALID_ROLES, RoleRegistry

__all__ = [
    name
    for name in globals()
    if not name.startswith("_")
]
