"""Shell and Git helpers for Sprint Engine run worktrees."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.paths import project_relative_path, resolve_vcs_path, workspace_root_for_state_path

# The repo-entry model and the cross-repo merge-order graph were extracted from this
# module (backlog 1737); shell.py is the git/gh subprocess layer that sits above them.
# The names below are imported for this module's own use AND re-exported so that
# `shell.<name>` stays a stable surface for callers and tests that predate the split.
# New code imports from repo_model / merge_graph directly.
from sprintengine_core.tool.repo_model import (  # noqa: F401
    PRIMARY_REPO_ID,
    PRIMARY_REPO_ROOT,
    VALID_PULL_REQUEST_STATES,
    get_run_vcs,
    parse_repo_declaration,
    parse_repo_declarations,
    repo_for_task,
    set_repo_last_commit_sha,
    set_repo_pull_request,
    set_repo_status,
    set_vcs_last_commit_sha,
    set_vcs_status,
    vcs_repos,
    _optional_str,
    _repo_entry,
    _set_repo_field,
)
from sprintengine_core.tool.merge_graph import (  # noqa: F401
    assert_no_repo_dependency_cycle,
    cross_repo_merge_edges,
    repo_dependency_cycle,
    repo_merge_order,
    _repos_that_must_merge_first,
    _state_tasks,
    _structural_merge_predecessors,
)


def run_command_checked(cwd: Path, args: List[str], *, allow_failure: bool = False, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            args,
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GH_PROMPT_DISABLED": "1"},
        )
    except subprocess.TimeoutExpired as exc:
        raise SystemExit(f"Command timed out after {timeout}s: {' '.join(args)}") from exc
    if completed.returncode != 0 and not allow_failure:
        message = completed.stderr.strip() or completed.stdout.strip() or f"exit code {completed.returncode}"
        raise SystemExit(f"Command failed: {' '.join(args)}: {message}")
    return completed


def run_git_checked(cwd: Path, args: List[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    return run_command_checked(cwd, ["git", *args], allow_failure=allow_failure)


def run_gh_checked(cwd: Path, args: List[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    gh = shutil.which("gh")
    if not gh:
        raise SystemExit("GitHub CLI executable 'gh' was not found; cannot create a pull request.")
    return run_command_checked(cwd, [gh, *args], allow_failure=allow_failure, timeout=60)


def parse_url_from_output(output: str) -> Optional[str]:
    match = re.search(r"https?://\S+", output)
    return match.group(0).rstrip(".,)") if match else None


def git_branch_exists(repo_root: Path, branch: str) -> bool:
    result = run_git_checked(repo_root, ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], allow_failure=True)
    return result.returncode == 0


def current_git_branch(repo_root: Path) -> str:
    result = run_git_checked(repo_root, ["branch", "--show-current"])
    branch = result.stdout.strip()
    if not branch:
        raise SystemExit("Cannot operate on a detached HEAD worktree.")
    return branch


def default_base_ref(repo_root: Path) -> str:
    current = run_git_checked(repo_root, ["branch", "--show-current"], allow_failure=True).stdout.strip()
    if current:
        return current
    return "HEAD"


def compact_commit_subject(value: str, *, limit: int = 72) -> str:
    compact = re.sub(r"\s+", " ", value.strip()) or "Sprint Engine changes"
    return compact if len(compact) <= limit else compact[: limit - 3].rstrip() + "..."


def safe_branch_component(value: str) -> str:
    component = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower()).strip("-._")
    return component or "run"


def declared_sibling_root(workspace_root: Path, repo_id: str, raw_root: str) -> Path:
    """Resolve one declared sibling root, or abort with a plain-language reason.

    A run may only span whole, separate git repositories: a path that is not a
    repository root of its own would put this run's worktree — and every commit
    scoped to it — in a tree nobody declared.
    """
    root = Path(raw_root).expanduser()
    if not root.is_absolute():
        root = workspace_root / root
    root = root.resolve()
    if not root.is_dir():
        raise SystemExit(f"Project {repo_id!r} was declared as {raw_root}, but there is no directory at {root}.")
    if root == workspace_root.resolve():
        raise SystemExit(f"Project {repo_id!r} points at this project itself, which the sprint already includes.")
    try:
        root.relative_to(workspace_root.resolve())
    except ValueError:
        pass
    else:
        raise SystemExit(
            f"Project {repo_id!r} at {raw_root} is inside this project. A sprint spans separate projects; "
            "declare one that lives outside this one."
        )
    try:
        workspace_root.resolve().relative_to(root)
    except ValueError:
        pass
    else:
        # The mirror of the check above, and the one that widens the blast radius: a
        # root holding the workspace pulls it and every neighbour beside it into the
        # run's surface by inclusion. The MCP boundary already refuses to authorize
        # such a root, but the engine's own git operations resolve repo roots from the
        # store without consulting allowedRoots, so this is where it has to be refused.
        raise SystemExit(
            f"Project {repo_id!r} at {raw_root} contains this project. A sprint spans separate projects; "
            "declare one that lives beside this one, not one that holds it."
        )
    toplevel = run_git_checked(root, ["rev-parse", "--show-toplevel"], allow_failure=True)
    if toplevel.returncode != 0 or Path(toplevel.stdout.strip() or "/nonexistent").resolve() != root:
        raise SystemExit(f"Project {repo_id!r} at {raw_root} is not a git repository. A sprint can only span git projects.")
    return root


def declared_sibling_entries(
    workspace_root: Path,
    state_path: Path,
    declared: List[Dict[str, str]],
    *,
    branch: str,
) -> List[Dict[str, Any]]:
    """Repo entries for every declared sibling, validated against disk.

    Each sibling's worktree lives under the PRIMARY run directory as
    `worktree-<id>`, beside the primary's `worktree`, so run discovery and teardown
    keep one anchor no matter how many projects a run spans. That directory is
    inside the primary repo's tree, which ignores `.multi-code/sprintengine/*`, so
    the sibling checkout is never visible to the primary repo's own status.
    """
    entries: List[Dict[str, Any]] = []
    roots: Dict[str, str] = {}
    for repo in declared:
        repo_id = repo["id"]
        root = declared_sibling_root(workspace_root, repo_id, repo["root"])
        if str(root) in roots:
            raise SystemExit(f"Projects {roots[str(root)]!r} and {repo_id!r} both point at {root}; declare each project once.")
        roots[str(root)] = repo_id
        entries.append(_repo_entry(
            repo_id=repo_id,
            root=Path(os.path.relpath(root, workspace_root.resolve())).as_posix(),
            worktree_path=project_relative_path(workspace_root, state_path.parent / f"worktree-{repo_id}"),
            branch_name=branch,
            base_ref=default_base_ref(root),
            status=None,
            last_commit_sha=None,
        ))
    return entries


def ensure_repo_worktree(workspace_root: Path, repo: Dict[str, Any], *, start_point: Optional[str] = None) -> None:
    """Create (or adopt) one declared repo's run worktree and record it ready.

    Raises rather than recording a failed status: a run that cannot get a tree for
    every project it declares has no safe partial state to continue from, so init
    aborts and the operator fixes the declaration.

    ``start_point`` overrides only the commit-ish the new branch is created FROM
    (e.g. ``origin/main`` for a chained sprint on a refreshed base). It is never
    stored: the repo's recorded ``baseRef`` stays the plain branch name, which is
    what ``gh pr create --base`` receives, and a remote-tracking name there would
    break PR creation.
    """
    repo_root = resolve_vcs_path(workspace_root, repo["root"])
    worktree_path = resolve_vcs_path(workspace_root, repo["worktreePath"])
    branch = repo["branchName"]
    existing = run_git_checked(repo_root, ["worktree", "list", "--porcelain"])
    if str(worktree_path.resolve()) not in existing.stdout:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        if git_branch_exists(repo_root, branch):
            run_git_checked(repo_root, ["worktree", "add", str(worktree_path), branch])
        else:
            base = str(start_point or "").strip() or str(repo.get("baseRef") or "").strip() or default_base_ref(repo_root)
            run_git_checked(repo_root, ["worktree", "add", "-b", branch, str(worktree_path), base])
    if not worktree_path.exists():
        raise SystemExit(f"Sprint Engine worktree was not created: {repo['worktreePath']}")
    actual_branch = current_git_branch(worktree_path)
    if actual_branch != branch:
        raise SystemExit(f"Sprint Engine worktree {repo['worktreePath']} is on {actual_branch}, expected {branch}.")
    repo["status"] = "ready"


def ensure_run_worktree(
    state: Dict[str, Any],
    state_path: Path,
    *,
    base_ref: Optional[str] = None,
    branch_name: Optional[str] = None,
    repos: Optional[List[Dict[str, str]]] = None,
    # Commit-ish the PRIMARY repo's new branch starts from (chained sprints pass a
    # freshly-fetched remote-tracking ref). Distinct from base_ref, which is also
    # the stored PR base and must stay a plain branch name.
    start_point: Optional[str] = None,
) -> Dict[str, Any]:
    from sprintengine_core.tool.plans import default_swarm_name_for_state
    from sprintengine_core.tool.state import append_event

    workspace_root = workspace_root_for_state_path(state_path)
    sprintengine = state.setdefault("sprintengine", {})
    team_slug = safe_branch_component(str(sprintengine.get("name") or default_swarm_name_for_state(state_path)))
    branch = branch_name.strip() if branch_name and branch_name.strip() else f"sprintengine/{team_slug}"
    base = base_ref.strip() if base_ref and base_ref.strip() else default_base_ref(workspace_root)
    worktree_path = state_path.parent / "worktree"
    rel_worktree = project_relative_path(workspace_root, worktree_path)
    vcs = sprintengine.setdefault("vcs", {})
    primary = _repo_entry(
        repo_id=PRIMARY_REPO_ID,
        root=PRIMARY_REPO_ROOT,
        worktree_path=rel_worktree,
        branch_name=branch,
        base_ref=base,
        status=vcs.get("status"),
        last_commit_sha=vcs.get("lastCommitSha"),
        pull_request_url=vcs.get("pullRequestUrl"),
        pull_request_state=vcs.get("pullRequestState"),
        pull_request_error=vcs.get("pullRequestError"),
    )
    # The flat fields and entry zero are the same repo in two shapes. The list is what
    # the multi-repo work reads; the flat block stays because it is what every shipped
    # consumer (PR paths, the app, the mobile snapshot) still reads, so a single-repo
    # run keeps writing exactly the vcs semantics it wrote before this list existed.
    # A run's repo set is fixed at creation, so a re-entry with no fresh declaration
    # keeps the siblings already stored rather than dropping them.
    siblings = (
        declared_sibling_entries(workspace_root, state_path, repos, branch=branch)
        if repos
        else vcs_repos(vcs)[1:]
    )
    vcs.update({
        "mode": "run_worktree",
        "worktreePath": primary["worktreePath"],
        "branchName": primary["branchName"],
        "baseRef": primary["baseRef"],
        "status": primary["status"],
        "pullRequestUrl": primary["pullRequestUrl"],
        "pullRequestState": primary["pullRequestState"],
        "pullRequestError": primary["pullRequestError"],
        "lastCommitSha": primary["lastCommitSha"],
        "repos": [primary, *siblings],
    })

    # Every declared repo gets its own tree on the same branch, and each records its
    # own status as it lands. One repo's failure aborts the whole init: a run half
    # able to reach the projects it declares would strand every task targeting the
    # rest of them.
    for repo in vcs["repos"]:
        ensure_repo_worktree(
            workspace_root,
            repo,
            start_point=start_point if repo["id"] == PRIMARY_REPO_ID else None,
        )
    set_vcs_status(vcs, "ready")
    ready_message = f"Sprint Engine run worktree is ready at {rel_worktree} on {branch}."
    if siblings:
        ready_message += " Also: " + ", ".join(f"{repo['id']} at {repo['worktreePath']}" for repo in siblings) + "."
    append_event(state, "run_worktree_ready", "sprintengine", ready_message)
    return vcs


def _repo_worktree(state_path: Path, repo: Dict[str, Any]) -> Optional[Path]:
    value = repo.get("worktreePath")
    if not isinstance(value, str) or not value.strip():
        return None
    return resolve_vcs_path(workspace_root_for_state_path(state_path), value)


def worktree_for_task(state: Dict[str, Any], state_path: Path, task: Dict[str, Any]) -> Optional[Path]:
    """The run worktree a task's paths resolve against, or None outside worktree mode.

    Every seam that reads or writes a task's changes — commits, diff evidence,
    orphan scans — resolves its tree through here, so a task targeting a sibling
    project never touches the primary checkout.
    """
    repo = repo_for_task(state, task)
    return _repo_worktree(state_path, repo) if repo else None


def git_status_short(worktree: Path) -> str:
    return run_git_checked(worktree, ["status", "--porcelain"]).stdout.strip()


def _normalize_commit_pathspec(worktree: Path, raw_paths: List[str]) -> List[str]:
    """Validate and de-duplicate project-relative paths for pathspec staging.

    Absolute paths, parent traversal, and paths that resolve outside the run
    worktree are rejected so a task commit can never stage files it does not own.
    """
    worktree_resolved = worktree.resolve()
    pathspec: List[str] = []
    for raw in raw_paths:
        value = str(raw or "").strip()
        if not value:
            continue
        candidate = Path(value)
        if candidate.is_absolute() or any(part == ".." for part in candidate.parts):
            continue
        try:
            (worktree_resolved / candidate).resolve().relative_to(worktree_resolved)
        except ValueError:
            continue
        posix = candidate.as_posix().rstrip("/")
        if posix and posix not in pathspec:
            pathspec.append(posix)
    return pathspec


ROOT_MODULE = "."


def normalize_owned_path(value: Any) -> str:
    """One project-relative owned path in comparable form, or '' when unusable.

    Every spelling of the project root — ``.``, ``./``, ``.//`` — folds to
    :data:`ROOT_MODULE`, so "the whole tree" has one form the predicate below
    recognizes. An ABSOLUTE root (``/``) deliberately does not: it normalizes to
    ``''`` and so owns nothing, matching how absolute entries are dropped from
    every commit pathspec. Promoting it to the project root would make it overlap
    every module in the dispatch guard, which does not filter absolute entries.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    return Path(raw).as_posix().rstrip("/")


