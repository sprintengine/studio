"""Compose-time gating of the studio product layer skills (backlog item 1566).

`multicode_backlog` is injected only into backlog-sourced runs and
`workspace_knowledge` only when the workspace has a Knowledge Graph root, so
inactive features cost zero prompt tokens. Defaults stay fail-open (inject) so
callers without gate context keep the runtime self-gating behavior.
"""

from __future__ import annotations

from helpers import create_team, read_state, task, write_state
from sprintengine_core.skill_layers import (
    SPRINTENGINE_NORM_SKILLS,
    SPRINTENGINE_SOUL_EXTRA_SKILLS,
    knowledge_root_is_configured,
    multicode_layer_skills_for_run,
    run_is_backlog_sourced,
    sprintengine_soul_extra_skills,
)
from sprintengine_mcp.http_server import HttpMcpRunRegistry
from sprintengine_mcp.server import ActorContext


def test_multicode_layer_skills_gate_independently() -> None:
    assert multicode_layer_skills_for_run() == ("multicode_backlog", "workspace_knowledge")
    assert multicode_layer_skills_for_run(backlog_sourced=False) == ("workspace_knowledge",)
    assert multicode_layer_skills_for_run(knowledge_root_configured=False) == ("multicode_backlog",)
    assert multicode_layer_skills_for_run(backlog_sourced=False, knowledge_root_configured=False) == ()


def test_extra_skills_default_to_the_full_layer() -> None:
    # Fail-open contract: no gate context means the historical full list.
    assert sprintengine_soul_extra_skills() == SPRINTENGINE_SOUL_EXTRA_SKILLS


def test_extra_skills_gate_the_product_layer_but_never_the_norms() -> None:
    gated = sprintengine_soul_extra_skills(backlog_sourced=False, knowledge_root_configured=False)
    assert gated == SPRINTENGINE_NORM_SKILLS


def test_run_is_backlog_sourced_reads_source_and_bundle() -> None:
    assert run_is_backlog_sourced({}) is False
    assert run_is_backlog_sourced({"source": {"originalPath": "future-plans/x.md"}}) is False
    assert run_is_backlog_sourced({"source": {"originalPath": "backlog/x.md"}}) is True
    assert run_is_backlog_sourced({"source": {"path": "backlog\\epics\\y.md"}}) is True  # windows separators normalize
    assert run_is_backlog_sourced({"sourceBundle": [{"originalPath": "docs/a.md"}, {"originalPath": "backlog/epics/z.md"}]}) is True
    # A path merely containing the word is not a backlog path.
    assert run_is_backlog_sourced({"source": {"originalPath": "src/backlog-panel/x.ts"}}) is False


def test_knowledge_root_is_configured_reads_env_mapping() -> None:
    assert knowledge_root_is_configured({}) is False
    assert knowledge_root_is_configured({"MULTICODE_KNOWLEDGE_ROOT": "/kg"}) is True
    assert knowledge_root_is_configured({"MULTICODE_MEMORY_ROOT": "/kg"}) is True


def test_cli_join_prompt_gates_backlog_skill_by_run_source(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("MULTICODE_KNOWLEDGE_ROOT", raising=False)
    monkeypatch.delenv("MULTICODE_MEMORY_ROOT", raising=False)
    fixture = create_team(tmp_path, "cli-gate", [task("T1", "Work", "developer")])

    plain = fixture.cli.run("join", "--role", "developer", "--id", "developer-1")
    assert plain["ok"] is True
    assert '<skill name="multicode_backlog">' not in plain["prompt"]
    assert '<skill name="workspace_knowledge">' not in plain["prompt"]

    state = read_state(fixture.state_path)
    state["source"] = {"kind": "markdown", "origin": "reference", "originalPath": "backlog/example.md", "path": "backlog/example.md"}
    write_state(fixture.state_path, state)
    sourced = fixture.cli.run("join", "--role", "developer", "--id", "developer-1")
    assert sourced["ok"] is True
    assert '<skill name="multicode_backlog">' in sourced["prompt"]


def test_http_registration_knowledge_root_is_tri_state(tmp_path) -> None:
    registry = HttpMcpRunRegistry(ActorContext(id="op", role="user", authenticated=True, mcp_authorized=True))
    team = tmp_path / ".sprintengine" / "sprintengine" / "reg"
    team.mkdir(parents=True)
    state_path = team / "run.yaml"
    state_path.write_text("{}", encoding="utf-8")

    def payload(run_id: str, **extra: object) -> dict[str, object]:
        return {
            "runId": run_id,
            "workspaceRoot": str(tmp_path),
            "statePath": str(state_path),
            "allowedRoots": [str(tmp_path)],
            "actorId": "multicode-app",
            **extra,
        }

    absent = registry.register(payload("r-absent"))
    assert absent.context.knowledge_root_configured is None
    empty = registry.register(payload("r-empty", knowledgeRoot=""))
    assert empty.context.knowledge_root_configured is False
    configured = registry.register(payload("r-set", knowledgeRoot=str(tmp_path / "knowledge")))
    assert configured.context.knowledge_root_configured is True
