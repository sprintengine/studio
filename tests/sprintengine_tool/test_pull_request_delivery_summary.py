"""The pull request a sprint opens says which item it delivers, and how it went.

Before this, a reviewer got `SprintEngine: <goal, truncated at 72 chars>...` over a
flat list of task titles: no id to match against the Backlog, no way to tell a
sprint that delivered everything from one that stalled halfway, and nothing about
the work that landed with findings against it. The merge commit was worse — GitHub
fills it from the commit subjects, so `main`'s history recorded a pile of
`SprintEngine T3:` lines instead of the piece of work that landed.

Everything asserted here is read from what a run already records — `source`,
`sourceBundle`, task `status`/`backlogRef`/`evidence`/`feedback`. Nothing is
inferred, and a run that recorded nothing renders no section for it.

The builders are pure functions of state, so these tests are too: no git, no `gh`.
The wiring into `gh pr create` / `gh pr merge` is pinned in
`test_multi_repo_pull_requests.py` and `test_run_worktree.py`.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from sprintengine_core.tool import shell


def _workspace(tmp_path: Path) -> Path:
    """A project root with the run directory a `state_path` points into."""
    (tmp_path / "backlog").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".multi-code" / "sprintengine" / "run").mkdir(parents=True, exist_ok=True)
    state_path = tmp_path / ".multi-code" / "sprintengine" / "run" / "run.yaml"
    state_path.write_text("{}\n", encoding="utf-8")
    return state_path


def _item(tmp_path: Path, slug: str, item_id: str, title: str) -> str:
    """Write a backlog item and return its project-relative path."""
    (tmp_path / "backlog" / f"{slug}.md").write_text(
        f"---\nid: {item_id}\nstatus: open\n---\n\n# {title}\n", encoding="utf-8"
    )
    return f"backlog/{slug}.md"


def _task(task_id: str, title: str, status: str = "done", **extra: Any) -> Dict[str, Any]:
    return {"id": task_id, "title": title, "status": status, **extra}


def _state(tasks: List[Dict[str, Any]], **extra: Any) -> Dict[str, Any]:
    return {"sprintengine": {"goal": "Ship the thing"}, "tasks": tasks, **extra}


# --- the title names the item, not a truncated goal ---------------------------


def test_title_is_the_backlog_item_id_and_its_own_heading(tmp_path) -> None:
    # The `goal` is a paraphrase of the item written at launch; the item's H1 is the
    # sentence the Backlog, the commits, and the humans all use. And the id is the
    # handle — a reviewer scanning the PR list is looking for MC-2141.
    state_path = _workspace(tmp_path)
    path = _item(tmp_path, "mcp-spec", "2141", "The sprintengine MCP surface adopts the 2026-07-28 specification")
    state = _state([], source={"path": path, "planKind": "product_plan"})

    title = shell.build_run_pull_request_title(state, state_path, "sprintengine/mcp")

    assert title == "MC-2141: The sprintengine MCP surface adopts the 2026-07-28 specification"
    # The whole sentence, not the ellipsis the 72-char commit-subject limit produced.
    assert "..." not in title


def test_title_of_a_multi_epic_selection_names_every_epic(tmp_path) -> None:
    # `source` on a selection run is only its FIRST entry, so naming the pull request
    # after it would claim the sprint delivered one epic when it delivered two.
    state_path = _workspace(tmp_path)
    checkout = _item(tmp_path, "checkout-epic", "2200", "Checkout survives a flaky provider")
    search = _item(tmp_path, "search-epic", "2300", "Search returns in under 200ms")
    state = _state(
        [],
        source={"path": checkout, "planKind": "selection"},
        sourceBundle=[{"kind": "epic", "path": checkout}, {"kind": "epic", "path": search}],
    )

    title = shell.build_run_pull_request_title(state, state_path, "sprintengine/two")

    assert title == "MC-2200, MC-2300: Ship the thing"


def test_title_of_a_run_with_no_backlog_source_is_unchanged(tmp_path) -> None:
    # A bare `--goal` run has no item to name. It keeps the title it always had
    # rather than growing an empty `MC-:` prefix.
    state_path = _workspace(tmp_path)

    title = shell.build_run_pull_request_title(_state([]), state_path, "sprintengine/alpha")

    assert title == "SprintEngine: Ship the thing"


def test_title_survives_an_item_that_has_since_been_deleted(tmp_path) -> None:
    # Items get renamed and archived after a sprint ships. That must degrade to the
    # old title, never take the pull request down.
    state_path = _workspace(tmp_path)
    state = _state([], source={"path": "backlog/moved-away.md", "planKind": "epic"})

    assert shell.build_run_pull_request_title(state, state_path, "b") == "SprintEngine: Ship the thing"


# --- the body: ticks, what is missing, and what to look at hardest ------------


def test_delivered_tasks_are_ticked_under_the_item_they_came_from(tmp_path) -> None:
    state_path = _workspace(tmp_path)
    path = _item(tmp_path, "mcp-spec", "2141", "The MCP surface adopts the new spec")
    state = _state(
        [_task("T1", "Stateless mode", role="developer", evidence={"summary": "Real socket, every branch."})],
        source={"path": path, "planKind": "product_plan"},
    )

    body = shell.build_run_pull_request_body(state, "sprintengine/mcp", state_path=state_path)

    assert "## MC-2141 — The MCP surface adopts the new spec" in body
    assert f"`{path}`" in body
    assert "**Delivered: 1 of 1**" in body
    assert "- [x] Stateless mode _(developer)_" in body
    assert "  - Real socket, every branch." in body


def test_outstanding_work_is_listed_unticked_with_the_reason(tmp_path) -> None:
    # The question a delivery summary exists to answer: is it all here? A sprint that
    # stalled on an unanswered question must say so on the pull request, because the
    # diff cannot.
    state_path = _workspace(tmp_path)
    path = _item(tmp_path, "checkout", "2200", "Checkout survives a flaky provider")
    state = _state(
        [
            _task("T1", "Retry the charge"),
            _task(
                "T2",
                "The refund path",
                status="needs_input",
                needsInput={"question": "Do partial refunds re-enter the same provider?"},
            ),
            _task("T3", "Tidy the config", status="in_progress"),
        ],
        source={"path": path, "planKind": "epic"},
    )

    body = shell.build_run_pull_request_body(state, "sprintengine/checkout", state_path=state_path)

    assert "**Delivered: 1 of 3**" in body
    assert "### Not delivered" in body
    assert "- [ ] The refund path — **needs input**" in body
    assert "  - Waiting on: Do partial refunds re-enter the same provider?" in body
    assert "- [ ] Tidy the config — **in progress**" in body


def test_a_canceled_task_is_not_counted_against_the_delivery(tmp_path) -> None:
    # Canceled means the run decided it was not work, not that it was left undone.
    # Counting it would make every sprint that dropped a task read as incomplete.
    state_path = _workspace(tmp_path)
    state = _state([_task("T1", "Ship it"), _task("T2", "Abandoned spike", status="canceled")])

    body = shell.build_run_pull_request_body(state, "sprintengine/alpha", state_path=state_path)

    assert "**Delivered: 1 of 1**" in body
    assert "Abandoned spike" not in body


def test_review_notes_say_a_pass_with_fixes_was_found_and_fixed(tmp_path) -> None:
    # `findings` under `pass_with_fixes` are what the self-review caught AND repaired
    # in the same pass — their titles say so ("...; now typing.cast"). Reporting them
    # as open would send a reviewer hunting for problems that are not there.
    state_path = _workspace(tmp_path)
    state = _state([
        _task(
            "T1",
            "Version negotiation",
            feedback={
                "phase": {"outcome": "pass_with_fixes", "phase": "review"},
                "findings": [
                    {"severity": "low", "kind": "code_bug", "status": "open", "title": "unchecked cast; now a type predicate"},
                    {"severity": "medium", "kind": "test_gap", "status": "open", "title": "probed with a live version; now a sentinel"},
                ],
            },
        ),
    ])

    body = shell.build_run_pull_request_body(state, "sprintengine/alpha", state_path=state_path)

    assert "### Review notes" in body
    assert "- **Version negotiation** — self-review found and fixed 2 issues" in body
    # Worst first: the finding that decides where to look leads.
    medium = body.index("`medium` probed with a live version")
    low = body.index("`low` unchecked cast")
    assert medium < low
    assert "_(test_gap)_" in body


def test_a_clean_review_contributes_no_review_notes(tmp_path) -> None:
    # The section is only worth reading if it is empty when there is nothing to say.
    state_path = _workspace(tmp_path)
    state = _state([_task("T1", "Ship it", feedback={"phase": {"outcome": "pass"}, "findings": []})])

    body = shell.build_run_pull_request_body(state, "sprintengine/alpha", state_path=state_path)

    assert "Review notes" not in body


# --- grouping: one heading per epic, and no heading invented ------------------


def test_a_selection_run_gets_one_section_per_epic(tmp_path) -> None:
    # How the work was chosen is how a reviewer reads it back. Children roll up to the
    # epic that scoped them, not to the item each was minted from.
    state_path = _workspace(tmp_path)
    checkout = _item(tmp_path, "checkout-epic", "2200", "Checkout survives a flaky provider")
    search = _item(tmp_path, "search-epic", "2300", "Search returns in under 200ms")
    retry = _item(tmp_path, "retry", "2201", "Retry the charge")
    warmup = _item(tmp_path, "warmup", "2301", "Warm the index")
    state = _state(
        [
            _task("T1", "Retry the charge", backlogRef={"projectRelativePath": retry}),
            _task("T2", "Warm the index", backlogRef={"projectRelativePath": warmup}),
            _task("T3", "Tidy the config", status="in_progress"),
        ],
        source={"path": checkout, "planKind": "selection"},
        sourceBundle=[
            {"kind": "epic", "path": checkout},
            {"kind": "epic", "path": search},
            {"kind": "generic_context", "path": retry, "epicChild": True, "epicSlug": "checkout-epic"},
            {"kind": "generic_context", "path": warmup, "epicChild": True, "epicSlug": "search-epic"},
        ],
    )

    body = shell.build_run_pull_request_body(state, "sprintengine/two", state_path=state_path)

    assert "## MC-2200 — Checkout survives a flaky provider" in body
    assert "## MC-2300 — Search returns in under 200ms" in body
    # A planned task belongs to neither epic, and filing it under whichever epic
    # `source` names first would be a claim about the work that nothing supports.
    assert "## Tasks" in body
    assert body.index("## MC-2200") < body.index("## MC-2300") < body.index("## Tasks")


def test_planned_and_minted_tasks_of_one_item_share_one_heading(tmp_path) -> None:
    # The shape PR 86 had: five planned tasks carrying no `backlogRef` and one minted
    # task carrying it, all delivering the same item. Two headings for one piece of
    # work would read as two.
    state_path = _workspace(tmp_path)
    path = _item(tmp_path, "mcp-spec", "2141", "The MCP surface adopts the new spec")
    state = _state(
        [_task("T1", "Planned work"), _task("T2", "Minted work", backlogRef={"projectRelativePath": path})],
        source={"path": path, "planKind": "product_plan"},
    )

    body = shell.build_run_pull_request_body(state, "sprintengine/mcp", state_path=state_path)

    assert body.count("## MC-2141") == 1
    assert "**Delivered: 2 of 2**" in body


# --- the merge commit says the same thing the pull request does ---------------


def test_merge_message_args_carry_the_title_and_the_summary(tmp_path) -> None:
    # GitHub fills a merge commit from the branch's commit subjects, so `main` recorded
    # a pile of `SprintEngine T3:` lines. The merge the app performs states the item.
    state_path = _workspace(tmp_path)
    path = _item(tmp_path, "mcp-spec", "2141", "The MCP surface adopts the new spec")
    state = _state([_task("T1", "Stateless mode")], source={"path": path, "planKind": "product_plan"})
    repo = {"id": "primary", "branchName": "sprintengine/mcp"}

    args = shell._merge_message_args(state, state_path, repo, "squash")

    assert args[0] == "--subject"
    assert args[1] == "MC-2141: The MCP surface adopts the new spec"
    assert args[2] == "--body"
    assert "- [x] Stateless mode" in args[3]


def test_a_rebase_merge_is_given_no_message_flags(tmp_path) -> None:
    # A rebase writes no merge commit, and `gh` rejects the flags there rather than
    # ignoring them — passing them would turn a working merge into a failed one.
    state_path = _workspace(tmp_path)
    state = _state([_task("T1", "Stateless mode")])

    assert shell._merge_message_args(state, state_path, {"id": "primary", "branchName": "b"}, "rebase") == []