def module_contains_path(owner: str, candidate: str) -> bool:
    """True when `candidate` IS the owned module `owner` or sits inside it.

    A task owns modules — project-relative directories — not files (backlog item
    2019), and this is the one predicate that answers "is this path inside that
    ownership?" for commit scope, orphan detection, and the dispatch guard.

    Comparison is by path SEGMENT, never by string prefix: ``payments-api/webhooks``
    contains ``payments-api/webhooks/delivery.ts`` and does NOT contain
    ``payments-api/webhooks-v2/anything``, which a ``startswith`` on the bare owner
    would wrongly claim.

    ``.`` is the project root, and contains every project-relative path. Coarse
    ownership makes that spelling reachable — an architect told to declare
    directories writes the one that means "all of them" — and segment comparison
    alone would answer False for every candidate, so the task would own nothing,
    commit nothing, and orphan its whole diff silently.

    A file entry contains only itself, so a run store written before ownership
    moved to modules keeps the exact scope it always had.
    """
    owner_value = normalize_owned_path(owner)
    candidate_value = normalize_owned_path(candidate)
    if not owner_value or not candidate_value:
        return False
    if owner_value == ROOT_MODULE:
        return True
    return candidate_value == owner_value or candidate_value.startswith(owner_value + "/")


def paths_overlap(left: str, right: str) -> bool:
    """True when either path contains the other — the symmetric ownership clash."""
    return module_contains_path(left, right) or module_contains_path(right, left)


def path_in_owned_scope(path: str, pathspec: List[str]) -> bool:
    return any(module_contains_path(entry, path) for entry in pathspec)


def task_claimed_paths(task: Dict[str, Any]) -> List[str]:
    """Every path a task claims: its declared modules plus its logged scope expansions.

    `ownedPaths` is an optional advisory since MC-2127, but a task that carries one
    still uses it to serialize dispatch and to fence live siblings out of its work
    at publish. A logged scope expansion is the same kind of claim made mid-task
    rather than at plan time — it is precisely an agent saying "I am working here
    too" — so it belongs in the claim set. Folding it in is also what retires the
    bug where publish ignored scope-expanded paths entirely.
    """
    claimed: List[str] = [str(path) for path in (task.get("ownedPaths") or [])]
    evidence = task.get("evidence")
    if isinstance(evidence, dict):
        for expansion in evidence.get("scopeExpansions") or []:
            if isinstance(expansion, dict):
                path = str(expansion.get("path") or "").strip()
                if path:
                    claimed.append(path)
    seen: set = set()
    unique: List[str] = []
    for path in claimed:
        if path and path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def modules_held_by_other_active_tasks(state: Dict[str, Any], task: Dict[str, Any]) -> List[str]:
    """The claimed paths of every OTHER task whose lease is currently active.

    "Active" is `active_lease_worker`, the SAME notion the dispatch guard uses:
    the two answer one question — who is live in this module right now — and a
    second definition would let one of them protect what the other releases.
    Repo-agnostic for the same reason the guard is: the commit sweep stages a
    task's pathspec in every declared tree it worked (MC-1752), so the same
    relative module in a sibling project is the same claim.

    Since MC-2127 this is load-bearing in the other direction too: it is what the
    default publish sweep SUBTRACTS, so "commit everything I changed" cannot take a
    live sibling's half-finished work with it.
    """
    from sprintengine_core.tool.state import active_lease_worker

    task_id = str(task.get("id") or "").strip()
    held: List[str] = []
    for other in state.get("tasks", []) or []:
        if not isinstance(other, dict) or str(other.get("id") or "").strip() == task_id:
            continue
        if not active_lease_worker(other):
            continue
        held.extend(task_claimed_paths(other))
    return held


