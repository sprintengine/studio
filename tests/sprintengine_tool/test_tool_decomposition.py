from pathlib import Path

import sprintengine_core.tool as tool
from sprintengine_core.tool import artifacts, feedback, plans, review_prompts, tasks
from sprintengine_core.role_registry import RoleSkillRegistry
from sprintengine_core.tool.roles import DEFAULT_ROLE_REGISTRY, VALID_ROLES, configured_soul_role_ids, dispatchable_role_ids


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


def test_legacy_module_no_longer_owns_command_handler_bodies() -> None:
    assert tool.cmd_join.__module__ == "sprintengine_core.tool.commands.run"
    assert tool.cmd_task_next.__module__ == "sprintengine_core.tool.commands.task"
    assert tool.cmd_plan_add_task.__module__ == "sprintengine_core.tool.commands.plan"
    assert tool.cmd_artifact_add.__module__ == "sprintengine_core.tool.commands.artifact"


def test_command_modules_import_focused_helpers_without_legacy_dependency() -> None:
    command_dir = Path("sprintengine_core/tool/commands")
    for path in command_dir.glob("*.py"):
        if path.name == "__init__.py":
            continue
        source = path.read_text(encoding="utf-8")
        assert "sprintengine_core.tool.legacy" not in source


def test_required_helper_domains_are_rehomed_outside_legacy() -> None:
    assert review_prompts.build_rework_prompt.__module__ == "sprintengine_core.tool.review_prompts"
    assert review_prompts.build_gate_review_prompt.__module__ == "sprintengine_core.tool.review_prompts"
    assert plans.build_plan_review_prompt.__module__ == "sprintengine_core.tool.plans"
    assert plans.plan_path_for_state.__module__ == "sprintengine_core.tool.plans"
    assert plans.source_path_for_kind.__module__ == "sprintengine_core.tool.plans"
    assert artifacts.normalize_artifact_path.__module__ == "sprintengine_core.tool.artifacts"
    assert artifacts.build_artifact_from_args.__module__ == "sprintengine_core.tool.artifacts"
    assert feedback.build_feedback_payload.__module__ == "sprintengine_core.tool.feedback"
    assert tasks.publish_task.__module__ == "sprintengine_core.tool.tasks"


def test_role_validation_uses_compatibility_registry() -> None:
    assert VALID_ROLES == DEFAULT_ROLE_REGISTRY.all()
    assert DEFAULT_ROLE_REGISTRY.is_valid("developer")
    assert not DEFAULT_ROLE_REGISTRY.is_valid("marketer")


def test_configured_souls_are_separate_from_dispatchable_roles(tmp_path: Path) -> None:
    root = tmp_path / "workspace" / ".sprintengine"
    (root / "roles").mkdir(parents=True)
    (root / "skills" / "marketer").mkdir(parents=True)
    (root / "roles" / "marketer.json").write_text(
        '{"id":"marketer","label":"Marketer","soul":[{"skill":"marketer"}]}',
        encoding="utf-8",
    )
    (root / "skills" / "marketer" / "SKILL.md").write_text("# Marketer\n\nLaunch campaigns.", encoding="utf-8")

    discovery = RoleSkillRegistry(
        workspace_root=tmp_path / "workspace",
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover()

    assert "marketer" in configured_soul_role_ids(discovery)
    assert "marketer" not in dispatchable_role_ids()
    assert "marketer" not in VALID_ROLES
