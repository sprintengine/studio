"""Shell and Git helpers for Sprint Engine run worktrees."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.constants import VALID_VCS_STATUSES
from sprintengine_core.tool.paths import project_relative_path, resolve_vcs_path, workspace_root_for_state_path

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


def get_run_vcs(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    vcs = state.get("sprintengine", {}).get("vcs")
    return vcs if isinstance(vcs, dict) and vcs.get("mode") == "run_worktree" else None


# Entry zero of `vcs.repos` is the run's primary repo: the workspace itself, so its
# root is the workspace-relative ".". Sibling repos are appended after it.
PRIMARY_REPO_ID = "primary"
PRIMARY_REPO_ROOT = "."

# A sibling repo id names a directory on disk (`worktree-<id>`) and is typed by
# humans into task cards, so it stays to the characters a path and a task field can
# both carry without quoting.
SIBLING_REPO_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

# The repo-entry fields a store must carry for the engine to resolve a tree at all.
# Absent or blank means a corrupt store, not a legacy one: the pre-`repos` shape has
# no `repos` key whatsoever and is derived from the flat block instead.
_REQUIRED_REPO_KEYS = ("id", "root", "worktreePath", "branchName")

# Merge states one repo's pull request can be in. `open` until GitHub says the PR
# merged or closed, or the branch lands in its base; the other two are terminal.
VALID_PULL_REQUEST_STATES = {"open", "merged", "closed"}

# The per-repo fields the primary repo also stores flat on `vcs`, because the app,
# the mobile snapshot, and the PR surfaces still read them there.
_PRIMARY_MIRRORED_KEYS = ("status", "lastCommitSha", "pullRequestUrl", "pullRequestState", "pullRequestError")


def _optional_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


def _repo_entry(
    *,
    repo_id: str,
    root: str,
    worktree_path: str,
    branch_name: str,
    base_ref: Optional[str],
    status: Optional[str],
    last_commit_sha: Optional[str],
    pull_request_url: Optional[str] = None,
    pull_request_state: Optional[str] = None,
    pull_request_error: Optional[str] = None,
) -> Dict[str, Any]:
    """One declared repo. The single site that spells the entry shape.

    A run spanning two projects opens one pull request per project, so the PR fields
    belong to the repo that owns the branch they describe (MC-1612), not to the run.
    """
    return {
        "id": repo_id,
        "root": root,
        "worktreePath": worktree_path,
        "branchName": branch_name,
        "baseRef": base_ref,
        "status": status if status in VALID_VCS_STATUSES else "not_created",
        "lastCommitSha": last_commit_sha if isinstance(last_commit_sha, str) else None,
        "pullRequestUrl": _optional_str(pull_request_url),
        "pullRequestState": pull_request_state if pull_request_state in VALID_PULL_REQUEST_STATES else None,
        "pullRequestError": _optional_str(pull_request_error),
    }


def _normalized_repo_entry(raw: Any, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit(f"Sprint Engine run store is corrupt: vcs.repos[{index}] is not a mapping.")
    missing = [key for key in _REQUIRED_REPO_KEYS if not str(raw.get(key) or "").strip()]
    if missing:
        raise SystemExit(
            f"Sprint Engine run store is corrupt: vcs.repos[{index}] is missing {', '.join(missing)}. "
            "Delete the team folder and re-run the sprint."
        )
    base_ref = str(raw.get("baseRef") or "").strip()
    return _repo_entry(
        repo_id=str(raw["id"]).strip(),
        root=str(raw["root"]).strip(),
        worktree_path=str(raw["worktreePath"]).strip(),
        branch_name=str(raw["branchName"]).strip(),
        base_ref=base_ref or None,
        status=raw.get("status"),
        last_commit_sha=raw.get("lastCommitSha"),
        pull_request_url=raw.get("pullRequestUrl"),
        pull_request_state=raw.get("pullRequestState"),
        pull_request_error=raw.get("pullRequestError"),
    )


def _primary_repo_entry_from_flat(vcs: Dict[str, Any]) -> Dict[str, Any]:
    """The primary repo entry a pre-`repos` store describes with its flat fields."""
    base_ref = str(vcs.get("baseRef") or "").strip()
    return _repo_entry(
        repo_id=PRIMARY_REPO_ID,
        root=PRIMARY_REPO_ROOT,
        worktree_path=str(vcs.get("worktreePath") or "").strip(),
        branch_name=str(vcs.get("branchName") or "").strip(),
        base_ref=base_ref or None,
        status=vcs.get("status"),
        last_commit_sha=vcs.get("lastCommitSha"),
        pull_request_url=vcs.get("pullRequestUrl"),
        pull_request_state=vcs.get("pullRequestState"),
        pull_request_error=vcs.get("pullRequestError"),
    )


def vcs_repos(vcs: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The repos a run declares, from either shape the store may carry.

    A run created before `vcs.repos` (MC-1611) describes its one repo with the flat
    `worktreePath`/`branchName`/... fields on `vcs`; it reads back here as the
    one-entry list a single-repo run has always semantically been, so callers only
    ever handle the list. Entry zero is always the primary repo.
    """
    if not isinstance(vcs, dict):
        return []
    raw_repos = vcs.get("repos")
    if not isinstance(raw_repos, list) or not raw_repos:
        return [_primary_repo_entry_from_flat(vcs)]
    return [_normalized_repo_entry(raw, index) for index, raw in enumerate(raw_repos)]