def _parse_porcelain_z(output: str) -> List[Dict[str, str]]:
    """Parse `git status --porcelain -z` into {status, path} records.

    Renames carry the new path in the status entry and the old path as the
    following NUL-separated token; both are surfaced so the finalizer can decide
    scope membership for either side.
    """
    tokens = [token for token in output.split("\0")]
    records: List[Dict[str, str]] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if not token:
            index += 1
            continue
        status = token[:2]
        path = token[3:] if len(token) > 3 else ""
        records.append({"status": status, "path": path})
        index += 1
        if (status and (status[0] == "R" or status[0] == "C")) and index < len(tokens):
            old = tokens[index]
            if old:
                records.append({"status": status, "path": old})
            index += 1
    return records


def _select_in_scope(
    worktree: Path,
    dirty_paths: List[str],
    *,
    claimed: List[str],
    declared: List[str],
    foreign: List[str],
    reported: List[str],
    sweep: bool,
) -> List[str]:
    """The publish scope filter (MC-2127) — one definition, three callers.

    The commit applies it under the repo's index lock, the multi-repo pre-probe
    applies it lock-free to decide whether a sibling tree is worth entering, and the
    leftover-paths question applies it to ask "what is still dirty that nobody
    claims?". Three answers that must agree, so they share the code.

    Precedence: an explicit report wins; otherwise the tree is swept; otherwise
    scope falls back to what the task declared and claims.

    ``sweep`` is false for a repo the task is not BOUND to. In its own tree "what is
    dirty" is a sound answer to "what did I change", because that is the tree it was
    sent to work in. In a sibling project it is not: a task that never touched that
    repo would otherwise sweep up whatever is dirty there, including another task's
    work. A sibling tree stays opt-in, entered only on the evidence that this task
    worked there.

    A path a LIVE sibling claims is never ours, in any tree. Own claims win on
    overlap so a task always commits its own module: the dispatch guard normally
    keeps overlapping tasks off the clock together, but a repair transition or a
    hand-edited store can still produce one.
    """
    own_claims = _normalize_commit_pathspec(worktree, claimed)

    def mine(path: str) -> bool:
        if not foreign:
            return True
        return path_in_owned_scope(path, own_claims) or not path_in_owned_scope(path, foreign)

    if reported:
        # Exactly what was reported, intersected with what git agrees is dirty. A
        # reported path a sibling holds is still refused — a report is authority
        # over one's own work, never over anyone else's.
        return [path for path in dirty_paths if path_in_owned_scope(path, reported) and mine(path)]
    if sweep:
        return [path for path in dirty_paths if mine(path)]
    fallback = _normalize_commit_pathspec(worktree, [*declared, *claimed])
    if not fallback:
        return []
    return [path for path in dirty_paths if path_in_owned_scope(path, fallback) and mine(path)]


def _dirty_paths_in(worktree: Path) -> List[str]:
    """Every dirty path git reports in a worktree, untracked included."""
    status = run_git_checked(
        worktree, ["status", "--porcelain", "-z", "--untracked-files=all"], allow_failure=True
    )
    if status.returncode != 0:
        return []
    return sorted({record["path"] for record in _parse_porcelain_z(status.stdout) if record["path"]})


def _commit_task_paths_in_repo(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    repo: Dict[str, Any],
    *,
    explicit_paths: Optional[List[str]] = None,
    self_reported: Optional[List[str]] = None,
    sweep: bool = True,
) -> Optional[str]:
    """Stage and commit the task's in-scope paths in ONE repo's run worktree.

    Serialized through that repo's ``runner/git.commit.<repoId>.lock`` so
    concurrent agents never race a git index. Returns the new short SHA, or
    ``None`` when there is nothing in scope to commit in this repo.

    Scope comes from publish time, not plan time (MC-2127). Two modes:

    * **Self-report.** ``self_reported`` names what the agent actually changed, and
      exactly those dirty paths are staged. The agent made every edit, so its
      report beats any plan-time guess.
    * **Sweep.** With no self-report, scope is everything dirty in the tree MINUS
      the paths live siblings claim. On a dependency-chained run — most of one —
      no sibling is active, so this is simply "commit all my changes" and nothing
      is dropped. This is what makes a task with no ``ownedPaths`` at all publish
      its work instead of committing nothing.

    Still never ``git add -A``: the pathspec is always an explicit list of paths
    git itself reported dirty, so the sibling exclusion is applied before staging.
    """
    from sprintengine_core import store as folder_store
    from sprintengine_core.tool.state import append_event
    from sprintengine_core.tool.tasks import ensure_evidence, task_diff_declared_paths

    worktree = _repo_worktree(state_path, repo)
    if not worktree or not worktree.exists():
        return None

    vcs = get_run_vcs(state)
    claimed = task_claimed_paths(task)
    # Only the publish self-report LIMITS scope. `vcs commit --path` keeps its old
    # meaning — an ADDITIVE "include this too" — which the sweep subsumes in the
    # bound tree but still matters in a sibling tree, where scope falls back to what
    # the task declared.
    declared = task_diff_declared_paths(task, explicit_paths or [])
    reported = _normalize_commit_pathspec(worktree, [str(path) for path in (self_reported or [])])

    lock = folder_store.FolderLock(state_path.parent / folder_store.git_commit_lock_file(repo["id"]))
    lock.acquire(recover_stale=True)
    try:
        status_out = run_git_checked(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout
        dirty = _parse_porcelain_z(status_out)
        if vcs is not None:
            set_repo_status(vcs, repo["id"], "dirty" if dirty else "ready")
        dirty_paths = sorted({record["path"] for record in dirty if record["path"]})
        if not dirty_paths:
            return None
        in_scope = _select_in_scope(
            worktree,
            dirty_paths,
            claimed=claimed,
            declared=declared,
            foreign=_normalize_commit_pathspec(worktree, modules_held_by_other_active_tasks(state, task)),
            reported=reported,
            sweep=sweep,
        )
        if not in_scope:
            return None
        run_git_checked(worktree, ["add", "--", *in_scope])
        staged = run_git_checked(worktree, ["diff", "--cached", "--quiet"], allow_failure=True)
        if staged.returncode == 0:
            return None
        task_id = str(task.get("id") or "task")
        title = str(task.get("title") or "Sprint Engine task")
        message = compact_commit_subject(f"SprintEngine {task_id}: {title}")
        body = "\n".join([f"Task: {task_id}", f"Agent: {actor}"]).strip()
        run_git_checked(worktree, ["commit", "-m", message, "-m", body])
        sha = run_git_checked(worktree, ["rev-parse", "--short", "HEAD"]).stdout.strip()
    finally:
        lock.release()

    if vcs is not None:
        set_repo_status(vcs, repo["id"], "committed")
        set_repo_last_commit_sha(vcs, repo["id"], sha)
    ensure_evidence(task).setdefault("commits", [])
    commits = task["evidence"].setdefault("commits", [])
    if isinstance(commits, list) and sha not in commits:
        commits.append(sha)
    # Per-repo attribution (MC-1752), additive next to the flat sha list so
    # existing readers (produced-changes, UI) keep their shape.
    by_repo = task["evidence"].setdefault("commitsByRepo", {})
    if isinstance(by_repo, dict):
        repo_shas = by_repo.setdefault(str(repo["id"]), [])
        if isinstance(repo_shas, list) and sha not in repo_shas:
            repo_shas.append(sha)
    append_event(state, "task_changes_committed", actor, f"{actor} committed Sprint Engine changes for {task_id}: {sha}.")
    return sha


def commit_run_worktree_paths(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    *,
    explicit_paths: Optional[List[str]] = None,
    self_reported: Optional[List[str]] = None,
) -> Optional[str]:
    """Commit the task's in-scope changes in EVERY declared repo worktree.

    The task's bound repo commits first (its sha is the return value, keeping
    the historical contract for publish/vcs.commit results); then every OTHER
    declared repo worktree is swept with the same pathspec (MC-1752) — an agent
    told to work in a sibling project just works, and its changes are
    committed, credited to the task, and recorded on that repo's entry instead
    of silently rotting uncommitted (the post-merge-hardening T11/multiauth
    stranding). The bound worktree missing is still a hard error; a missing
    sibling worktree merely skips (it may not be provisioned yet).
    Returns the first commit sha produced (bound repo preferred), or ``None``
    when worktree mode is off or nothing anywhere was in scope.
    """
    repo = repo_for_task(state, task)
    worktree = _repo_worktree(state_path, repo) if repo else None
    if not repo or not worktree:
        return None
    if not worktree.exists():
        raise SystemExit(f"Sprint Engine worktree is missing: {worktree}")

    primary_sha = _commit_task_paths_in_repo(
        state, state_path, task, actor, repo, explicit_paths=explicit_paths, self_reported=self_reported
    )
    sweep_sha: Optional[str] = None
    vcs = get_run_vcs(state)
    for sibling in vcs_repos(vcs):
        if str(sibling.get("id")) == str(repo.get("id")):
            continue
        # Lock-free pre-probe: only enter a sibling's commit lock when the task
        # actually changed something in its tree. Per-repo lock isolation
        # (MC-1610) is the contract — a task that worked one project must never
        # queue behind, or time out on, another project's lock. The locked
        # commit re-checks scope under the lock, so the probe racing another
        # agent's commit only ever turns into a clean no-op.
        # `sweep=False`: a sibling tree is opt-in. The task must have declared or
        # claimed something there to commit there — otherwise a task bound to one
        # project would sweep up whatever happened to be dirty in another.
        if not _task_in_scope_dirty_paths(
            state, state_path, task, sibling,
            explicit_paths=explicit_paths, self_reported=self_reported, sweep=False,
        ):
            continue
        sha = _commit_task_paths_in_repo(
            state, state_path, task, actor, sibling,
            explicit_paths=explicit_paths, self_reported=self_reported, sweep=False,
        )
        if sha and not sweep_sha:
            sweep_sha = sha
    return primary_sha or sweep_sha


def reconcile_repo_commit_state_from_git(state: Dict[str, Any], state_path: Path) -> None:
    """Fold raw git commits into the run's ``repos[]`` entries (MC-1752).

    The engine's own commit path stamps ``lastCommitSha``/``status``, but a
    commit made in a declared worktree by any other route (raw ``git commit``
    from an agent working a sibling project) used to stay invisible to every
    store-truth seam: completion accounting filtered on ``lastCommitSha``, the
    ancestry merge-detection fallback was gated on it, and the run summary
    reported the repo as unchanged. This probe runs on state sync for repos
    with NO recorded sha, asks git whether the run branch carries commits its
    base does not, and stamps the entry from git truth. Conservative on
    purpose: an unresolvable base or failing git call changes nothing, and a
    ``dirty`` status is never upgraded (only ``ready``/empty become
    ``committed``).
    """
    vcs = get_run_vcs(state)
    if not vcs or str(vcs.get("mode") or "") != "run_worktree":
        return
    for repo in vcs_repos(vcs):
        if not isinstance(repo, dict) or repo.get("lastCommitSha"):
            continue
        worktree = _repo_worktree(state_path, repo)
        if not worktree or not worktree.exists():
            continue
        base_ref = str(repo.get("baseRef") or vcs.get("baseRef") or "").strip()
        if not base_ref:
            continue
        counted = run_git_checked(
            worktree, ["rev-list", "--count", f"{base_ref}..HEAD"], allow_failure=True
        )
        if counted.returncode != 0:
            continue
        try:
            commit_count = int((counted.stdout or "0").strip() or "0")
        except ValueError:
            continue
        if commit_count <= 0:
            continue
        sha = run_git_checked(worktree, ["rev-parse", "--short", "HEAD"], allow_failure=True)
        if sha.returncode != 0 or not sha.stdout.strip():
            continue
        set_repo_last_commit_sha(vcs, repo["id"], sha.stdout.strip())
        if str(repo.get("status") or "") in {"", "ready"}:
            set_repo_status(vcs, repo["id"], "committed")


def commit_task_changes_if_needed(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    *,
    self_reported: Optional[List[str]] = None,
) -> Optional[str]:
    """Backstop commit when a task is marked done in worktree mode.

    Agents normally commit per task through ``sprintengine vcs commit``; this
    runs the same locked, pathspec-limited commit so any still-uncommitted
    task-scoped changes are captured before the task is recorded done.
    ``self_reported`` carries publish's changed-paths report (MC-2127); without one
    the commit sweeps everything dirty that no live sibling claims.
    """
    return commit_run_worktree_paths(state, state_path, task, actor, self_reported=self_reported)


def worktree_orphaned_dirty_paths(state: Dict[str, Any], state_path: Path, repo: Dict[str, Any]) -> List[str]:
    """Dirty paths in one repo's run worktree that fall inside no task's claims.

    The RUN-level completion scan (:func:`run_orphaned_dirty_paths`) and the
    `vcs commit` advisory warning. Since MC-2127 a publish in the task's own tree
    sweeps every unclaimed path, so this is normally empty by the time it is asked:
    what it still catches is work left uncommitted at the end of a run — genuinely
    nobody's, and about to be dropped.

    Not a publish gate. Publish stopped refusing on this (MC-2127): a change falling
    outside a plan-time list is exactly the case the sweep now commits, and the
    leftovers it deliberately does not take come back to the agent as a question.

    Claims are read from EVERY task, regardless of its repo binding (MC-1752): a
    task's commit reaches every declared tree it worked, so a path inside any task's
    claims IS picked up by that task's commit wherever it lives — the repo binding
    is routing, not a cage. (Before the sweep, ownership was read per-repo, which is
    exactly how the T11/multiauth work became "orphaned" while being fully owned.)

    Returns sorted project-relative posix paths. Advisory: read without the commit
    lock, so it reflects a point-in-time view of a shared worktree.
    """
    worktree = _repo_worktree(state_path, repo)
    if not worktree or not worktree.exists():
        return []
    status_out = run_git_checked(
        worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]
    ).stdout
    dirty = _parse_porcelain_z(status_out)
    if not dirty:
        return []
    all_owned: List[str] = []
    for task in state.get("tasks", []) or []:
        if isinstance(task, dict):
            # Claims, not just declared modules: a scope expansion is a claim the
            # publish sweep honours (MC-2127), so a path inside one is picked up by
            # that task's commit and is not an orphan.
            all_owned.extend(task_claimed_paths(task))
    owned_pathspec = _normalize_commit_pathspec(worktree, all_owned)
    return sorted(
        {
            record["path"]
            for record in dirty
            if record["path"] and not path_in_owned_scope(record["path"], owned_pathspec)
        }
    )


