from pathlib import Path

import sprintengine_core.tool as tool
from sprintengine_core.tool import artifacts, feedback, phase_prompts, plans, tasks
from sprintengine_core.role_registry import discover_role_registry
from sprintengine_core.tool.roles import (
    configured_role_ids,
    configured_soul_role_ids,
    dispatchable_role_ids,
    is_configured_role,
)
from helpers import write_workspace_role


def test_tool_package_preserves_public_entrypoint_imports() -> None:
    assert callable(tool.main)
    assert callable(tool.build_parser)
    assert callable(tool.append_task_activity)


def test_parser_uses_focused_command_group_adapters() -> None:
    parser = tool.build_parser()

    join_args = parser.parse_args(["join", "--role", "developer", "--id", "developer-1"])
    task_args = parser.parse_args(["task", "next", "--role", "developer", "--id", "developer-1"])
    artifact_args = parser.parse_args(["artifact", "list"])

    assert join_args.handler.__module__ == "sprintengine_core.tool.commands.run"
    assert task_args.handler.__module__ == "sprintengine_core.tool.commands.task"
    assert artifact_args.handler.__module__ == "sprintengine_core.tool.commands.artifact"


def test_cli_parser_module_no_longer_owns_command_handler_bodies() -> None:
    assert tool.cmd_join.__module__ == "sprintengine_core.tool.commands.run"
    assert tool.cmd_task_next.__module__ == "sprintengine_core.tool.commands.task"
    assert tool.cmd_plan_add_task.__module__ == "sprintengine_core.tool.commands.plan"
    assert tool.cmd_artifact_add.__module__ == "sprintengine_core.tool.commands.artifact"


def test_command_modules_import_focused_helpers_without_parser_dependency() -> None:
    command_dir = Path("sprintengine_core/tool/commands")
    for path in command_dir.glob("*.py"):
        if path.name == "__init__.py":
            continue
        source = path.read_text(encoding="utf-8")
        assert "sprintengine_core.tool.cli_parser" not in source


def test_required_helper_domains_are_rehomed_outside_the_parser() -> None:
    assert phase_prompts.build_rework_prompt.__module__ == "sprintengine_core.tool.phase_prompts"
    assert phase_prompts.build_phase_directive.__module__ == "sprintengine_core.tool.phase_prompts"
    assert plans.plan_path_for_state.__module__ == "sprintengine_core.tool.plans"
    assert plans.source_path_for_kind.__module__ == "sprintengine_core.tool.plans"
    assert artifacts.normalize_artifact_path.__module__ == "sprintengine_core.tool.artifacts"
    assert artifacts.build_artifact_from_args.__module__ == "sprintengine_core.tool.artifacts"
    assert feedback.build_feedback_payload.__module__ == "sprintengine_core.tool.feedback"
    assert tasks.publish_task.__module__ == "sprintengine_core.tool.tasks"


def test_role_validation_resolves_the_registry_at_call_time() -> None:
    """No import-time role snapshot survives (MC-1829): every check discovers."""
    assert "developer" in configured_role_ids()
    assert is_configured_role("developer")
    assert not is_configured_role("marketer")


def test_custom_registry_roles_are_dispatchable(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(workspace, "marketer", label="Marketer")

    discovery = discover_role_registry(workspace_root=workspace)

    assert "marketer" in configured_soul_role_ids(discovery)
    assert "marketer" in dispatchable_role_ids(discovery)
    # …and only for that discovery: the ambient registry still does not know it.
    assert not is_configured_role("marketer")