def _stored_primary_repo(vcs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The mutable stored entry zero, when the store carries the list shape."""
    repos = vcs.get("repos")
    if isinstance(repos, list) and repos and isinstance(repos[0], dict):
        return repos[0]
    return None


def _stored_repo(vcs: Dict[str, Any], repo_id: str) -> Optional[Dict[str, Any]]:
    """The mutable stored entry for one declared repo, by id.

    :func:`vcs_repos` hands out normalized copies, so a writer that must persist
    reaches for the stored dict here instead.
    """
    for repo in vcs.get("repos") or []:
        if isinstance(repo, dict) and str(repo.get("id") or "").strip() == repo_id:
            return repo
    return None


def _set_repo_field(vcs: Dict[str, Any], repo_id: str, key: str, value: Any) -> None:
    """Write one field of one declared repo, on every shape that stores it.

    The primary's fields are also the run's flat `vcs.*` fields — what the app, the
    mobile snapshot, and the PR surfaces still read — so a primary write lands on the
    flat block and on entry zero of `repos`, and the two cannot drift while both
    exist. A sibling's fields are its own entry alone, so work in one project never
    reports itself as what the primary tree is doing.
    """
    if repo_id == PRIMARY_REPO_ID:
        if key in _PRIMARY_MIRRORED_KEYS:
            vcs[key] = value
        repo = _stored_primary_repo(vcs)
    else:
        repo = _stored_repo(vcs, repo_id)
    if repo is not None:
        repo[key] = value


def set_vcs_status(vcs: Dict[str, Any], status: str) -> None:
    """Record the primary repo's worktree status on both shapes that store it."""
    _set_repo_field(vcs, PRIMARY_REPO_ID, "status", status)


def set_vcs_last_commit_sha(vcs: Dict[str, Any], sha: Optional[str]) -> None:
    """Record the primary repo's last commit on both shapes that store it."""
    _set_repo_field(vcs, PRIMARY_REPO_ID, "lastCommitSha", sha)


def set_repo_status(vcs: Dict[str, Any], repo_id: str, status: str) -> None:
    """Record one declared repo's worktree status."""
    _set_repo_field(vcs, repo_id, "status", status)


def set_repo_last_commit_sha(vcs: Dict[str, Any], repo_id: str, sha: Optional[str]) -> None:
    """Record one declared repo's last commit."""
    _set_repo_field(vcs, repo_id, "lastCommitSha", sha)


def set_repo_pull_request(
    vcs: Dict[str, Any],
    repo_id: str,
    *,
    url: Optional[str],
    state: Optional[str],
    error: Optional[str],
) -> None:
    """Record one repo's pull-request outcome: its url, merge state, and last failure.

    Written together because they are one fact — a repo has a pull request, or it has
    a reason it has none — and writing them apart is how a store ends up claiming an
    open pull request and a stale failure at the same time.
    """
    _set_repo_field(vcs, repo_id, "pullRequestUrl", url)
    _set_repo_field(vcs, repo_id, "pullRequestState", state)
    _set_repo_field(vcs, repo_id, "pullRequestError", error)


def parse_repo_declaration(value: str) -> Dict[str, str]:
    """One `--repo <id>=<path>` declaration, parsed but not yet resolved on disk.

    Syntax only: whether the path is a real git repo is decided against the
    workspace in :func:`_declared_sibling_entries`, which is the only place that
    knows where the run lives.
    """
    raw = str(value or "").strip()
    repo_id, separator, root = (part.strip() for part in raw.partition("="))
    if not separator or not repo_id or not root:
        raise SystemExit(
            f"--repo must be <name>=<path>, for example --repo mobile=../multicode-mobile. Got: {raw or '(empty)'}"
        )
    if not SIBLING_REPO_ID_PATTERN.match(repo_id):
        raise SystemExit(
            f"--repo name {repo_id!r} is not usable: use lowercase letters, digits, dots, dashes, or underscores, "
            "starting with a letter or digit, for example 'mobile'."
        )
    if repo_id == PRIMARY_REPO_ID:
        raise SystemExit(
            f"--repo name {PRIMARY_REPO_ID!r} is reserved for this project itself; give the other project a different name."
        )
    return {"id": repo_id, "root": root}


def parse_repo_declarations(values: List[str]) -> List[Dict[str, str]]:
    declared: List[Dict[str, str]] = []
    for value in values or []:
        repo = parse_repo_declaration(value)
        if any(existing["id"] == repo["id"] for existing in declared):
            raise SystemExit(f"--repo {repo['id']} was declared twice; each project needs its own name.")
        declared.append(repo)
    return declared


def _declared_sibling_root(workspace_root: Path, repo_id: str, raw_root: str) -> Path:
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
    toplevel = run_git_checked(root, ["rev-parse", "--show-toplevel"], allow_failure=True)
    if toplevel.returncode != 0 or Path(toplevel.stdout.strip() or "/nonexistent").resolve() != root:
        raise SystemExit(f"Project {repo_id!r} at {raw_root} is not a git repository. A sprint can only span git projects.")
    return root


def _declared_sibling_entries(
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
        root = _declared_sibling_root(workspace_root, repo_id, repo["root"])
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


def _ensure_repo_worktree(workspace_root: Path, repo: Dict[str, Any]) -> None:
    """Create (or adopt) one declared repo's run worktree and record it ready.

    Raises rather than recording a failed status: a run that cannot get a tree for
    every project it declares has no safe partial state to continue from, so init
    aborts and the operator fixes the declaration.
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
            base = str(repo.get("baseRef") or "").strip() or default_base_ref(repo_root)
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
        _declared_sibling_entries(workspace_root, state_path, repos, branch=branch)
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
        _ensure_repo_worktree(workspace_root, repo)
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


def primary_run_worktree(state: Dict[str, Any], state_path: Path) -> Optional[Path]:
    """The primary repo's run worktree, or None outside worktree mode.

    The run-level tree: the branch a pull request is opened from and the checkout
    teardown removes. Work belonging to a task resolves through
    :func:`worktree_for_task` instead — on a multi-repo run those are different
    trees, and only the task knows which one its paths live in.
    """
    vcs = get_run_vcs(state)
    if not vcs:
        return None
    return _repo_worktree(state_path, vcs_repos(vcs)[0])


def repo_for_task(state: Dict[str, Any], task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The declared repo entry a task's changes belong in, None outside worktree mode.

    A task's repo is validated against the run's declared repos when it is created
    and again when it is claimed (``ensure_task_repo_declared``), so a stored task
    naming an undeclared repo means the run store and the declaration disagree.
    That fails loudly here rather than falling back to the primary tree, which
    would commit one project's paths into another.
    """
    from sprintengine_core import store as folder_store

    vcs = get_run_vcs(state)
    if not vcs:
        return None
    repos = vcs_repos(vcs)
    repo_id = folder_store.task_repo(task)
    for repo in repos:
        if repo["id"] == repo_id:
            return repo
    raise SystemExit(
        f"Task {task.get('id')} targets project {repo_id!r}, which this sprint does not work in. "
        f"This sprint's projects are: {', '.join(repo['id'] for repo in repos)}."
    )


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


def _path_in_scope(path: str, pathspec: List[str]) -> bool:
    for entry in pathspec:
        if path == entry or path.startswith(entry + "/"):
            return True
    return False


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


def commit_run_worktree_paths(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    *,
    explicit_paths: Optional[List[str]] = None,
) -> Optional[str]:
    """Stage and commit only the current task's paths in its repo's run worktree.

    Serialized through that repo's ``runner/git.commit.<repoId>.lock`` so concurrent
    agents never race a git index — and only agents working the same project ever
    wait on each other, since each repo has its own index. Stages a pathspec built
    from the task's owned paths, logged touched files, and any explicitly passed
    paths — never ``git add -A`` — and tolerates files another agent already
    committed (those are simply clean and contribute nothing to this commit).
    Returns the new short SHA, or ``None`` when worktree mode is off or there is
    nothing in scope to commit.
    """
    from sprintengine_core import store as folder_store
    from sprintengine_core.tool.state import append_event
    from sprintengine_core.tool.tasks import ensure_evidence, task_diff_declared_paths

    repo = repo_for_task(state, task)
    worktree = _repo_worktree(state_path, repo) if repo else None
    if not repo or not worktree:
        return None
    if not worktree.exists():
        raise SystemExit(f"Sprint Engine worktree is missing: {worktree}")

    vcs = get_run_vcs(state)
    declared = task_diff_declared_paths(task, explicit_paths or [])
    owned = [str(path) for path in task.get("ownedPaths", []) or []]
    pathspec = _normalize_commit_pathspec(worktree, [*declared, *owned])

    lock = folder_store.FolderLock(state_path.parent / folder_store.git_commit_lock_file(repo["id"]))
    lock.acquire(recover_stale=True)
    try:
        status_out = run_git_checked(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout
        dirty = _parse_porcelain_z(status_out)
        if vcs is not None:
            set_repo_status(vcs, repo["id"], "dirty" if dirty else "ready")
        if not pathspec:
            return None
        in_scope = sorted({record["path"] for record in dirty if _path_in_scope(record["path"], pathspec)})
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
    append_event(state, "task_changes_committed", actor, f"{actor} committed Sprint Engine changes for {task_id}: {sha}.")
    return sha


def commit_task_changes_if_needed(state: Dict[str, Any], state_path: Path, task: Dict[str, Any], actor: str) -> Optional[str]:
    """Backstop commit when a task is marked done in worktree mode.

    Agents normally commit per task through ``sprintengine vcs commit``; this
    runs the same locked, pathspec-limited commit so any still-uncommitted
    task-scoped changes are captured before the task is recorded done.
    """
    return commit_run_worktree_paths(state, state_path, task, actor)


def worktree_orphaned_dirty_paths(state: Dict[str, Any], state_path: Path, repo: Dict[str, Any]) -> List[str]:
    """Dirty paths in one repo's run worktree that fall inside no task's ownedPaths.

    Per-task commits stage only owned + declared paths (never ``git add -A``, which
    would sweep another agent's work into this commit). A change that lands inside
    *no* task's ``ownedPaths`` is therefore picked up by nobody's commit and would
    be silently dropped from the run — for example a new directory an author
    created but never added to their task's owned paths (the failure that made a
    published commit import files absent from HEAD). Dirty paths that fall inside
    some task's owned paths are expected concurrent work and are not returned here.

    Ownership is read from the tasks targeting THIS repo only: owned paths are
    repo-relative, so a primary task owning ``src/x.ts`` says nothing about the
    mobile tree's ``src/x.ts`` and must not excuse it.

    Returns sorted project-relative posix paths. Advisory: read without the commit
    lock, so it reflects a point-in-time view of a shared worktree.
    """
    from sprintengine_core import store as folder_store

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
        if isinstance(task, dict) and folder_store.task_repo(task) == repo["id"]:
            all_owned.extend(str(path) for path in (task.get("ownedPaths") or []))
    owned_pathspec = _normalize_commit_pathspec(worktree, all_owned)
    return sorted(
        {
            record["path"]
            for record in dirty
            if record["path"] and not _path_in_scope(record["path"], owned_pathspec)
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


def _owned_path_parent_dirs(worktree: Path, task: Dict[str, Any]) -> List[str]:
    """Normalized parent directories of a task's owned paths (the dirs it works in)."""
    owned = _normalize_commit_pathspec(worktree, [str(p) for p in (task.get("ownedPaths") or [])])
    parents: List[str] = []
    for path in owned:
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        if parent and parent not in parents:
            parents.append(parent)
    return parents


def task_scoped_orphaned_dirty_paths(
    state: Dict[str, Any], state_path: Path, task: Dict[str, Any]
) -> List[str]:
    """Orphaned dirty paths that sit in a directory this task already works in.

    Narrows :func:`worktree_orphaned_dirty_paths` to the orphans that fall inside
    the parent directory of one of this task's owned paths — the strong
    missed-scope signal (e.g. an owned ``a/b/Panel.tsx`` shell next to a new,
    unowned ``a/b/Panel/helper.ts``). Incidental untracked files elsewhere in the
    shared worktree (scratch files, screenshots, another concern's noise) are not
    returned, so they warn at commit time but never block this task's publish.

    Scans only the tree this task works in. A task cannot answer for a project it
    does not touch, so an orphan in another declared repo is the run's problem to
    block on (:func:`run_orphaned_dirty_paths`), never this publish's.
    """
    repo = repo_for_task(state, task)
    worktree = _repo_worktree(state_path, repo) if repo else None
    if not repo or not worktree or not worktree.exists():
        return []
    orphaned = worktree_orphaned_dirty_paths(state, state_path, repo)
    if not orphaned:
        return []
    parents = _owned_path_parent_dirs(worktree, task)
    if not parents:
        return []
    return [
        path
        for path in orphaned
        if any(path == parent or path.startswith(parent + "/") for parent in parents)
    ]


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
    return sorted({record["path"] for record in dirty if _path_in_scope(record["path"], pathspec)})


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


def _cross_repo_merge_edges(state: Dict[str, Any]) -> List[List[str]]:
    """``[producer, consumer]`` repo pairs implied by cross-repo task dependencies.

    A task in one project depending on a task in another says the other project's
    pull request must land first — otherwise the consumer merges against work that is
    not on its base yet. Dependencies inside one project say nothing about merge
    order: a single pull request carries both ends.
    """
    from sprintengine_core import store as folder_store

    tasks = [task for task in (state.get("tasks") or []) if isinstance(task, dict)]
    repo_by_task = {str(task.get("id") or ""): folder_store.task_repo(task) for task in tasks}
    edges: List[List[str]] = []
    for task in tasks:
        consumer = folder_store.task_repo(task)
        for dependency in task.get("dependsOn") or []:
            producer = repo_by_task.get(str(dependency))
            if producer and producer != consumer and [producer, consumer] not in edges:
                edges.append([producer, consumer])
    return edges


def repo_merge_order(state: Dict[str, Any], repo_ids: List[str]) -> List[str]:
    """The given repos in the order their pull requests must merge.

    Producers before consumers, declaration order breaking every tie so the same run
    always states the same order. Repo-level dependency cycles are rejected at plan
    time; if one reaches here anyway, the repos it traps keep their declaration order
    rather than being dropped — an order a reviewer can question beats a body that
    silently omits a pull request.
    """
    edges = [edge for edge in _cross_repo_merge_edges(state) if edge[0] in repo_ids and edge[1] in repo_ids]
    remaining = list(repo_ids)
    ordered: List[str] = []
    while remaining:
        free = [
            repo_id
            for repo_id in remaining
            if not any(consumer == repo_id and producer in remaining for producer, consumer in edges)
        ]
        if not free:
            ordered.extend(remaining)
            break
        ordered.append(free[0])
        remaining.remove(free[0])
    return ordered


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
    ordering = [edge for edge in _cross_repo_merge_edges(state) if edge[0] in urls and edge[1] in urls]
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
    """
    if not base_ref:
        return True
    counted = run_git_checked(worktree, ["rev-list", "--count", f"{base_ref}..HEAD"], allow_failure=True)
    if counted.returncode != 0:
        return True
    return (counted.stdout.strip() or "0") != "0"


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
        set_repo_status(vcs, repo_id, "pr_opened")
        # A pull request that already merged or closed keeps the state it reached:
        # `vcs pr-status` owns merge state, and adopting an existing pull request must
        # never report it back open.
        stored_state = repo.get("pullRequestState")
        reached = stored_state if already_exists and stored_state in VALID_PULL_REQUEST_STATES else "open"
        set_repo_pull_request(vcs, repo_id, url=url, state=reached, error=None)
        return {**result, "ok": True, "pullRequestUrl": url, **({"alreadyExists": True} if already_exists else {})}

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

    url = parse_url_from_output(pr.stdout) or parse_url_from_output(pr.stderr)
    append_event(state, "run_pull_request_opened", "sprintengine", f"Opened pull request for {branch}: {url or '(url unavailable)'}.")
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
        if not _repo_has_run_commits(worktree, str(repo.get("baseRef") or "").strip()):
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


def _refresh_repo_pull_request_state(state_path: Path, repo: Dict[str, Any]) -> str:
    """Resolve whether one repo's run branch has merged. Never raises.

    Merged if EITHER signal says so: the GitHub PR reports ``MERGED`` (authoritative,
    also covers squash/rebase done through the PR), OR the branch tip is an ancestor
    of its base ref (catches a branch merged into main manually, without the PR merge
    button — and a branch merged with no PR at all). A squash/rebase merge performed
    outside a PR rewrites history and is not detectable here; through a PR, ``gh``
    reports it. All git/gh calls are best-effort.
    """
    workspace_root = workspace_root_for_state_path(state_path)
    worktree = _repo_worktree(state_path, repo)
    # Once a merged worktree is cleaned up, the repo's own root still answers for it.
    cwd = worktree if (worktree and worktree.exists()) else resolve_vcs_path(workspace_root, repo["root"])
    branch = repo["branchName"]
    base = str(repo.get("baseRef") or "").strip()
    url = _optional_str(repo.get("pullRequestUrl"))

    pr_state = "open"

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
    if pr_state == "open" and has_commits and branch and base:
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