def run_orphaned_dirty_paths(state: Dict[str, Any], state_path: Path) -> List[Dict[str, str]]:
    """Orphaned dirty paths across EVERY declared repo, each tagged with its project.

    The run-completion scan. A run spanning two projects is not deliverable because
    the primary tree is clean: an orphan in any declared tree is work no commit will
    carry, so completion blocks on all of them and names the project each is in.
    """
    vcs = get_run_vcs(state)
    if not vcs:
        return []
    return [
        {"repo": repo["id"], "path": path}
        for repo in vcs_repos(vcs)
        for path in worktree_orphaned_dirty_paths(state, state_path, repo)
    ]


def _task_working_dirs(worktree: Path, task: Dict[str, Any]) -> List[str]:
    """The directories a task works in, for the missed-scope orphan check.

    A module entry IS such a directory and contributes itself. A legacy file
    entry — an entry that resolves to an existing regular file — contributes its
    parent, which is the directory that check has always used to spot a new
    unowned sibling next to an owned file. Widening a module to its parent would
    instead answer for every sibling module in the tree, blocking a publish on
    another concern's noise.
    """
    owned = _normalize_commit_pathspec(worktree, [str(p) for p in (task.get("ownedPaths") or [])])
    dirs: List[str] = []
    for path in owned:
        if (worktree / path).is_file():
            value = path.rsplit("/", 1)[0] if "/" in path else ""
        else:
            value = path
        if value and value not in dirs:
            dirs.append(value)
    return dirs


def task_scoped_orphaned_dirty_paths(
    state: Dict[str, Any], state_path: Path, task: Dict[str, Any]
) -> List[str]:
    """Orphaned dirty paths that sit in a directory this task already works in.

    Narrows :func:`worktree_orphaned_dirty_paths` to the orphans that fall inside
    a directory this task works in (:func:`_task_working_dirs`) — the strong
    missed-scope signal (e.g. an owned ``a/b/Panel.tsx`` shell next to a new,
    unowned ``a/b/Panel/helper.ts``). Incidental untracked files elsewhere in the
    shared worktree (scratch files, screenshots, another concern's noise) are not
    returned, so they warn at commit time but never block this task's publish.

    Scans the task's bound tree, plus (MC-1752) any declared sibling tree the
    task ACTUALLY changed: the commit sweep commits in-scope work everywhere,
    so an orphan sitting next to swept work is the same missed-scope signal in
    any tree — but a sibling tree the task never touched stays the run's
    problem (:func:`run_orphaned_dirty_paths`), never this publish's; directory
    names repeat across projects, so answering for untouched trees would block
    publishes on strangers' noise. Sibling paths are prefixed ``<repoId>:`` so
    the publish error names the project.
    """
    bound = repo_for_task(state, task)
    if not bound:
        return []
    bound_worktree = _repo_worktree(state_path, bound)
    if not bound_worktree or not bound_worktree.exists():
        return []
    vcs = get_run_vcs(state)
    repos = [bound] + [
        repo for repo in vcs_repos(vcs) if str(repo.get("id")) != str(bound.get("id"))
    ]
    scoped: List[str] = []
    for repo in repos:
        is_bound = str(repo.get("id")) == str(bound.get("id"))
        worktree = _repo_worktree(state_path, repo)
        if not worktree or not worktree.exists():
            continue
        if not is_bound and not _task_in_scope_dirty_paths(state, state_path, task, repo):
            continue
        orphaned = worktree_orphaned_dirty_paths(state, state_path, repo)
        if not orphaned:
            continue
        working_dirs = _task_working_dirs(worktree, task)
        if not working_dirs:
            continue
        prefix = "" if is_bound else f"{repo.get('id')}:"
        scoped.extend(
            f"{prefix}{path}" for path in orphaned if path_in_owned_scope(path, working_dirs)
        )
    return scoped


