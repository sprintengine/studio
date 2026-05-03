from __future__ import annotations

from pathlib import Path

from tests.multiloop_tool.test_m1_cli import MultiloopCli, write_state
from tests.multiloop_tool.test_m3_prompt_generation import blocked_m3_state, m3_state


def test_active_milestone_prompt_keeps_required_m3_context_visible(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m3-regression" / "state.json"
    write_state(state_path, m3_state())
    cli = MultiloopCli(tmp_path, state_path)

    prompt = cli.run("milestone", "plan-next").stdout

    assert "Final goal: Ship Multiloop prompt generation without expanding the full roadmap." in prompt
    assert "Active milestone: M1 [active]: Coordinator and role prompts" in prompt
    assert "Rendered coordinator context from validated state." in prompt
    assert "Prompt rendering should use parsed state, not copied summaries." in prompt
    assert "D1: Keep M3 hidden CLI-only." in prompt
    assert "Next decision: Resolve blockers or choose whether to revise the roadmap before accepting this milestone." in prompt


def test_blocked_milestone_review_prompt_requires_blocked_verdict_guidance(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m3-blocked-regression" / "state.json"
    write_state(state_path, blocked_m3_state())
    cli = MultiloopCli(tmp_path, state_path)

    plan_prompt = cli.run("milestone", "plan-next").stdout
    review_prompt = cli.run("milestone", "review", "--role", "tester").stdout

    assert "Active milestone: M1 [blocked]: Coordinator and role prompts" in plan_prompt
    assert "Need product verdict before accepting M3" in plan_prompt
    assert "Next decision: Resolve blockers or choose whether to revise the roadmap before accepting this milestone." in plan_prompt
    assert "Verdict: accepted, needs_follow_up, blocked, or revise_scope." in review_prompt
    assert "Blockers:" in review_prompt
    assert "Need product verdict before accepting M3" in review_prompt
