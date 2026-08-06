"""Plan, source bundle, approval gate, and summary helpers."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.artifacts import *  # noqa: F403,F401
from sprintengine_core.tool.common import path_is_relative_to, unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import MULTICODE_DIR_NAME, SPRINTENGINE_DIR_NAME, now_iso
from sprintengine_core.tool.state import *  # noqa: F403,F401
from sprintengine_core.tool.tasks import *  # noqa: F403,F401

SOURCE_KIND_LABELS = {
    "product_plan": "Product plan",
    "architect_plan": "Implementation plan",
    "epic": "Epic",
    "html_mockup": "HTML mockup",
    "design_notes": "Design notes",
    "plan_overview": "Plan overview",
    "generic_context": "Context",
    "selection": "Selection",
    "unknown": "Source context",
}

SOURCE_CONTEXT_HEADING = "Incoming source context for this run:"

# A source-bundle entry that IS one of a launched epic's child items, rather
# than supporting reading material (a mockup, a design system note). Set by the
# launch paths (backlog item 2018): the desktop panel marks each child it seeds,
# and an `--source-plan-kind epic` handover marks every `--source` it is given,
# because on that flag combination the bundle IS the children. Without the
# marker the planner cannot tell a child it must deliver from a document it must
# merely read, and the coverage warning has nothing to count.
EPIC_CHILD_KEY = "epicChild"

EPIC_CHILD_SOURCE_LABEL = "Epic child item"

# The plain-item counterpart on a `selection` run (backlog item 2061): a bundle
# entry that IS a directly-selected backlog item — a unit of work, but not a
# child of any selected epic. A directly-selected child of an UNSELECTED epic is
# a plain item here: `normalize_selection_bundle` settles which marker each work
# entry honestly carries by reading the item's own `epic:` frontmatter, the same
# membership signal the live grep uses.
SELECTED_ITEM_KEY = "selectedItem"

SELECTED_ITEM_SOURCE_LABEL = "Selected item"

# On a selected-epic child entry, the slug of the epic whose membership seeded
# it — recorded at classification time so the per-epic coverage warning groups
# without re-reading files at approval.
EPIC_CHILD_SLUG_KEY = "epicSlug"

# Bundle kinds that are attachments by definition. On a `--source-plan-kind
# selection` handover every other `--source` entry is a selected work item —
# the flag combination means "the bundle is the selection", exactly as `epic`
# means "the bundle is the children".
SELECTION_READING_KINDS = {"html_mockup", "design_notes", "plan_overview"}

# Root plan kinds whose bundle carries an enumerable work list.
WORK_LIST_PLAN_KINDS = {"epic", "selection"}

def plan_path_artifact_value(state_path: Path) -> str:
    return normalize_artifact_path(state_path, "plan.md")["path"]

def product_intake_path_artifact_value(state_path: Path) -> str:
    return normalize_artifact_path(state_path, "product-requirements.md")["path"]

def product_intake_handover_note(state_path: Path) -> Optional[str]:
    handover_path = handover_path_for_state(state_path)
    if not handover_path.exists():
        return None
    handover_path_value = project_relative_display_path(state_path, handover_path)
    return f"Read `{handover_path_value}` as incoming context before writing product-requirements.md."

def source_plan_kind(state: Dict[str, Any]) -> str:
    source = state.get("source")
    if not isinstance(source, dict):
        return "unknown"
    value = str(source.get("planKind") or "unknown").strip()
    return value if value in VALID_SOURCE_PLAN_KINDS else "unknown"

def source_bundle_items(state: Dict[str, Any], kind: Optional[str] = None) -> List[Dict[str, Any]]:
    raw = state.get("sourceBundle")
    if not isinstance(raw, list):
        return []
    items = [item for item in raw if isinstance(item, dict)]
    if kind is None:
        return items
    return [item for item in items if item.get("kind") == kind]

def epic_child_source_items(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Seeded epic-child items, in seed order — part of the sprint's work list.

    Only meaningful when the root plan kind carries a work list (`epic`, or a
    `selection` whose bundle includes epics): the plan kind is what makes the
    bundle a list of work rather than a reading list, so a marked entry on any
    other run is ignored rather than silently promoted.
    """
    if source_plan_kind(state) not in WORK_LIST_PLAN_KINDS:
        return []
    return [item for item in source_bundle_items(state) if item.get(EPIC_CHILD_KEY) is True]

def epic_child_source_paths(state: Dict[str, Any]) -> List[str]:
    return unique_strings([str(item.get("path") or "") for item in epic_child_source_items(state)])