def _task_in_scope_dirty_paths(
    state: Dict[str, Any], state_path: Path, task: Dict[str, Any], repo: Dict[str, Any],
    *, explicit_paths: Optional[List[str]] = None, self_reported: Optional[List[str]] = None,
    sweep: bool = True,
) -> List[str]:
    """Dirty paths in one repo's worktree this task's publish would commit.

    The lock-free read of the same scope the commit applies under the index lock
    (MC-2127). Advisory by nature: a shared worktree can change under it, and the
    locked commit re-derives scope, so a race only ever turns into a clean no-op.
    """
    from sprintengine_core.tool.tasks import task_diff_declared_paths

    worktree = _repo_worktree(state_path, repo)
    if not worktree or not worktree.exists():
        return []
    dirty_paths = _dirty_paths_in(worktree)
    if not dirty_paths:
        return []
    return _select_in_scope(
        worktree,
        dirty_paths,
        claimed=task_claimed_paths(task),
        declared=task_diff_declared_paths(task, explicit_paths or []),
        foreign=_normalize_commit_pathspec(worktree, modules_held_by_other_active_tasks(state, task)),
        reported=_normalize_commit_pathspec(worktree, [str(path) for path in (self_reported or [])]),
        sweep=sweep,
    )


def unclaimed_dirty_paths(state: Dict[str, Any], state_path: Path, task: Dict[str, Any]) -> List[str]:
    """Dirty paths across the task's declared trees that no LIVE sibling claims.

    Read after a publish's commit, this is the leftover-paths question (MC-2127):
    work sitting in the tree that this publish did not take and no other active task
    is going to. It replaces the orphan REFUSAL — the agent that just published has
    full context and decides in one cheap call whether to include them (publish or
    `vcs commit` again naming them) or leave them.

    Structurally empty after a sweep publish, which takes everything unclaimed; it
    is a self-report publish that leaves anything behind. Sibling-repo paths are
    prefixed ``<repoId>:`` so the answer names the project.
    """
    bound = repo_for_task(state, task)
    if not bound:
        return []
    vcs = get_run_vcs(state)
    repos = [bound] + [
        repo for repo in vcs_repos(vcs) if str(repo.get("id")) != str(bound.get("id"))
    ]
    leftover: List[str] = []
    for repo in repos:
        is_bound = str(repo.get("id")) == str(bound.get("id"))
        prefix = "" if is_bound else f"{repo.get('id')}:"
        # Same asymmetry the commit uses: the bound tree is swept, a sibling tree
        # answers only for what this task declared or claims there. Asking a task
        # about a project it never touched would report strangers' work as its
        # question to answer.
        for path in _task_in_scope_dirty_paths(state, state_path, task, repo, sweep=is_bound):
            leftover.append(f"{prefix}{path}")
    return leftover


def task_scoped_dirty_paths(state: Dict[str, Any], state_path: Path, task: Dict[str, Any]) -> List[str]:
    """Uncommitted paths inside this task's owned + declared scope, non-worktree mode.

    The non-worktree half of publish-time change detection (MC-1542 decision 7). No
    per-task commits exist here, so "did this task produce a diff?" is answered from
    the working tree, scoped exactly the way a task commit would be scoped:
    ``ownedPaths`` plus everything the task declared (logged touched files, publish
    ``--path``). Untracked files count — a task whose only output is a new file has
    very much produced a diff.

    Returns ``[]`` when the workspace is not a git repository at all; the caller
    treats that as "cannot tell" and routes to review rather than skipping it.

    The workspace IS the task's repo here: a run only spans more than one project
    when each project gets its own worktree (``sprintengine init`` refuses ``--repo``
    without ``--use-worktrees``), so every task on a non-worktree run targets the
    primary repo, whose root is the workspace.
    """
    from sprintengine_core.tool.tasks import task_diff_declared_paths

    workspace = workspace_root_for_state_path(state_path)
    declared = task_diff_declared_paths(task)
    owned = [str(path) for path in task.get("ownedPaths", []) or []]
    pathspec = _normalize_commit_pathspec(workspace, [*declared, *owned])
    if not pathspec:
        return []
    status = run_git_checked(
        workspace, ["status", "--porcelain", "-z", "--untracked-files=all"], allow_failure=True
    )
    if status.returncode != 0:
        return []
    dirty = _parse_porcelain_z(status.stdout)
    return sorted({record["path"] for record in dirty if path_in_owned_scope(record["path"], pathspec)})


def workspace_is_git_repository(state_path: Path) -> bool:
    workspace = workspace_root_for_state_path(state_path)
    result = run_git_checked(workspace, ["rev-parse", "--git-dir"], allow_failure=True)
    return result.returncode == 0


def build_run_pull_request_body(state: Dict[str, Any], branch: str, *, repo_id: str = PRIMARY_REPO_ID) -> str:
    """Default PR description: the run goal plus the tasks it delivered in THIS repo.

    A reviewer opening the PR sees what shipped and why, not just the branch name.
    The task table is scoped to the repo the pull request is for: a run spanning two
    projects opens one pull request per project, and a reviewer of the mobile PR is
    not reviewing — and cannot merge — the desktop tasks. A single-repo run's tasks
    all target the primary repo, so its body is what it always was.

    A caller-supplied ``--body`` overrides this entirely.
    """
    from sprintengine_core import store as folder_store

    sprintengine = state.get("sprintengine", {})
    goal = str(sprintengine.get("goal") or "").strip()
    lines = [f"Sprint Engine run delivery for branch `{branch}`.", "", f"**Goal:** {goal or '_(not set)_'}"]
    done = [
        t
        for t in (state.get("tasks") or [])
        if isinstance(t, dict) and t.get("status") == "done" and folder_store.task_repo(t) == repo_id
    ]
    if done:
        lines += ["", f"## Tasks delivered ({len(done)})"]
        for task in done:
            title = str(task.get("title") or task.get("id") or "task").strip()
            role = str(task.get("role") or "").strip()
            lines.append(f"- {title}{f' _({role})_' if role else ''}")
            evidence = task.get("evidence")
            summary = str(evidence.get("summary")).strip() if isinstance(evidence, dict) and evidence.get("summary") else ""
            if summary:
                lines.append(f"  - {summary.splitlines()[0].strip()}")
    return "\n".join(lines)


def _repo_display_name(workspace_root: Path, repo: Dict[str, Any]) -> str:
    """What a person calls this project: its directory name, never its store id."""
    root = str(repo.get("root") or "")
    name = workspace_root.resolve().name if root == PRIMARY_REPO_ROOT else Path(root).name
    return name or str(repo.get("id") or "project")


def _companion_pull_request_lines(
    state: Dict[str, Any],
    workspace_root: Path,
    repos: List[Dict[str, Any]],
    urls: Dict[str, str],
    repo_id: str,
) -> List[str]:
    """One repo's "Companion pull requests" block, or ``[]`` when it has no companion.

    A run spanning projects ships as several pull requests that only mean anything
    together, and a reviewer landing on one has no way to find the rest. Every body
    therefore names all of them and says which must merge first and why. A repo whose
    pull request does not exist (no commits, or an open that failed) is not listed:
    the bodies state what is true now, and re-running ``vcs pr`` re-syncs them once it
    does exist. A single-repo run has no companions and gets no section at all.
    """
    by_id = {repo["id"]: repo for repo in repos}
    listed = [repo_id_ for repo_id_ in repo_merge_order(state, [repo["id"] for repo in repos]) if repo_id_ in urls]
    if len(listed) < 2 or repo_id not in urls:
        return []
    name_of = {listed_id: _repo_display_name(workspace_root, by_id[listed_id]) for listed_id in listed}
    ordering = [
        edge for edge in cross_repo_merge_edges(_state_tasks(state)) if edge[0] in urls and edge[1] in urls
    ]
    lines = ["", "## Companion pull requests", ""]
    if ordering:
        lines += [f"This sprint spans {len(listed)} projects. Merge these pull requests in this order:", ""]
        for position, listed_id in enumerate(listed, start=1):
            here = " — this pull request" if listed_id == repo_id else ""
            lines.append(f"{position}. **{name_of[listed_id]}** — {urls[listed_id]}{here}")
        lines.append("")
        lines += [
            f"- Work in **{name_of[consumer]}** builds on work in **{name_of[producer]}**, "
            f"so **{name_of[producer]}** has to merge first."
            for producer, consumer in ordering
        ]
    else:
        lines += [
            f"This sprint spans {len(listed)} projects. Nothing in either project depends on the other, "
            "so these pull requests can merge in any order:",
            "",
        ]
        for listed_id in listed:
            here = " — this pull request" if listed_id == repo_id else ""
            lines.append(f"- **{name_of[listed_id]}** — {urls[listed_id]}{here}")
    return lines


def _repo_pull_request_body(
    state: Dict[str, Any],
    workspace_root: Path,
    repos: List[Dict[str, Any]],
    urls: Dict[str, str],
    repo: Dict[str, Any],
    *,
    body_override: Optional[str],
) -> str:
    """One repo's full body: its description, plus the links to its companions.

    A ``--body`` override replaces the generated description, not the companion
    links: which pull requests must merge together is a fact about the run, not a
    description a caller is choosing to word differently.
    """
    override = _optional_str(body_override)
    base_body = override or build_run_pull_request_body(state, repo["branchName"], repo_id=repo["id"])
    companions = _companion_pull_request_lines(state, workspace_root, repos, urls, repo["id"])
    return "\n".join([base_body, *companions]) if companions else base_body


def _repo_has_run_commits(worktree: Path, base_ref: str) -> bool:
    """Whether this repo's run branch carries a commit its base does not.

    A project the run declared but never changed gets no pull request: an empty one is
    noise a reviewer has to close. Asked of git rather than of the stored
    ``lastCommitSha`` so a commit made in the tree by any route counts. When the base
    cannot be resolved the answer is unknown, and unknown must not silently skip a
    project — it reads as "has commits", and any real problem surfaces from ``gh``
    with its own reason attached.

    The base's upstream is excluded too (when one exists): a chained run's branch
    roots at the freshly-fetched remote-tracking ref (init ``--base-start-point``)
    while the stored ``baseRef`` stays the possibly-stale local branch, so counting
    ``base..HEAD`` alone would read the upstream commits the local base is missing
    as run commits — and push an empty branch whose ``gh pr create`` then fails.
    """
    if not base_ref:
        return True
    rev_args = ["rev-list", "--count", "HEAD", f"^{base_ref}"]
    upstream = run_git_checked(
        worktree,
        ["rev-parse", "--verify", "--quiet", "--abbrev-ref", f"{base_ref}@{{upstream}}"],
        allow_failure=True,
    )
    upstream_ref = upstream.stdout.strip()
    if upstream.returncode == 0 and upstream_ref:
        rev_args.append(f"^{upstream_ref}")
    counted = run_git_checked(worktree, rev_args, allow_failure=True)
    if counted.returncode != 0:
        return True
    return (counted.stdout.strip() or "0") != "0"


def _lookup_repo_pull_request_url(worktree: Path, branch: str) -> Optional[str]:
    """The url GitHub has for `branch`'s pull request, or None. Never raises.

    The recovery path for a `gh pr create` that succeeded without printing a url:
    the pull request is real, so it is asked for by branch rather than left unnamed.
    Best-effort like every other `gh` call here — an unreachable GitHub yields None
    and the caller records that as this repo's failure.
    """
    if not branch:
        return None
    try:
        viewed = run_gh_checked(worktree, ["pr", "view", branch, "--json", "url"], allow_failure=True)
    except SystemExit:
        return None  # gh is not installed; the caller already reports that.
    if viewed.returncode != 0:
        return None
    try:
        return _optional_str(json.loads(viewed.stdout or "{}").get("url"))
    except (ValueError, TypeError):
        return None


def _open_repo_pull_request(
    state: Dict[str, Any],
    vcs: Dict[str, Any],
    worktree: Path,
    repo: Dict[str, Any],
    *,
    base: Optional[str],
    title: Optional[str],
    body: str,
    draft: bool,
    push: bool,
    remote: str,
) -> Dict[str, Any]:
    """Push one repo's run branch and open its pull request. Never raises.

    Failure is recorded on THIS repo (``status: failed`` + ``pullRequestError``) and
    returned; the caller carries on with the other projects, because one project's
    unreachable remote is no reason to withhold the pull requests the rest are ready
    for. Idempotent on the repo's stored url: a re-run pushes any new commits and
    keeps the pull request it already has.
    """
    from sprintengine_core.tool.state import append_event

    repo_id = repo["id"]
    branch = repo["branchName"] or current_git_branch(worktree)
    base_branch = (base or "").strip() or str(repo.get("baseRef") or "").strip() or default_base_ref(worktree)
    result = {"repo": repo_id, "branch": branch, "base": base_branch}

    def failed(error: str) -> Dict[str, Any]:
        set_repo_status(vcs, repo_id, "failed")
        set_repo_pull_request(vcs, repo_id, url=repo.get("pullRequestUrl"), state=repo.get("pullRequestState"), error=error)
        return {**result, "ok": False, "error": error}

    if push:
        pushed = run_git_checked(worktree, ["push", "-u", remote, branch], allow_failure=True)
        if pushed.returncode != 0:
            return failed(pushed.stderr.strip() or pushed.stdout.strip() or "git push failed")
        set_repo_status(vcs, repo_id, "pushed")

    def opened(url: Optional[str], *, already_exists: bool) -> Dict[str, Any]:
        # `gh pr create` normally prints the url it opened, but a wrapper that
        # swallows stdout (or an older gh) leaves none to parse — and the pull request
        # exists all the same. Ask GitHub for it rather than recording an OPEN pull
        # request the run cannot name, which is the state that stalled the first
        # horizon lane (MC-1909).
        resolved = _optional_str(url)
        if not resolved:
            # Unreachable: every caller resolves the url (or fails) before it gets
            # here. Kept because recording an OPEN pull request the run cannot name is
            # exactly the state that stalled the first horizon lane (MC-1909), and the
            # state layer refuses it — this fails with the reason instead.
            return failed(
                "The pull request was opened but GitHub returned no url for it, so this run cannot "
                "name it. Re-run to adopt it, or open it on GitHub."
            )
        set_repo_status(vcs, repo_id, "pr_opened")
        # A pull request that already merged or closed keeps the state it reached:
        # `vcs pr-status` owns merge state, and adopting an existing pull request must
        # never report it back open.
        stored_state = repo.get("pullRequestState")
        reached = stored_state if already_exists and stored_state in VALID_PULL_REQUEST_STATES else "open"
        set_repo_pull_request(vcs, repo_id, url=resolved, state=reached, error=None)
        return {**result, "ok": True, "pullRequestUrl": resolved, **({"alreadyExists": True} if already_exists else {})}

    stored_url = _optional_str(repo.get("pullRequestUrl"))
    if stored_url:
        return opened(stored_url, already_exists=True)

    pr_title = (title or "").strip() or compact_commit_subject(
        f"SprintEngine: {str(state.get('sprintengine', {}).get('goal') or '').strip() or branch}"
    )
    try:
        pr = run_gh_checked(
            worktree,
            ["pr", "create", "--base", base_branch, "--head", branch, "--title", pr_title, "--body", body, *(["--draft"] if draft else [])],
            allow_failure=True,
        )
    except SystemExit as exc:
        # gh is not installed. Record it as a failure with the reason rather than
        # aborting the whole command, so the summary shows it and offers Retry.
        return failed(str(exc))
    if pr.returncode != 0:
        stderr = pr.stderr.strip()
        existing = parse_url_from_output(stderr) or parse_url_from_output(pr.stdout)
        if existing:
            return opened(existing, already_exists=True)
        # Push succeeded but the PR could not be opened (gh not authed, no remote,
        # API error). Record it as failed with the reason so the summary can show
        # the real error and a Retry, instead of a silent "pending" forever.
        return failed(stderr or pr.stdout.strip() or "gh pr create failed")

    url = parse_url_from_output(pr.stdout) or parse_url_from_output(pr.stderr) or _lookup_repo_pull_request_url(
        worktree, branch
    )
    if not url:
        return failed(
            "The pull request was opened but GitHub returned no url for it, so this run cannot name it. "
            "Re-run to adopt it, or open it on GitHub."
        )
    append_event(state, "run_pull_request_opened", "sprintengine", f"Opened pull request for {branch}: {url}.")
    return opened(url, already_exists=False)


def _sync_companion_bodies(
    state: Dict[str, Any],
    workspace_root: Path,
    repos: List[Dict[str, Any]],
    urls: Dict[str, str],
    worktrees: Dict[str, Path],
    *,
    body_override: Optional[str],
) -> List[Dict[str, str]]:
    """Second pass: rewrite every open body so each names its companions.

    Two passes are not a style choice. The first pull request opened cannot link a
    companion that does not exist yet, so the links can only be written once every
    pull request in the run has a url. Each body is rewritten whole from the run's
    current state, which is what makes a re-run re-sync (a repo that failed last time
    appears in every body this time) without ever stacking a second companion section.

    Returns one record per repo whose body could not be rewritten.
    """
    failures: List[Dict[str, str]] = []
    if len(urls) < 2:
        # Nothing to cross-link: a single-repo run's body is complete after pass one,
        # and rewriting it would only be a second `gh` call that changes nothing.
        return failures
    for repo in repos:
        url = urls.get(repo["id"])
        worktree = worktrees.get(repo["id"])
        # No url: no pull request to rewrite. No tree: the only way a pull request has
        # none is that it merged and its worktree was cleaned up, and a merged body is
        # history — the companions a reviewer still has to merge all say so themselves.
        if not url or not worktree:
            continue
        body = _repo_pull_request_body(state, workspace_root, repos, urls, repo, body_override=body_override)
        try:
            edited = run_gh_checked(worktree, ["pr", "edit", url, "--body", body], allow_failure=True)
        except SystemExit as exc:
            failures.append({"repo": repo["id"], "error": str(exc)})
            continue
        if edited.returncode != 0:
            failures.append({"repo": repo["id"], "error": edited.stderr.strip() or edited.stdout.strip() or "gh pr edit failed"})
    return failures