def selected_item_source_items(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Directly-selected plain items on a `selection` run (backlog item 2061)."""
    if source_plan_kind(state) != "selection":
        return []
    return [item for item in source_bundle_items(state) if item.get(SELECTED_ITEM_KEY) is True]

def selected_item_source_paths(state: Dict[str, Any]) -> List[str]:
    return unique_strings([str(item.get("path") or "") for item in selected_item_source_items(state)])

def selection_work_entry_paths(state: Dict[str, Any]) -> List[str]:
    """Every seeded work entry, deduped by path: one minted task per entry."""
    return unique_strings([*epic_child_source_paths(state), *selected_item_source_paths(state)])

def selected_epic_source_items(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The selected epics themselves — membership scopes, never work entries."""
    if source_plan_kind(state) != "selection":
        return []
    return source_bundle_items(state, "epic")

def selected_epic_slugs(state: Dict[str, Any]) -> List[str]:
    return unique_strings([
        Path(str(item.get("path") or "")).stem for item in selected_epic_source_items(state)
    ])

def backlog_item_epic_slug(path: Path) -> str:
    """The `epic:` frontmatter value of a backlog item file, or empty.

    The same membership signal as the live pass (`grep -l "^epic: <slug>$"`),
    read once at classification time.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    for line in lines[1:]:
        if line.strip() == "---":
            break
        match = re.match(r"^epic:\s*(\S+)\s*$", line)
        if match:
            return match.group(1)
    return ""

# Child statuses that are not work: the same skip rule the planning agent was
# given in prose, now executed by the engine. `idea` is deliberately here — an
# unshaped idea is not something a worker can pick up and finish.
CLOSED_CHILD_STATUSES = {"completed", "archived", "idea"}

VALID_RUN_INTAKES = {"direct", "planned"}


def run_intake(state: Dict[str, Any]) -> str:
    """This run's intake, as recorded. Empty when the run predates the field."""
    value = str(state.get("sprintengine", {}).get("intake") or "").strip()
    return value if value in VALID_RUN_INTAKES else ""


def epic_source_dependencies_planned(state: Dict[str, Any], state_path: Path) -> bool:
    """Has this run's epic source declared its child ordering finished (MC-2137)?

    The epic's own `dependenciesPlanned: true` frontmatter, and nothing else. It
    is what separates the two meanings of "no `dependsOn` edges": deliberately
    parallel (marked) from never ordered (unmarked). An assertion of intent — the
    engine reads it, never derives or writes it.
    """
    if source_plan_kind(state) != "epic":
        return False
    frontmatter = backlog_item_frontmatter(source_path_for_kind(state, state_path, "epic"))
    for key, value in frontmatter.items():
        if key.lower() == "dependenciesplanned":
            return str(value).strip().strip("'\"").lower() == "true"
    return False


def resolve_run_intake(
    state: Dict[str, Any],
    requested: Optional[str],
    has_epic_source: bool,
    epic_dependencies_planned: bool = False,
) -> str:
    """Settle and persist the run's intake (MC-2128, gated by MC-2137).

    Fixed at run creation, like the worktree toggle and the repo set, and for the
    same reason: by the second init the task graph already exists, and flipping a
    directly-imported run to `planned` would both misdescribe how its graph was
    built and open a plan gate over a graph that needs no approval. So what the
    run already recorded wins; then what the caller asked for; then the default —
    `direct` for an epic source **whose ordering is marked done**, `planned` for
    everything else.

    The mark (MC-2137) moves planning out of the engine: an epic is ordered on the
    backlog, by a human or an agent they chose, and `dependenciesPlanned: true` is
    the handshake saying that pass is over. Without it, "no edges" might mean
    "never ordered", so the run plans first. The gate INFORMS, never blocks — an
    explicit `--intake direct` on an unmarked epic still runs direct, and says so.

    Recording it makes the choice readable by the board and by later inits rather
    than re-derived from the source shape every time.
    """
    requested_value = str(requested or "").strip()
    if requested_value and requested_value not in VALID_RUN_INTAKES:
        raise SystemExit(
            f"--intake must be one of: {', '.join(sorted(VALID_RUN_INTAKES))}."
        )
    recorded = run_intake(state)
    default_intake = "direct" if (has_epic_source and epic_dependencies_planned) else "planned"
    intake = recorded or requested_value or default_intake
    # An explicit `direct` over an epic that never declared its ordering done is
    # honoured (warn-not-block, owner 2026-08-05) and recorded as an event, so the
    # board and the run log say the items ran unordered on purpose. Only on the
    # FIRST init: a re-init of a settled run is not a fresh choice to warn about.
    if (
        intake == "direct"
        and has_epic_source
        and not epic_dependencies_planned
        and not recorded
    ):
        append_event(
            state,
            "intake_epic_unplanned",
            "sprintengine",
            "Direct intake over an epic that is not marked `dependenciesPlanned: true` — "
            "its ordering was never declared finished, so the imported items run "
            "unordered, all claimable at once. Mark the epic once its children's "
            "`dependsOn` order is authored (no edges at all is a valid answer: it "
            "means deliberately parallel).",
        )
    # Direct intake only exists for an epic source — with no epic there is no
    # authored order to import, so a requested `direct` DOWNGRADES to planned
    # (warn-not-block, owner 2026-08-05) instead of falling through to a plan
    # gate while the run store records an intake that never ran. The persisted
    # value is the EFFECTIVE intake, never the requested one.
    if intake == "direct" and not has_epic_source:
        intake = "planned"
        append_event(
            state,
            "intake_downgraded",
            "sprintengine",
            "Direct intake was requested but the source is not a single epic — "
            "the run plans first. Direct intake imports an epic's authored "
            "dependency order; a selection or goal has none to import.",
        )
    state.setdefault("sprintengine", {})["intake"] = intake
    return intake


def backlog_item_frontmatter(path: Path) -> Dict[str, str]:
    """The frontmatter fields of a backlog item, or ``{}``.

    Deliberately not a YAML parse: these files carry flat scalars, and depending on
    a YAML library here would make the engine's task graph hostage to a parser the
    backlog format never needed. Block lists ARE folded in, because `dependsOn` is
    authored both ways in this repo:

        dependsOn: slug-a, slug-b        ->  "slug-a, slug-b"
        dependsOn:                       ->  "slug-a, slug-b"
          - slug-a
          - slug-b

    A block list collapses to the comma form so both spellings leave one shape for
    the caller to read.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields: Dict[str, str] = {}
    pending_list_key = ""
    for line in lines[1:]:
        if line.strip() == "---":
            break
        list_entry = re.match(r"^\s+-\s*(.+?)\s*$", line)
        if pending_list_key and list_entry:
            existing = fields.get(pending_list_key, "")
            value = list_entry.group(1).strip().strip("'\"")
            fields[pending_list_key] = f"{existing}, {value}" if existing else value
            continue
        match = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$", line)
        if not match:
            pending_list_key = ""
            continue
        key, value = match.group(1), match.group(2)
        fields[key] = value
        # An empty value opens a possible block list on the following lines.
        pending_list_key = key if not value else ""
    return fields


def backlog_item_title(path: Path) -> str:
    """The item's first H1 — the minted task's title (backlog item 2018).

    Falls back to the slug when the file has no heading, so a malformed item
    still yields a task a human can recognise rather than an empty card.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return path.stem
    for line in text.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            if title:
                return title
    return path.stem


def _frontmatter_slug_list(value: str) -> List[str]:
    """`dependsOn:` as a list of item SLUGS.

    Accepts every spelling this repo's items actually use — `a, b`, `[a, b]`, and
    the block-list form folded to commas by the reader above — and reduces each
    entry to its slug, so a dependency authored as a full path
    (`backlog/checkout-total.md`) and one authored as a bare slug
    (`checkout-total`) resolve to the same sibling.
    """
    cleaned = str(value or "").strip().strip("[]")
    slugs: List[str] = []
    for part in cleaned.split(","):
        entry = part.strip().strip("'\"")
        if entry:
            slugs.append(Path(entry).stem)
    return slugs


def epic_child_import_entries(state: Dict[str, Any], state_path: Path) -> List[Dict[str, Any]]:
    """One record per seeded epic child, in seed order.

    The deterministic half of what the planning agent used to read every child in
    full to produce: slug, title, status, and declared dependencies. Nothing here
    needs judgement, which is the whole argument of this mode.
    """
    entries: List[Dict[str, Any]] = []
    for item in epic_child_source_items(state):
        path_value = str(item.get("path") or "").strip()
        if not path_value:
            continue
        absolute = source_item_absolute_path(state_path, item, path_value)
        frontmatter = backlog_item_frontmatter(absolute)
        entries.append({
            # `backlogRef` and `sourceDocs` are project-root-relative by contract,
            # and a bundle entry is not guaranteed to be — the MCP handover path
            # records absolutes when the server's cwd is not the project. Re-derive
            # rather than trusting the seeded spelling; an absolute would otherwise
            # fail validation and take the whole init down with it.
            "path": project_relative_display_path(state_path, absolute),
            "slug": Path(path_value).stem,
            "title": backlog_item_title(absolute),
            "status": str(frontmatter.get("status") or "").strip().lower(),
            "dependsOn": _frontmatter_slug_list(frontmatter.get("dependsOn", "")),
            "absolutePath": absolute,
        })
    return entries


def _outside_item_is_satisfied(state_path: Path, entry: Dict[str, Any], slug: str) -> bool:
    """Is a `dependsOn` slug outside this sprint already finished?

    A completed item is a dependency that is met, so its edge is simply absent.
    An open one is a real gap the run should say out loud — but never a reason to
    refuse creation, which would make one stale frontmatter line block a sprint.
    """
    sibling = Path(entry["absolutePath"]).with_name(f"{slug}.md")
    status = str(backlog_item_frontmatter(sibling).get("status") or "").strip().lower()
    return status in {"completed", "archived"}


def mint_epic_child_tasks(
    state: Dict[str, Any], state_path: Path, actor: str = "sprintengine"
) -> Dict[str, Any]:
    """Mint one `kind: work` task per OPEN epic child, deterministically.

    The mode itself (MC-2128). The epic and its children are already an ordered,
    human-authored plan; an agent re-deriving that graph read every child in full
    and replayed a loop the engine can execute for nothing. This is that loop.

    Task shape follows backlog item 2018 exactly: title from the item's H1,
    `backlogRef` and `sourceDocs` pointing at the item, and NO description,
    acceptance, or implementation notes — the item is the spec, injected into the
    worker's claim prompt in full, so restating it only creates a second version
    to drift. No `ownedPaths` either: publish scope comes from what the task
    actually changed (MC-2127), which is why that landed first.

    Returns the minted tasks, the children skipped as closed, and warnings for
    dependencies that could not be resolved.
    """
    entries = epic_child_import_entries(state, state_path)
    # Re-init is idempotent: a child already carried by a task is not minted twice.
    # `assert_backlog_ref_unclaimed` enforces one-task-per-item at write time; this
    # is the same rule applied before writing, so a second init is a clean no-op
    # rather than a refusal.
    already_imported = _delivered_backlog_paths(state)
    entries = [entry for entry in entries if entry["path"].replace("\\", "/") not in already_imported]
    open_entries = [entry for entry in entries if entry["status"] not in CLOSED_CHILD_STATUSES]
    skipped = [entry for entry in entries if entry["status"] in CLOSED_CHILD_STATUSES]

    minted: List[Dict[str, Any]] = []
    task_id_by_slug: Dict[str, str] = {}
    warnings: List[str] = []
    for entry in open_entries:
        if Path(entry["path"]).is_absolute():
            # The item lives outside this project, so there is no reference a task
            # could carry. Say so and move on: one stray bundle entry must not stop
            # a sprint from being created.
            warnings.append(
                f"Child `{entry['slug']}` resolves outside this project ({entry['path']}) and was not "
                "imported. Move it into the project's backlog, or add its task by hand."
            )
            continue
        task_id = next_task_id(state.get("tasks", []))
        task = normalize_task({
            "id": task_id,
            "title": entry["title"],
            "kind": "work",
            "status": "todo",
            "ownerAgentId": None,
            "dependsOn": [],
            "backlogRef": {"projectRelativePath": entry["path"]},
            "sourceDocs": [entry["path"]],
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
            "notes": [],
            "startedAt": None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(task)
        minted.append(task)
        task_id_by_slug[entry["slug"]] = task_id
        append_event(state, "task_added", actor, f"{actor} added {task_id}: {task['title']}.")

    # Edges second: a child may depend on one seeded after it, so every sibling
    # must already have an id before any edge is resolved.
    imported_entries = [entry for entry in open_entries if not Path(entry["path"]).is_absolute()]
    for entry, task in zip(imported_entries, minted):
        for slug in entry["dependsOn"]:
            sibling_id = task_id_by_slug.get(slug)
            if sibling_id:
                add_unique_values(task, "dependsOn", [sibling_id])
                continue
            if _outside_item_is_satisfied(state_path, entry, slug):
                continue
            warnings.append(
                f"{task['id']} ({entry['slug']}) declares `dependsOn: {slug}`, which is not in this "
                "sprint and is not completed. The task was created with no edge for it — check "
                "whether it can actually run."
            )

    for warning in warnings:
        append_event(state, "epic_import_warning", actor, warning)
    if minted:
        append_event(
            state,
            "epic_imported",
            actor,
            f"{actor} imported {len(minted)} task(s) from the epic's children"
            + (f", skipping {len(skipped)} closed item(s)" if skipped else "")
            + ".",
            {"taskIds": [task["id"] for task in minted]},
        )
    return {"tasks": minted, "skipped": skipped, "warnings": warnings}


def normalize_selection_bundle(state: Dict[str, Any], state_path: Path) -> None:
    """Settle a `selection` bundle's work entries: dedupe, then classify.

    Runs on both launch paths (handover-built bundles and app-seeded
    `--source-bundle-json`) and is idempotent. Work entries are deduped by
    normalized path — a selection containing an epic AND one of its own
    children must not list that child twice (`assert_backlog_ref_unclaimed`
    refuses the double mint at write time; the dedupe keeps the planner's
    enumerable list from asking for it). Each surviving work entry then gets
    exactly one honest marker: `epicChild` (+ `epicSlug`) when its own `epic:`
    frontmatter names a selected epic, `selectedItem` otherwise — so a
    directly-selected child of an unselected epic reads as the plain item it
    is here. Unmarked entries are reading material and are left alone.
    """
    if source_plan_kind(state) != "selection":
        return
    bundle = source_bundle_items(state)
    if not bundle:
        return
    slugs = set(selected_epic_slugs(state))
    deduped: List[Dict[str, Any]] = []
    by_path: Dict[str, Dict[str, Any]] = {}
    for item in bundle:
        path_value = str(item.get("path") or "").replace("\\", "/")
        kept = by_path.get(path_value) if path_value else None
        if kept is None:
            by_path[path_value] = item
            deduped.append(item)
            continue
        # A duplicate contributes only its work-ness; the first entry stays.
        if item.get(EPIC_CHILD_KEY) is True or item.get(SELECTED_ITEM_KEY) is True:
            kept[SELECTED_ITEM_KEY] = True
    for item in deduped:
        if item.get("kind") == "epic":
            # A selected epic is a membership scope, not a work entry.
            item.pop(EPIC_CHILD_KEY, None)
            item.pop(SELECTED_ITEM_KEY, None)
            item.pop(EPIC_CHILD_SLUG_KEY, None)
            continue
        if not (item.get(EPIC_CHILD_KEY) is True or item.get(SELECTED_ITEM_KEY) is True):
            continue
        path_value = str(item.get("path") or "")
        slug = backlog_item_epic_slug(source_item_absolute_path(state_path, item, path_value))
        if slug and slug in slugs:
            item[EPIC_CHILD_KEY] = True
            item[EPIC_CHILD_SLUG_KEY] = slug
            item.pop(SELECTED_ITEM_KEY, None)
        else:
            item[SELECTED_ITEM_KEY] = True
            item.pop(EPIC_CHILD_KEY, None)
            item.pop(EPIC_CHILD_SLUG_KEY, None)
    state["sourceBundle"] = deduped

def _delivered_backlog_paths(state: Dict[str, Any]) -> set[str]:
    delivered: set[str] = set()
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict) or task.get("status") == "canceled":
            continue
        backlog_ref = task.get("backlogRef")
        if isinstance(backlog_ref, dict):
            delivered.add(str(backlog_ref.get("projectRelativePath") or ""))
    return delivered

def epic_child_coverage_warnings(state: Dict[str, Any]) -> List[str]:
    """Advisory: a seeded work item that no task delivers (items 2018, 2061).

    One task per item is the planning contract, and `backlogRef` is the only
    field that records "this task IS that item" — so an unreferenced item means
    either work nobody planned or a pointer nobody set. Advisory, never a block:
    a docs-only or deliberately partial plan is legitimate, and the point is that
    the gap is a visible decision rather than an accident. Canceled tasks do not
    count as coverage. An epic-sourced run keeps its single aggregate warning; a
    selection warns per selected epic, plus once for uncovered plain items.
    """
    plan_kind = source_plan_kind(state)
    if plan_kind == "epic":
        children = epic_child_source_paths(state)
        if not children:
            return []
        delivered = _delivered_backlog_paths(state)
        uncovered = [path for path in children if path not in delivered]
        if not uncovered:
            return []
        return [
            "epic_child_uncovered: child item(s) "
            f"{', '.join(uncovered)} are seeded on this run but no task carries them as its "
            "backlogRef. Mint one task per child item and point it at the item, or record in "
            "plan.md why that child is not delivered by this sprint."
        ]
    if plan_kind != "selection":
        return []
    delivered = _delivered_backlog_paths(state)
    warnings: List[str] = []
    children = epic_child_source_items(state)
    for slug in [*selected_epic_slugs(state), ""]:
        uncovered = unique_strings([
            str(item.get("path") or "")
            for item in children
            if str(item.get(EPIC_CHILD_SLUG_KEY) or "") == slug
            and str(item.get("path") or "") not in delivered
        ])
        if not uncovered:
            continue
        epic_clause = f"epic `{slug}` child item(s)" if slug else "child item(s)"
        warnings.append(
            f"epic_child_uncovered: {epic_clause} "
            f"{', '.join(uncovered)} are seeded on this run but no task carries them as its "
            "backlogRef. Mint one task per child item and point it at the item, or record in "
            "plan.md why that child is not delivered by this sprint."
        )
    uncovered_plain = [path for path in selected_item_source_paths(state) if path not in delivered]
    if uncovered_plain:
        warnings.append(
            "selected_item_uncovered: selected item(s) "
            f"{', '.join(uncovered_plain)} are seeded on this run but no task carries them as its "
            "backlogRef. Mint one task per selected item and point it at the item, or record in "
            "plan.md why that item is not delivered by this sprint."
        )
    return warnings

def state_has_source_kind(state: Dict[str, Any], kind: str) -> bool:
    if source_bundle_items(state, kind):
        return True
    return source_plan_kind(state) == kind

def source_items_for_kind(state: Dict[str, Any], kind: str) -> List[Dict[str, Any]]:
    items = list(source_bundle_items(state, kind))
    source = state.get("source")
    if isinstance(source, dict) and source_plan_kind(state) == kind:
        items.append(source)
    return items

def source_kind_is_reference(state: Dict[str, Any], kind: str) -> bool:
    # A kind is reference-sourced only when every source of that kind points at
    # a canonical original (origin "reference"). Mixed copy/reference sources
    # fall back to the copy path so no source silently loses its seed.
    items = source_items_for_kind(state, kind)
    return bool(items) and all(item.get("origin") == "reference" for item in items)

def reference_source_display_path(state: Dict[str, Any], kind: str) -> str:
    for item in source_items_for_kind(state, kind):
        if item.get("origin") != "reference":
            continue
        path_value = str(item.get("path") or "").strip()
        if path_value:
            return path_value
    return ""

def source_item_absolute_path(state_path: Path, item: Dict[str, Any], path_value: str) -> Path:
    # Reference sources store a project-root-relative path to the canonical
    # original (which lives outside the team folder), so resolve them against the
    # repository root. Copy sources live under the team folder and resolve via the
    # standard artifact path logic.
    if item.get("origin") == "reference":
        root = repository_root_for_state(state_path)
        primary = (root / path_value).resolve()
        if primary.exists():
            return primary
        # Tolerant retry (MC-1697): a reference authored `mockups/x.html` (no
        # `backlog/` prefix) actually lives at `backlog/mockups/x.html`. A single
        # missing prefix once made the one artifact carrying the requirement
        # invisible, and the wrong architecture shipped — so before reporting a
        # reference missing, retry it under `backlog/`. Only the primary is
        # returned when neither resolves, so the miss is reported against the
        # authored path.
        normalized = str(path_value).replace("\\", "/").lstrip("/")
        if normalized and not normalized.startswith("backlog/"):
            fallback = (root / "backlog" / normalized).resolve()
            if fallback.exists():
                return fallback
        return primary
    return artifact_absolute_path(state_path, path_value)

def source_path_for_kind(state: Dict[str, Any], state_path: Path, kind: str) -> Path:
    bundle_item = next(iter(source_bundle_items(state, kind)), None)
    if bundle_item:
        item_path = str(bundle_item.get("path") or "").strip()
        if item_path:
            return source_item_absolute_path(state_path, bundle_item, item_path)
    source = state.get("source")
    if isinstance(source, dict) and source_plan_kind(state) == kind:
        source_path_value = str(source.get("path") or "").strip()
        if source_path_value:
            return source_item_absolute_path(state_path, source, source_path_value)
    return handover_path_for_state(state_path)

def import_source_to_team_file(state: Dict[str, Any], state_path: Path, kind: str, filename: str) -> bool:
    source_path = source_path_for_kind(state, state_path, kind)
    if not source_path.is_file():
        return False
    destination = state_path.parent / filename
    if destination.exists():
        return False
    destination.write_text(source_path.read_text(encoding="utf-8").rstrip() + "\n", encoding="utf-8")
    return True

def refresh_artifact_fingerprint(artifact: Dict[str, Any], state_path: Path) -> None:
    if artifact.get("status") == "approved":
        return
    absolute_path = artifact_absolute_path(state_path, str(artifact.get("path", "")))
    fingerprint = file_fingerprint(absolute_path)
    if artifact.get("fingerprint") == fingerprint:
        return
    artifact["fingerprint"] = fingerprint
    artifact["updatedAt"] = now_iso()

def source_bundle_reference_notes(state: Dict[str, Any], state_path: Optional[Path] = None) -> List[str]:
    notes: List[str] = []
    for item in source_bundle_items(state):
        kind = str(item.get("kind") or "").strip()
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        # Dangling-acceptance-reference guard (MC-1697): a reference source whose
        # path resolves to no file — even after the tolerant `backlog/` retry in
        # source_item_absolute_path — means the artifact carrying the requirement
        # may be invisible. Surface it (shown, never dropped) and name the
        # escalation the architect contract requires, so auto-run never quietly
        # builds to the spec text when the acceptance reference is gone.
        if state_path is not None and item.get("origin") == "reference":
            if not source_item_absolute_path(state_path, item, path).exists():
                notes.append(
                    f"WARNING — source reference `{path}` could not be found at the repository root or under "
                    "`backlog/`. A missing acceptance reference means the spec text may not carry the full intent: "
                    "raise needs_input(user) before building to the spec text, even under auto-run, rather than "
                    "assuming the spec is self-sufficient."
                )
        if kind == "html_mockup":
            notes.append(
                f"Use source mockup `{path}` as the primary UI reference for relevant frontend/UI tasks. "
                "Put this path in those tasks' implementationNotes, not ownedPaths, unless the mockup itself must be edited."
            )
        elif kind == "design_notes":
            notes.append(
                f"Use design notes `{path}` as reference for relevant UI/frontend tasks. "
                "Put this path in those tasks' implementationNotes, not ownedPaths, unless the notes themselves must be edited."
            )
        elif kind == "plan_overview":
            notes.append(
                f"`{path}` is a human-oriented HTML overview of the accepted plan. "
                "Consult it for system shape if useful, but treat the markdown plan as the implementation source of truth. Never edit it."
            )
        elif kind == "product_plan":
            notes.append(
                f"`{path}` is the accepted product source of truth — build scope comes from it; do not re-litigate decisions it records."
            )
        elif kind == "architect_plan":
            notes.append(
                f"`{path}` is the accepted implementation contract — validate task breakdowns against it before creating cards."
            )
        elif kind in {"generic_context", "unknown"}:
            notes.append(f"Review source context `{path}` before creating affected task cards.")
    return notes

def workspace_root_for_state_path(state_path: Path) -> Path:
    team_dir = state_path.parent.resolve()
    if (
        team_dir.parent.name == SPRINTENGINE_DIR_NAME
        and team_dir.parent.parent.name == MULTICODE_DIR_NAME
    ):
        return team_dir.parent.parent.parent.resolve()
    return team_dir

def source_context_display_path(state_path: Path, value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    path = Path(raw)
    if not path.is_absolute():
        return raw.replace("\\", "/")
    workspace_root = workspace_root_for_state_path(state_path)
    resolved = path.resolve()
    if path_is_relative_to(resolved, workspace_root):
        return resolved.relative_to(workspace_root).as_posix()
    return ""

def source_context_reference_lines(state: Dict[str, Any], state_path: Path) -> List[str]:
    lines: List[str] = []
    source = state.get("source")
    if isinstance(source, dict):
        source_path = (
            source_context_display_path(state_path, source.get("originalPath"))
            or source_context_display_path(state_path, source.get("path"))
        )
        snapshot_path = source_context_display_path(state_path, source.get("path"))
        plan_kind = str(source.get("planKind") or "unknown").strip()
        label = SOURCE_KIND_LABELS.get(plan_kind, "Root handoff")
        if source_path:
            line = f"- Root handoff ({label}): read `{source_path}`."
            if snapshot_path and snapshot_path != source_path:
                line += f" Sprint Engine snapshot: `{snapshot_path}`."
            lines.append(line)

    for item in source_bundle_items(state):
        kind = str(item.get("kind") or "unknown").strip()
        # An epic's child item is labelled as one wherever the bundle is listed:
        # this list is the planner's enumerable work list (one task per child),
        # and a child sitting under its document kind alongside the mockups is
        # exactly the "undifferentiated reading material" backlog item 2018
        # replaces. The document kind is kept in parentheses — a child that is a
        # product plan still reads as one.
        label = SOURCE_KIND_LABELS.get(kind, kind.replace("_", " ").title())
        if item.get(EPIC_CHILD_KEY) is True and source_plan_kind(state) in WORK_LIST_PLAN_KINDS:
            label = f"{EPIC_CHILD_SOURCE_LABEL} ({label})"
        elif item.get(SELECTED_ITEM_KEY) is True and source_plan_kind(state) == "selection":
            label = f"{SELECTED_ITEM_SOURCE_LABEL} ({label})"
        source_path = (
            source_context_display_path(state_path, item.get("originalPath"))
            or source_context_display_path(state_path, item.get("path"))
        )
        snapshot_path = source_context_display_path(state_path, item.get("path"))
        if not source_path:
            continue
        line = f"- {label}: read `{source_path}`."
        if snapshot_path and snapshot_path != source_path:
            line += f" Sprint Engine snapshot: `{snapshot_path}`."
        lines.append(line)

    return unique_strings(lines)

def source_context_description_block(state: Dict[str, Any], state_path: Path) -> Optional[str]:
    lines = source_context_reference_lines(state, state_path)
    if not lines:
        return None
    return "\n".join([
        SOURCE_CONTEXT_HEADING,
        *lines,
        "Use these explicit source paths; do not infer the backlog item, mockup, or plan source from the team slug.",
    ])

def apply_source_context_to_task(task: Dict[str, Any], state: Dict[str, Any], state_path: Path) -> None:
    block = source_context_description_block(state, state_path)
    if not block:
        return
    description = str(task.get("description") or "").rstrip()
    if SOURCE_CONTEXT_HEADING in description:
        description = description.split(f"\n\n{SOURCE_CONTEXT_HEADING}", 1)[0].rstrip()
    task["description"] = f"{description}\n\n{block}" if description else block
    notes = [
        "Read the explicit incoming source context paths in the task description before producing this artifact.",
        "Do not derive the backlog item, source plan, mockup, or context folder from the Sprint Engine team slug.",
    ]
    add_unique_values(task, "implementationNotes", notes)

# `COORDINATOR_AGENT_ID` lives in `constants` (re-exported here by the star
# import) alongside the roleless worker id prefix: `state.worker_role` has to
# recognise both id shapes and cannot import this module without a cycle.

def resolve_coordinator_seat(state: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """The one seat that plans this run, adjudicates its plan gate, and triages it.

    A seat, not a role. `role` names it only when the run staffs an architect;
    every other run — a pool of plain agents, or a specialist roster with no
    architect — coordinates through a seat with NO role. That is why callers ask
    `actor_is_coordinator` instead of comparing a role to a literal: MC-1585 made
    `architect` the planner-routed lane rather than a role name, and answering
    with a role is what forced a roleless run to invent one to reach the lane.

    Authority is `configuredRoles` (the run's legal role set), not a seated
    roster, so this answers at init before any worker has claimed. Presence of
    the key is what separates the two empty cases, and the store preserves that
    distinction (`sync_state_to_store` writes an explicit `[]` and drops an
    absent value): a run that never recorded an enabled-role set is a legacy or
    headless store that predates roleless runs and keeps the architect seat,
    while a recorded EMPTY set is a deliberate choice of no roles. Every one of
    the 41 runs under `.multi-code/sprintengine/` on 2026-07-31 records a
    non-empty `configuredRoles`, so no run on disk changes seats.
    """
    if not isinstance(state.get("configuredRoles"), list):
        return {"role": "architect", "agentId": "architect"}
    if "architect" in (configured_role_set(state) or set()):
        return {"role": "architect", "agentId": "architect"}
    return {"role": None, "agentId": COORDINATOR_AGENT_ID}

def actor_is_coordinator(state: Dict[str, Any], actor: str) -> bool:
    """Is `actor` the agent holding this run's coordinator seat?

    Id-aware, because a roleless coordinator has no role to interpolate into the
    `<role>-N` match callers used to rebuild for themselves. A named seat still
    answers for every worker the spawner mints into it (`architect`,
    `architect-2`), so the architect path is unchanged.
    """
    clean = str(actor or "").strip()
    if not clean:
        return False
    seat = resolve_coordinator_seat(state)
    if clean == seat["agentId"]:
        return True
    role = seat["role"]
    return bool(role) and (clean == role or clean.startswith(f"{role}-"))

def find_plan_artifact(state: Dict[str, Any], state_path: Path) -> Optional[Dict[str, Any]]:
    """The run's live plan artifact: the `architect_plan` bound to its own plan.md."""
    plan_resolved_path = artifact_absolute_path(state_path, plan_path_artifact_value(state_path))
    for artifact in state.get("artifacts") or []:
        if not isinstance(artifact, dict):
            continue
        candidate_path = str(artifact.get("path") or "")
        if (
            artifact.get("kind") == "architect_plan"
            and artifact.get("status") != "superseded"
            and candidate_path
            and artifact_absolute_path(state_path, candidate_path) == plan_resolved_path
        ):
            return artifact
    return None

def task_is_coordination(state: Dict[str, Any], state_path: Path, task_id: str) -> bool:
    """Is `task_id` this run's coordination job — planning and plan adjudication?

    Answered by the plan artifact's `taskId` binding alone. The gate's `role` is
    on its way out, and its `kind` never marked it: the gate carries `kind: None`
    exactly like ordinary work across all 40 runs on disk.
    """
    clean = str(task_id or "").strip()
    if not clean:
        return False
    artifact = find_plan_artifact(state, state_path)
    return artifact is not None and str(artifact.get("taskId") or "").strip() == clean

COORDINATOR_BRIEF_HEADING = "Coordinating this sprint:"

def coordinator_brief_block(state: Dict[str, Any], state_path: Path) -> str:
    """What coordinating this sprint means, for a coordinator with NO role.

    A roleless seat gets no role directive — that is the point of it — so the one
    agent holding the coordination job would otherwise infer the job from this
    task's acceptance criteria alone. This is the whole instruction layer, and it
    says only what to PRODUCE: the criteria already say what a good plan looks
    like, and `sprintengine_workflow` owns the task mechanics, so neither is
    restated. It states no identity either — a run with no roles must not be
    handed a stand-in persona to reach the seat.

    The starting documents are named by path in the block
    `apply_source_context_to_task` builds, which the caller appends directly under
    this one — the paths are never derived a second time here. A run with no source
    documents plans from its goal instead, so the line says that rather than
    introducing a list that is not coming.
    """
    starting_point = (
        "- Start from the source documents listed below: read each in full, and create one "
        "task per backlog item."
        if source_context_reference_lines(state, state_path)
        else "- Start from this run's goal: create one task for each piece of work it names."
    )
    return "\n".join([
        COORDINATOR_BRIEF_HEADING,
        "You are coordinating this sprint. What you produce is its plan and its task graph.",
        starting_point,
        "- Read the modules those tasks will touch before you order them.",
        "- Work out the dependency order they can run in, and build the task graph.",
        "- Plan the final verification task that proves the pieces fit together. It is ordinary "
        "work with its own owner, not coordination.",
    ])

def apply_coordinator_brief_to_task(task: Dict[str, Any], state: Dict[str, Any], state_path: Path) -> None:
    """Layer the coordinator brief onto this run's coordination task.

    A no-op on every other task and on every run whose coordinator seat has a
    role: an architect already carries its role directive and the
    `sprintengine_architect_workflow` host skill, and its card is unchanged.

    Call it LAST on the card: it owns the tail — the brief, then the source list
    the brief introduces — and rebuilds that tail from the card's own copy every
    time, so it is idempotent and survives the init branches that rewrite the
    description wholesale for a given source shape (`commands/run.py`), which
    re-apply it once they have rebuilt it. A completed gate is left alone: its card
    is the record of a plan already approved, not a brief anyone works from.
    """
    if resolve_coordinator_seat(state)["role"] is not None:
        return
    if task.get("status") == "done":
        return
    if not task_is_coordination(state, state_path, str(task.get("id") or "")):
        return
    description = str(task.get("description") or "").rstrip()
    # Cut back to the card's own copy: everything from the first of the two
    # appended blocks onward, whichever came first. Cutting at the headings rather
    # than the blank line before them matters for a card whose whole description IS
    # an appended block — there is no separator there to match on, and it would
    # grow a second copy on every re-apply.
    appended = [
        index
        for index in (
            description.find(COORDINATOR_BRIEF_HEADING),
            description.find(SOURCE_CONTEXT_HEADING),
        )
        if index != -1
    ]
    if appended:
        description = description[:min(appended)].rstrip()
    block = coordinator_brief_block(state, state_path)
    task["description"] = f"{description}\n\n{block}" if description else block
    # The source list is what the line above it introduces, so it is written back
    # directly under the brief by the one helper that builds it. A run with no
    # source documents is a no-op there, and the brief says so instead.
    apply_source_context_to_task(task, state, state_path)

def find_architect_plan_gate(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    plan_artifact = find_plan_artifact(state, state_path)
    plan_task = find_task_by_id(state, plan_artifact.get("taskId")) if plan_artifact else None

    if plan_task is None:
        # Legacy stores predate the artifact binding and identified the gate as T0
        # plus the planning role. Only a NAMED seat can answer that; a roleless run
        # has carried an artifact binding since its first init, so there is nothing
        # for the fallback to match on.
        seat_role = resolve_coordinator_seat(state)["role"]
        candidate = find_task_by_id(state, "T0")
        if seat_role and candidate and candidate.get("role") == seat_role:
            plan_task = candidate

    return {"task": plan_task, "artifact": plan_artifact}

def apply_plan_gate_dependency(task: Dict[str, Any], state: Dict[str, Any], state_path: Path) -> None:
    """Planned work is gated on plan approval: a newly created task with no
    dependencies roots on the plan-approval gate task (owned by the run's
    coordinator seat), so nothing becomes claimable before the plan is approved
    and the task graph stays rooted at the plan review.
    Tasks created with explicit dependencies are covered transitively — every
    dependency chain terminates at a gated root."""
    if task.get("dependsOn"):
        return
    gate_task = find_architect_plan_gate(state, state_path).get("task")
    if not isinstance(gate_task, dict):
        return
    gate_id = str(gate_task.get("id") or "").strip()
    if not gate_id or gate_id == str(task.get("id") or "").strip():
        return
    task["dependsOn"] = [gate_id]

def ensure_product_intake_gate(state: Dict[str, Any], state_path: Path, actor: str = "product") -> Dict[str, Any]:
    requirements_path_value = product_intake_path_artifact_value(state_path)
    requirements_resolved_path = artifact_absolute_path(state_path, requirements_path_value)
    handover_note = product_intake_handover_note(state_path)
    product_task = None
    product_artifact = None
    created_product_task = False

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        candidate_path = str(artifact.get("path") or "")
        if (
            artifact.get("kind") in {"product_strategy", "requirements"}
            and artifact.get("status") != "superseded"
            and candidate_path
            and artifact_absolute_path(state_path, candidate_path) == requirements_resolved_path
        ):
            product_artifact = artifact
            product_task = find_task_by_id(state, artifact.get("taskId"))
            break

    if product_task is None:
        candidate = find_task_by_id(state, "T0")
        if candidate and candidate.get("role") == "product":
            product_task = candidate

    if product_task is None:
        task_id = "T0" if "T0" not in task_ids(state) else next_task_id(state.get("tasks", []))
        implementation_notes = [
            "Write the artifact at product-requirements.md in the active Sprint Engine team folder.",
            "Use the existing requirements artifact created by sprintengine init; mark it ready after the file exists.",
        ]
        if handover_note:
            implementation_notes.insert(0, handover_note)
        product_task = normalize_task({
            "id": task_id,
            "title": "Define product requirements",
            "description": (
                "Product strategist intake gate for this sprintengine run. Produce a requirements or "
                "product handoff artifact before architect planning begins."
            ),
            "role": "product",
            "status": "todo",
            "ownerAgentId": None,
            "dependsOn": [],
            "ownedPaths": [requirements_path_value],
            # Approval task, not implementation work — see ensure_plan_approval_gate.
            "phases": [],
            "acceptanceCriteria": [
                "Product artifact captures the goal, requirements, constraints, and acceptance expectations.",
                "If no meaningful product strategy is needed, artifact states that clearly and records non-goals and handoff constraints.",
                "Artifact is reviewed by the user and either approved to done or sent back for changes.",
            ],
            "implementationNotes": implementation_notes,
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
            "notes": [],
            "startedAt": None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(product_task)
        created_product_task = True
        append_event(state, "task_added", actor, f"{actor} added {product_task['id']}: {product_task['title']}.")
    elif product_task.get("status") == "in_progress":
        product_task["ownerAgentId"] = product_task.get("ownerAgentId") or actor
        product_task["startedAt"] = product_task.get("startedAt") or now_iso()
        product_task["completedAt"] = None

    if handover_note and product_task.get("status") != "done":
        add_unique_values(product_task, "implementationNotes", [handover_note])

    should_refresh_source_context = (
        created_product_task
        or SOURCE_CONTEXT_HEADING in str(product_task.get("description") or "")
    )
    if product_task.get("status") != "done" and should_refresh_source_context:
        apply_source_context_to_task(product_task, state, state_path)

    if product_task.get("status") in ACTIVE_TASK_STATUSES:
        mint_lease(product_task, actor, "product")
        stamp_task_execution_identity(state, product_task)

    if product_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, requirements_path_value)
        initial_status = "approved" if product_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": "Imported from completed product intake task."})
        product_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            "kind": "requirements",
            "title": "Product Requirements",
            "path": requirements_path_value,
            "status": initial_status,
            "createdBy": actor,
            "taskId": product_task.get("id"),
            "fingerprint": file_fingerprint(absolute_path),
            "reviewHistory": history,
            "recommendedTasks": [],
            "createdAt": now,
            "updatedAt": now,
        }
        if initial_status == "approved":
            product_artifact["approvedBy"] = actor
            product_artifact["approvedAt"] = now
        state.setdefault("artifacts", []).append(product_artifact)
        append_event(state, "artifact_added", actor, f"{actor} registered product requirements artifact {product_artifact['id']}.")
    else:
        product_artifact["taskId"] = product_task.get("id")
        product_artifact["path"] = requirements_path_value
        product_artifact.setdefault("title", "Product Requirements")
        product_artifact.setdefault("createdBy", actor)
        product_artifact.setdefault("reviewHistory", [])
        product_artifact.setdefault("recommendedTasks", [])
        product_artifact.setdefault("createdAt", now_iso())

    return {"task": product_task, "artifact": product_artifact}

def ensure_plan_approval_gate(
    state: Dict[str, Any],
    state_path: Path,
    actor: str = "architect",
    depends_on: Optional[str] = None,
    start_active: bool = True,
) -> Dict[str, Any]:
    plan_path_value = plan_path_artifact_value(state_path)
    # The plan gate belongs to the run's coordinator seat. When the seat is named
    # the copy still reads through that role noun, so every architect run keeps
    # its title, description, and acceptance strings byte-for-byte; a roleless
    # seat drops the noun rather than borrowing one.
    seat = resolve_coordinator_seat(state)
    role = seat["role"]
    plan_noun = f"{role.capitalize()} plan" if role else "Plan"
    plan_authorship = f"{role.capitalize()}-authored active team plan" if role else "Active team plan"
    plan_artifact_title = f"{role.capitalize()} Plan" if role else "Plan"
    role_prefix = f"{role} " if role else ""
    existing_gate = find_architect_plan_gate(state, state_path)
    plan_task = existing_gate["task"]
    plan_artifact = existing_gate["artifact"]
    created_plan_task = False

    if plan_task is None:
        preferred_id = "T1" if depends_on else "T0"
        task_id = preferred_id if preferred_id not in task_ids(state) else next_task_id(state.get("tasks", []))
        plan_task = normalize_task({
            "id": task_id,
            "title": f"Review {role} plan artifact" if role else "Review the plan",
            "description": f"{plan_authorship} at {plan_path_value} and task graph approval gate. Use this exact path; do not read, copy, or overwrite another team's plan.md.",
            # The gate carries the seat's role when the seat has one, and NO role
            # when it does not (MC-2057). Nothing routes on it either way: the
            # artifact binding identifies the gate (`task_is_coordination`) and the
            # seat identifies its owner (`actor_is_coordinator`).
            **({"role": role} if role else {}),
            "status": "in_progress" if start_active else "todo",
            "ownerAgentId": actor if start_active else None,
            "dependsOn": [depends_on] if depends_on else [],
            "ownedPaths": [plan_path_value],
            # An approval task, not implementation work: the plan is adjudicated by
            # the human (or auto-approval) through its artifact, never by a review
            # phase. Without this it would inherit the run's `defaultPhases` and its
            # author would end up self-reviewing a plan document.
            "phases": [],
            "acceptanceCriteria": [
                f"{plan_noun} describes the execution approach and task graph.",
                f"{plan_noun} artifact is written at the active team path `{plan_path_value}`.",
                f"{plan_noun} records confirmed decisions, repo-answered decisions, defaulted assumptions, and remaining open questions or blockers.",
                f"{plan_noun} pins every contract shared between tasks — named APIs, registry seams, component props and types, store fields, schemas, IPC channels — so no cross-task interface is left for an implementer to invent.",
                f"{plan_noun} commits to one choice per load-bearing decision, with rationale and the rejected alternative recorded; no decision is left open as an either/or for the implementer.",
                "If autonomous planning or artifact auto-approval is active, plan records conservative defaults used, risks accepted by autonomy mode, and any questions intentionally not asked.",
                "Plan is reviewed by the user and either approved to done or sent back for changes.",
            ],
            "implementationNotes": [],
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
            "notes": [],
            "startedAt": now_iso() if start_active else None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(plan_task)
        created_plan_task = True
        append_event(state, "task_added", actor, f"{actor} added {plan_task['id']}: {plan_task['title']}.")
    elif plan_task.get("status") != "done":
        if depends_on and depends_on not in plan_task.get("dependsOn", []):
            add_unique_values(plan_task, "dependsOn", [depends_on])
        if start_active and task_is_ready(state, plan_task):
            plan_task["status"] = "in_progress"
            plan_task["ownerAgentId"] = plan_task.get("ownerAgentId") or actor
            plan_task["startedAt"] = plan_task.get("startedAt") or now_iso()
        plan_task["completedAt"] = None

    should_refresh_source_context = (
        created_plan_task
        or SOURCE_CONTEXT_HEADING in str(plan_task.get("description") or "")
    )
    if plan_task.get("status") != "done" and should_refresh_source_context:
        apply_source_context_to_task(plan_task, state, state_path)

    if plan_task.get("status") in ACTIVE_TASK_STATUSES:
        mint_lease(plan_task, actor, role)
        stamp_task_execution_identity(state, plan_task)

    if plan_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, plan_path_value)
        initial_status = "approved" if plan_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": f"Imported from completed {role_prefix}plan task."})
        plan_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            # The canonical plan-artifact kind is shared by every coordinator seat;
            # a roleless run's plan differs by title/owner, not kind, so the renderer
            # artifact-kind map and find_plan_artifact keep working.
            "kind": "architect_plan",
            "title": plan_artifact_title,
            "path": plan_path_value,
            "status": initial_status,
            "createdBy": actor,
            "taskId": plan_task.get("id"),
            "fingerprint": file_fingerprint(absolute_path),
            "reviewHistory": history,
            "recommendedTasks": [],
            "createdAt": now,
            "updatedAt": now,
        }
        if initial_status == "approved":
            plan_artifact["approvedBy"] = actor
            plan_artifact["approvedAt"] = now
        state.setdefault("artifacts", []).append(plan_artifact)
        append_event(state, "artifact_added", actor, f"{actor} registered {role_prefix}plan artifact {plan_artifact['id']}.")
    else:
        plan_artifact["taskId"] = plan_task.get("id")
        plan_artifact["path"] = plan_path_value
        plan_artifact.setdefault("title", plan_artifact_title)
        plan_artifact.setdefault("createdBy", actor)
        plan_artifact.setdefault("reviewHistory", [])
        plan_artifact.setdefault("recommendedTasks", [])
        plan_artifact.setdefault("createdAt", now_iso())

    # After the artifact exists: the brief is layered onto the run's coordination
    # task, and it is the artifact's binding that identifies which task that is.
    apply_coordinator_brief_to_task(plan_task, state, state_path)

    return {"task": plan_task, "artifact": plan_artifact}

def plan_path_for_state(state_path: Path) -> Path:
    return state_path.parent / "plan.md"

def plan_prompt_path(state_path: Path) -> str:
    team_dir = state_path.parent
    if team_dir.parent.name == SPRINTENGINE_DIR_NAME and team_dir.parent.parent.name == MULTICODE_DIR_NAME:
        return f"{MULTICODE_DIR_NAME}/{SPRINTENGINE_DIR_NAME}/{team_dir.name}/plan.md"
    return "plan.md"

def default_swarm_name_for_state(state_path: Path) -> str:
    team_dir_name = state_path.parent.name
    return "Sprint Engine Team" if team_dir_name == "sprintengine" else team_dir_name

def slugify_team_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "sprintengine-team"

def handover_path_for_state(state_path: Path) -> Path:
    return state_path.parent / "handover.md"

def sources_dir_for_state(state_path: Path) -> Path:
    return state_path.parent / "sources"

def safe_source_filename(path: Path, used: set[str]) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", path.name.strip()).strip(".-") or "source"
    candidate = name
    stem = Path(name).stem or "source"
    suffix = Path(name).suffix
    index = 2
    while candidate in used:
        candidate = f"{stem}-{index}{suffix}"
        index += 1
    used.add(candidate)
    return candidate

def parse_source_bundle_arg(value: str) -> Dict[str, str]:
    kind, separator, raw_path = value.partition(":")
    kind = kind.strip()
    raw_path = raw_path.strip()
    if not separator or not kind or not raw_path:
        raise SystemExit("--source must use kind:path, for example product_plan:future-plans/product.md")
    if kind not in VALID_SOURCE_BUNDLE_KINDS:
        raise SystemExit(f"--source kind must be one of: {', '.join(sorted(VALID_SOURCE_BUNDLE_KINDS))}.")
    return {"kind": kind, "path": raw_path}

def collect_run_findings(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every structured finding recorded on the run, flattened and attributed.

    The `findings` array was empty in all 33 task records across the three runs
    merged 2026-07-23 — even where the task's own summary prose reported
    findings — so nothing downstream could ask "what did this sprint find?".
    The channel already existed; what it lacked was anywhere the answer showed
    up. Every finding lands here with its owning task, whether it was filed by
    the task's owner (`feedback.findings`) or by a reviewer assessing that task
    (`feedbackAssessments[].findings`), and whether or not it was later routed
    into a follow-up task.
    """
    findings: List[Dict[str, Any]] = []
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "")
        sources: List[tuple[Dict[str, Any], str]] = []
        feedback = task.get("feedback")
        if isinstance(feedback, dict):
            sources.append((feedback, "self_report"))
        for assessment in task.get("feedbackAssessments") or []:
            if isinstance(assessment, dict):
                sources.append((assessment, "reviewer_assessment"))
        for record, origin in sources:
            for finding in record.get("findings") or []:
                if not isinstance(finding, dict):
                    continue
                findings.append({
                    "taskId": task_id,
                    "taskTitle": task.get("title") or "",
                    "origin": origin,
                    "reportedBy": record.get("agentId") or "",
                    "capturedAt": record.get("capturedAt") or "",
                    "id": finding.get("id") or "",
                    "kind": finding.get("kind") or "",
                    "severity": finding.get("severity") or "",
                    "area": finding.get("area") or "",
                    "status": finding.get("status") or "",
                    "title": finding.get("title") or "",
                    # The task the architect filed FOR this finding, if any —
                    # the other half of the reviewer task-filing channel.
                    "filedTaskIds": _tasks_filed_from(state, task_id, str(finding.get("id") or "")),
                })
    return findings


def _tasks_filed_from(state: Dict[str, Any], task_id: str, finding_id: str) -> List[str]:
    if not finding_id:
        return []
    filed = []
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        origin = task.get("fromFinding")
        if not isinstance(origin, dict):
            continue
        if str(origin.get("findingId") or "") != finding_id:
            continue
        # `fromFinding` is normalized with both halves required, so the
        # owning task id is always present and always comparable.
        if str(origin.get("taskId") or "") != task_id:
            continue
        filed.append(str(task.get("id") or ""))
    return filed


def build_run_summary(state: Dict[str, Any]) -> Dict[str, Any]:
    tasks = state.get("tasks", [])
    completed = [t for t in tasks if t.get("status") == "done"]
    touched_files: List[Any] = []
    commands_ran: List[Any] = []
    scope_expansions: List[Dict[str, Any]] = []
    results: List[str] = []
    task_summaries = []
    open_questions: List[str] = []

    for t in completed:
        ev = ensure_evidence(t)
        task_summaries.append({
            "id": t.get("id"),
            "title": t.get("title"),
            "summary": ev.get("summary") or "No summary recorded.",
            "ownerAgentId": t.get("ownerAgentId"),
            "completedAt": t.get("completedAt"),
        })
        touched_files.extend(ev.get("touchedFiles", []))
        commands_ran.extend(ev.get("commandsRan", []))
        for expansion in ev.get("scopeExpansions", []):
            if isinstance(expansion, dict):
                scope_expansions.append({
                    "taskId": t.get("id"),
                    "path": expansion.get("path"),
                    "reason": expansion.get("reason"),
                    "risk": expansion.get("risk", ""),
                })
        results.extend(f"{t.get('id')}: {r}" for r in ev.get("results", []) if isinstance(r, str))

    for t in tasks:
        for q in t.get("notes", []):
            if isinstance(q, str) and q.strip():
                open_questions.append(f"{t.get('id')}: {q.strip()}")

    findings = collect_run_findings(state)
    findings_by_severity: Dict[str, int] = {}
    for finding in findings:
        severity = finding.get("severity") or "unspecified"
        findings_by_severity[severity] = findings_by_severity.get(severity, 0) + 1

    sprintengine = state.get("sprintengine", {})
    return {
        "goal": sprintengine.get("goal", ""),
        "findings": findings,
        "findingsBySeverity": dict(sorted(findings_by_severity.items())),
        "status": sprintengine.get("status", "planning"),
        "tasks": {"total": len(tasks), "completed": len(completed), "remaining": max(0, len(tasks) - len(completed))},
        "touchedFiles": unique_strings(touched_files),
        "commandsRan": unique_strings(commands_ran),
        "scopeExpansions": scope_expansions,
        "results": results,
        "completedTasks": task_summaries,
        "openQuestions": open_questions,
    }