def create_run_pull_request(
    state: Dict[str, Any],
    state_path: Path,
    *,
    base: Optional[str] = None,
    title: Optional[str] = None,
    body: Optional[str] = None,
    draft: bool = False,
    push: bool = True,
    remote: str = "origin",
) -> Dict[str, Any]:
    """Open one pull request per project the run changed, cross-linked to each other.

    One project, one git tree, one pull request: a run spanning two projects delivers
    two branches to two remotes, and no single pull request can carry both. Projects
    the run never committed to are skipped — an empty pull request is noise. Projects
    that fail are recorded on their own entry and never roll back the pull requests
    the others already have; re-running the command retries exactly those.

    Bodies are written in two passes (see :func:`_sync_companion_bodies`). The result
    keeps the primary repo's fields at the top level, where every shipped surface
    still reads them, and reports every project under ``repos``.

    Best-effort throughout: network and remote failures are surfaced in the result
    rather than raised, so a completed run is never lost to an unreachable remote.
    """
    vcs = get_run_vcs(state)
    if not vcs:
        return {"ok": False, "error": "Sprint Engine run is not in worktree mode; no branch to open a pull request from."}

    workspace_root = workspace_root_for_state_path(state_path)
    repos = vcs_repos(vcs)
    worktrees: Dict[str, Path] = {}
    for repo in repos:
        worktree = _repo_worktree(state_path, repo)
        if worktree and worktree.exists():
            worktrees[repo["id"]] = worktree

    # Pass one: open (or adopt) every pull request. Bodies carry no companion links
    # yet — the companions do not all have urls until this loop finishes.
    results: List[Dict[str, Any]] = []
    urls: Dict[str, str] = {}
    for repo in repos:
        worktree = worktrees.get(repo["id"])
        if not worktree:
            # The tree is only removed after its pull request merges, so a merged repo
            # is simply already delivered. Any other missing tree is a real fault and
            # is reported as this repo's failure, never as the run's.
            if repo.get("pullRequestState") == "merged":
                results.append({"repo": repo["id"], "ok": True, "skipped": "merged", "pullRequestUrl": repo.get("pullRequestUrl")})
                url = _optional_str(repo.get("pullRequestUrl"))
                if url:
                    urls[repo["id"]] = url
            else:
                results.append({"repo": repo["id"], "ok": False, "error": f"Sprint Engine worktree is missing: {repo['worktreePath']}"})
            continue
        # A repo that already has a pull request is never re-judged on its commits:
        # once its branch merges, its commits ARE its base, and re-reading that as
        # "nothing to deliver" would drop the pull request out of its companions'
        # bodies on the next sync.
        if not _optional_str(repo.get("pullRequestUrl")) and not _repo_has_run_commits(
            worktree, str(repo.get("baseRef") or "").strip()
        ):
            results.append({"repo": repo["id"], "ok": True, "skipped": "no_commits", "branch": repo["branchName"]})
            continue
        opened = _open_repo_pull_request(
            state,
            vcs,
            worktree,
            repo,
            base=base,
            title=title,
            body=_repo_pull_request_body(state, workspace_root, repos, {}, repo, body_override=body),
            draft=draft,
            push=push,
            remote=remote,
        )
        results.append(opened)
        url = _optional_str(opened.get("pullRequestUrl"))
        if url:
            urls[repo["id"]] = url

    # Pass two: now that every url exists, give each body its companion links.
    body_failures = _sync_companion_bodies(state, workspace_root, repos, urls, worktrees, body_override=body)

    # Every project also reports the name a person calls it, so the surfaces that show
    # these pull requests (the app, the phone, the Backlog item's links) label them the
    # same way the pull request bodies do instead of each deriving it again.
    names = {repo["id"]: _repo_display_name(workspace_root, repo) for repo in repos}
    for entry in results:
        entry["project"] = names.get(entry["repo"], entry["repo"])

    primary = next((result for result in results if result["repo"] == PRIMARY_REPO_ID), {})
    failures = [result for result in results if not result.get("ok")]
    error = failures[0].get("error") if failures else None
    if not error and body_failures:
        error = (
            f"Opened every pull request, but could not add the companion links to {body_failures[0]['repo']}: "
            f"{body_failures[0]['error']}. Re-run to sync the bodies."
        )
    return {
        "ok": not failures and not body_failures,
        **{key: value for key, value in primary.items() if key in ("branch", "base", "pullRequestUrl", "alreadyExists", "skipped")},
        **({"error": error} if error else {}),
        "repos": results,
        **({"bodySyncFailures": body_failures} if body_failures else {}),
    }


def _refresh_repo_pull_request_state(state_path: Path, repo: Dict[str, Any]) -> Optional[str]:
    """Resolve whether one repo's run branch has merged. Never raises.

    Merged if EITHER signal says so: the GitHub PR reports ``MERGED`` (authoritative,
    also covers squash/rebase done through the PR), OR the branch tip is an ancestor
    of its base ref (catches a branch merged into main manually, without the PR merge
    button — and a branch merged with no PR at all). A squash/rebase merge performed
    outside a PR rewrites history and is not detectable here; through a PR, ``gh``
    reports it. All git/gh calls are best-effort.

    ``None`` when the repo has NO pull request and nothing says its branch landed.
    That is the second route into MC-1909's stalled state: this used to start every
    repo at ``"open"``, so probing a project that had never opened a pull request
    stamped ``pullRequestState: open`` beside a null url and a null error — the
    contradiction the lane's auto-merge could not act on — without `gh pr create`
    being involved at all. A repo with no pull request now says so.
    """
    workspace_root = workspace_root_for_state_path(state_path)
    worktree = _repo_worktree(state_path, repo)
    # Once a merged worktree is cleaned up, the repo's own root still answers for it.
    cwd = worktree if (worktree and worktree.exists()) else resolve_vcs_path(workspace_root, repo["root"])
    branch = repo["branchName"]
    base = str(repo.get("baseRef") or "").strip()
    url = _optional_str(repo.get("pullRequestUrl"))

    # A repo with a pull request is open until GitHub or git says otherwise; a repo
    # with none has no state to report unless its branch turns out to have landed.
    pr_state: Optional[str] = "open" if url else None

    # 1. Authoritative: the GitHub PR's own state.
    if url:
        try:
            viewed = run_gh_checked(cwd, ["pr", "view", url, "--json", "state"], allow_failure=True)
        except SystemExit:
            viewed = None  # gh not installed; fall through to the git signal
        if viewed is not None and viewed.returncode == 0:
            try:
                gh_state = str(json.loads(viewed.stdout or "{}").get("state") or "").upper()
            except (ValueError, TypeError):
                gh_state = ""
            if gh_state == "MERGED":
                pr_state = "merged"
            elif gh_state == "CLOSED":
                pr_state = "closed"

    # 2. Branch ancestry — catches a manual merge into the base (and a no-PR merge).
    #    Only meaningful once the run has committed work in THIS repo: an empty branch
    #    whose tip still equals base would otherwise read as a spurious "merged" (a
    #    commit is its own ancestor). `lastCommitSha` is set exactly when the repo
    #    committed, so a project the run never touched never reports itself merged.
    has_commits = bool(_optional_str(repo.get("lastCommitSha")))
    if pr_state in (None, "open") and has_commits and branch and base:
        run_git_checked(cwd, ["fetch", "origin", base], allow_failure=True)
        tip = run_git_checked(cwd, ["rev-parse", branch], allow_failure=True)
        branch_tip = tip.stdout.strip() if tip.returncode == 0 else ""
        if branch_tip:
            for candidate in (base, f"origin/{base}"):
                ancestor = run_git_checked(cwd, ["merge-base", "--is-ancestor", branch_tip, candidate], allow_failure=True)
                if ancestor.returncode == 0:
                    pr_state = "merged"
                    break

    return pr_state


def refresh_run_pull_request_state(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    """Resolve and persist whether each project's run branch has merged.

    Every project merges on its own schedule — that is the whole point of one pull
    request per project — so each repo's state is resolved against its own branch,
    base, and pull request. The primary's state stays at the top level, where the
    summary chip and the poll supervisor read it; ``repos`` carries all of them.
    """
    vcs = get_run_vcs(state)
    if not vcs:
        return {"ok": True, "enabled": False, "pullRequestState": None}

    repos: List[Dict[str, str]] = []
    for repo in vcs_repos(vcs):
        pr_state = _refresh_repo_pull_request_state(state_path, repo)
        _set_repo_field(vcs, repo["id"], "pullRequestState", pr_state)
        repos.append({"repo": repo["id"], "pullRequestState": pr_state})
    return {
        "ok": True,
        "enabled": True,
        "pullRequestState": vcs.get("pullRequestState"),
        "repos": repos,
        "vcs": vcs,
    }


def cleanup_merged_worktree(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    """Remove each project's run worktree once ITS branch has merged, if it is clean.

    A project's tree goes when that project's pull request lands, independently of
    every other project's: a merged desktop PR should not keep its checkout around
    waiting on the mobile one. Only ever after a merge is confirmed, and never for a
    tree with uncommitted changes (the work would be lost) — no force-remove, and the
    branch is not deleted. The run directory outlives them all: it holds the run
    record and the sibling trees, so the summary survives the last removal.

    The primary's outcome stays at the top level for the callers that only ever knew
    one worktree; ``repos`` carries every project's.
    """
    from sprintengine_core.tool.state import append_event

    vcs = get_run_vcs(state)
    if not vcs:
        return {"removed": False, "reason": "not_worktree_mode"}

    workspace_root = workspace_root_for_state_path(state_path)
    outcomes: Dict[str, Dict[str, Any]] = {}
    for repo in vcs_repos(vcs):
        outcome = _cleanup_repo_worktree(state_path, workspace_root, repo)
        outcomes[repo["id"]] = outcome
        if outcome["removed"]:
            append_event(
                state, "run_worktree_removed", "sprintengine", f"Removed merged run worktree {repo['worktreePath']}."
            )
    primary = outcomes.get(PRIMARY_REPO_ID, {"removed": False, "reason": "missing"})
    return {**primary, "repos": [{"repo": repo_id, **outcome} for repo_id, outcome in outcomes.items()]}


# How `gh` is asked to land a branch. A merge commit is the default because it is the
# only method that leaves the branch tip an ancestor of its base, which is the signal
# `_refresh_repo_pull_request_state` falls back on when GitHub cannot be reached.
VALID_MERGE_METHODS = {"merge", "squash", "rebase"}


def _merge_order_refusal(workspace_root: Path, repos: List[Dict[str, Any]], repo: Dict[str, Any], blockers: List[str]) -> str:
    """Why this pull request cannot merge yet, in the words of the person merging it."""
    by_id = {entry["id"]: entry for entry in repos}
    name = _repo_display_name(workspace_root, repo)
    lines = [f"{name} cannot merge yet, because the work in it builds on work in another project:"]
    for blocker in blockers:
        blocker_name = _repo_display_name(workspace_root, by_id[blocker])
        waiting = (
            "its pull request is still open"
            if _optional_str(by_id[blocker].get("pullRequestUrl"))
            else "it does not have a pull request open yet"
        )
        lines.append(f"- {blocker_name} has to merge first — {waiting}.")
    lines.append(
        f"Merging {name} now would put its branch on a base that is missing that work. "
        "Merge the pull request(s) above first, then this one."
    )
    return "\n".join(lines)


def merge_repo_pull_request(
    state: Dict[str, Any],
    state_path: Path,
    *,
    repo_id: str = PRIMARY_REPO_ID,
    method: str = "merge",
    actor: str = "user",
) -> Dict[str, Any]:
    """Merge ONE project's pull request, in the app, refusing an out-of-order merge.

    Merging is a human decision and stays one: this only ever runs because a person
    asked for this project, now. What it does own is the ORDER — a run spanning projects
    delivers pull requests that build on each other, and merging the consumer first
    lands it on a base without the work it needs. The pull request bodies say so for
    anyone merging on GitHub directly (:func:`_companion_pull_request_lines`); here,
    where the app owns the button, it is refused outright.

    Idempotent: every project's merge state is re-probed first, so a pull request that
    already merged (through this command, the GitHub UI, or a manual branch merge)
    reports success without a second `gh` call, and the ordering check is decided on
    what is true now rather than on what the store last heard.

    Best-effort like the rest of the pull-request pipeline: a `gh` failure comes back as
    ``ok: False`` with its reason, never as an exception.
    """
    from sprintengine_core.tool.state import append_event

    if method not in VALID_MERGE_METHODS:
        return {"ok": False, "error": f"Unknown merge method {method!r}; use one of: {', '.join(sorted(VALID_MERGE_METHODS))}."}

    vcs = get_run_vcs(state)
    if not vcs:
        return {"ok": False, "error": "Sprint Engine run is not in worktree mode; there is no pull request to merge."}

    workspace_root = workspace_root_for_state_path(state_path)
    repos = vcs_repos(vcs)
    if not any(repo["id"] == repo_id for repo in repos):
        return {
            "ok": False,
            "error": (
                f"This sprint does not work in project {repo_id!r}. "
                f"This sprint's projects are: {', '.join(repo['id'] for repo in repos)}."
            ),
        }

    # Both decisions below — "is it already merged" and "may it merge yet" — are only as
    # true as the states they read, so refresh before trusting the last poll. Only the
    # merging repo and the projects it structurally builds on affect either decision, so
    # probe exactly those: a solo merge costs one `gh` probe, not one per project.
    to_probe = {repo_id, *_structural_merge_predecessors(state, repos, repo_id)}
    for entry in repos:
        if entry["id"] not in to_probe:
            continue
        entry["pullRequestState"] = _refresh_repo_pull_request_state(state_path, entry)
        _set_repo_field(vcs, entry["id"], "pullRequestState", entry["pullRequestState"])
    repo = next(entry for entry in repos if entry["id"] == repo_id)
    result = {"repo": repo_id, "pullRequestUrl": _optional_str(repo.get("pullRequestUrl"))}

    if repo["pullRequestState"] == "merged":
        return {**result, "ok": True, "merged": True, "alreadyMerged": True, **_cleanup_after_merge(state, state_path, repo)}
    if repo["pullRequestState"] == "closed":
        return {**result, "ok": False, "error": f"The pull request for {_repo_display_name(workspace_root, repo)} was closed without merging."}
    url = result["pullRequestUrl"]
    if not url:
        return {
            **result,
            "ok": False,
            "error": f"{_repo_display_name(workspace_root, repo)} has no pull request to merge yet. Open one first.",
        }

    blockers = _repos_that_must_merge_first(state, repos, repo_id)
    if blockers:
        return {**result, "ok": False, "blockedBy": blockers, "error": _merge_order_refusal(workspace_root, repos, repo, blockers)}

    worktree = _repo_worktree(state_path, repo)
    cwd = worktree if (worktree and worktree.exists()) else resolve_vcs_path(workspace_root, repo["root"])
    try:
        merged = run_gh_checked(cwd, ["pr", "merge", url, f"--{method}"], allow_failure=True)
    except SystemExit as exc:
        return {**result, "ok": False, "error": str(exc)}
    if merged.returncode != 0:
        return {**result, "ok": False, "error": merged.stderr.strip() or merged.stdout.strip() or "gh pr merge failed"}

    # Read the merge back from GitHub rather than assuming a zero exit means merged:
    # the store's merge state drives worktree cleanup and the run's glyph, and both are
    # worse wrong than late.
    repo["pullRequestState"] = _refresh_repo_pull_request_state(state_path, repo)
    _set_repo_field(vcs, repo_id, "pullRequestState", repo["pullRequestState"])
    if repo["pullRequestState"] != "merged":
        return {
            **result,
            "ok": False,
            "pullRequestState": repo["pullRequestState"],
            "error": (
                f"GitHub accepted the merge for {_repo_display_name(workspace_root, repo)} but still reports the "
                "pull request unmerged. Check it on GitHub before merging anything that depends on it."
            ),
        }
    append_event(state, "run_pull_request_merged", actor, f"{actor} merged the pull request for {repo['branchName']} in {repo_id}: {url}.")
    return {**result, "ok": True, "merged": True, "alreadyMerged": False, **_cleanup_after_merge(state, state_path, repo)}


def _cleanup_after_merge(state: Dict[str, Any], state_path: Path, repo: Dict[str, Any]) -> Dict[str, Any]:
    """Remove this project's tree now that its branch landed, and report the outcome.

    Only this project's: the other projects' trees are still live work
    (:func:`cleanup_merged_worktree` is the same rule applied to all of them).
    """
    from sprintengine_core.tool.state import append_event

    workspace_root = workspace_root_for_state_path(state_path)
    outcome = _cleanup_repo_worktree(state_path, workspace_root, repo)
    if outcome["removed"]:
        append_event(state, "run_worktree_removed", "sprintengine", f"Removed merged run worktree {repo['worktreePath']}.")
    return {"worktreeCleanup": outcome}


def _cleanup_repo_worktree(state_path: Path, workspace_root: Path, repo: Dict[str, Any]) -> Dict[str, Any]:
    if repo.get("pullRequestState") != "merged":
        return {"removed": False, "reason": "not_merged"}
    worktree = _repo_worktree(state_path, repo)
    if not worktree or not worktree.exists():
        return {"removed": False, "reason": "missing"}
    if git_status_short(worktree).strip():
        return {"removed": False, "reason": "dirty"}
    repo_root = resolve_vcs_path(workspace_root, repo["root"])
    removed = run_git_checked(repo_root, ["worktree", "remove", str(worktree)], allow_failure=True)
    if removed.returncode != 0:
        return {"removed": False, "reason": (removed.stderr.strip() or removed.stdout.strip() or "git worktree remove failed")}
    return {"removed": True}
