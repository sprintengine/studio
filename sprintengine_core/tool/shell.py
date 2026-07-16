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


def _repo_entry(
    *,
    repo_id: str,
    root: str,
    worktree_path: str,
    branch_name: str,
    base_ref: Optional[str],
    status: Optional[str],
    last_commit_sha: Optional[str],
) -> Dict[str, Any]:
    """One declared repo. The single site that spells the entry shape."""
    return {
        "id": repo_id,
        "root": root,
        "worktreePath": worktree_path,
        "branchName": branch_name,
        "baseRef": base_ref,
        "status": status if status in VALID_VCS_STATUSES else "not_created",
        "lastCommitSha": last_commit_sha if isinstance(last_commit_sha, str) else None,
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


def set_vcs_status(vcs: Dict[str, Any], status: str) -> None:
    """Record the primary repo's worktree status on both shapes that store it.

    The flat block is still what the app, mobile snapshot, and PR paths read; entry
    zero of `repos` is the same repo in the shape the multi-repo work reads. Writing
    through one setter is what keeps the two from drifting while both exist.
    """
    vcs["status"] = status
    primary = _stored_primary_repo(vcs)
    if primary is not None:
        primary["status"] = status


def set_vcs_last_commit_sha(vcs: Dict[str, Any], sha: Optional[str]) -> None:
    """Record the primary repo's last commit on both shapes that store it."""
    vcs["lastCommitSha"] = sha
    primary = _stored_primary_repo(vcs)
    if primary is not None:
        primary["lastCommitSha"] = sha


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
        "pullRequestUrl": vcs.get("pullRequestUrl") if isinstance(vcs.get("pullRequestUrl"), str) else None,
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


def worktree_for_vcs(state: Dict[str, Any], state_path: Path) -> Optional[Path]:
    vcs = get_run_vcs(state)
    if not vcs:
        return None
    value = vcs.get("worktreePath")
    if not isinstance(value, str) or not value.strip():
        return None
    return resolve_vcs_path(workspace_root_for_state_path(state_path), value)


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
    """Stage and commit only the current task's paths in the shared run worktree.

    Serialized through ``runner/git.commit.lock`` so concurrent agents never race
    the git index. Stages a pathspec built from the task's owned paths, logged
    touched files, and any explicitly passed paths — never ``git add -A`` — and
    tolerates files another agent already committed (those are simply clean and
    contribute nothing to this commit). Returns the new short SHA, or ``None``
    when worktree mode is off or there is nothing in scope to commit.
    """
    from sprintengine_core import store as folder_store
    from sprintengine_core.tool.state import append_event
    from sprintengine_core.tool.tasks import ensure_evidence, task_diff_declared_paths

    worktree = worktree_for_vcs(state, state_path)
    if not worktree:
        return None
    if not worktree.exists():
        raise SystemExit(f"Sprint Engine worktree is missing: {worktree}")

    vcs = get_run_vcs(state)
    declared = task_diff_declared_paths(task, explicit_paths or [])
    owned = [str(path) for path in task.get("ownedPaths", []) or []]
    pathspec = _normalize_commit_pathspec(worktree, [*declared, *owned])

    lock = folder_store.FolderLock(state_path.parent / folder_store.GIT_COMMIT_LOCK_FILE)
    lock.acquire(recover_stale=True)
    try:
        status_out = run_git_checked(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout
        dirty = _parse_porcelain_z(status_out)
        if vcs is not None:
            set_vcs_status(vcs, "dirty" if dirty else "ready")
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
        set_vcs_status(vcs, "committed")
        set_vcs_last_commit_sha(vcs, sha)
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


def worktree_orphaned_dirty_paths(state: Dict[str, Any], state_path: Path) -> List[str]:
    """Dirty paths in the shared run worktree that fall inside no task's ownedPaths.

    Per-task commits stage only owned + declared paths (never ``git add -A``, which
    would sweep another agent's work into this commit). A change that lands inside
    *no* task's ``ownedPaths`` is therefore picked up by nobody's commit and would
    be silently dropped from the run — for example a new directory an author
    created but never added to their task's owned paths (the failure that made a
    published commit import files absent from HEAD). Dirty paths that fall inside
    some task's owned paths are expected concurrent work and are not returned here.

    Returns sorted project-relative posix paths. Advisory: read without the commit
    lock, so it reflects a point-in-time view of the shared worktree.
    """
    worktree = worktree_for_vcs(state, state_path)
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
            all_owned.extend(str(path) for path in (task.get("ownedPaths") or []))
    owned_pathspec = _normalize_commit_pathspec(worktree, all_owned)
    return sorted(
        {
            record["path"]
            for record in dirty
            if record["path"] and not _path_in_scope(record["path"], owned_pathspec)
        }
    )


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
    """
    worktree = worktree_for_vcs(state, state_path)
    if not worktree or not worktree.exists():
        return []
    orphaned = worktree_orphaned_dirty_paths(state, state_path)
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


def build_run_pull_request_body(state: Dict[str, Any], branch: str) -> str:
    """Default PR description: the run goal plus the tasks it delivered.

    A reviewer opening the PR sees what shipped and why, not just the branch name.
    A caller-supplied ``--body`` overrides this entirely.
    """
    sprintengine = state.get("sprintengine", {})
    goal = str(sprintengine.get("goal") or "").strip()
    lines = [f"Sprint Engine run delivery for branch `{branch}`.", "", f"**Goal:** {goal or '_(not set)_'}"]
    done = [t for t in (state.get("tasks") or []) if isinstance(t, dict) and t.get("status") == "done"]
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
    """Push the run worktree branch and open a pull request via the GitHub CLI.

    Best-effort: network/remote failures are surfaced in the result rather than
    raising, so a completed run is never lost just because a push or PR creation
    could not reach the remote.
    """
    from sprintengine_core.tool.state import append_event

    vcs = get_run_vcs(state)
    worktree = worktree_for_vcs(state, state_path)
    if not vcs or not worktree:
        return {"ok": False, "error": "Sprint Engine run is not in worktree mode; no branch to open a pull request from."}
    if not worktree.exists():
        return {"ok": False, "error": f"Sprint Engine worktree is missing: {worktree}"}

    branch = str(vcs.get("branchName") or current_git_branch(worktree))
    base_branch = (base or "").strip() or str(vcs.get("baseRef") or "").strip() or default_base_ref(worktree)
    sprintengine = state.get("sprintengine", {})
    goal = str(sprintengine.get("goal") or "").strip()
    pr_title = (title or "").strip() or compact_commit_subject(f"SprintEngine: {goal or branch}")
    pr_body = body if isinstance(body, str) and body.strip() else build_run_pull_request_body(state, branch)

    if push:
        pushed = run_git_checked(worktree, ["push", "-u", remote, branch], allow_failure=True)
        if pushed.returncode != 0:
            error = pushed.stderr.strip() or pushed.stdout.strip() or "git push failed"
            set_vcs_status(vcs, "failed")
            vcs["pullRequestError"] = error
            return {"ok": False, "error": error, "branch": branch}
        set_vcs_status(vcs, "pushed")

    try:
        pr = run_gh_checked(
            worktree,
            ["pr", "create", "--base", base_branch, "--head", branch, "--title", pr_title, "--body", pr_body, *(["--draft"] if draft else [])],
            allow_failure=True,
        )
    except SystemExit as exc:
        # gh is not installed. Record it as a failure with the reason rather than
        # aborting the whole command, so the summary shows it and offers Retry.
        error = str(exc)
        set_vcs_status(vcs, "failed")
        vcs["pullRequestError"] = error
        return {"ok": False, "error": error, "branch": branch}
    if pr.returncode != 0:
        stderr = pr.stderr.strip()
        existing = parse_url_from_output(stderr) or parse_url_from_output(pr.stdout)
        if existing:
            vcs["pullRequestUrl"] = existing
            set_vcs_status(vcs, "pr_opened")
            vcs["pullRequestState"] = "open"
            vcs.pop("pullRequestError", None)
            return {"ok": True, "branch": branch, "base": base_branch, "pullRequestUrl": existing, "alreadyExists": True}
        # Push succeeded but the PR could not be opened (gh not authed, no remote,
        # API error). Record it as failed with the reason so the summary can show
        # the real error and a Retry, instead of a silent "pending" forever.
        error = stderr or pr.stdout.strip() or "gh pr create failed"
        set_vcs_status(vcs, "failed")
        vcs["pullRequestError"] = error
        return {"ok": False, "error": error, "branch": branch}

    url = parse_url_from_output(pr.stdout) or parse_url_from_output(pr.stderr)
    vcs["pullRequestUrl"] = url
    set_vcs_status(vcs, "pr_opened")
    vcs["pullRequestState"] = "open"
    vcs.pop("pullRequestError", None)
    append_event(state, "run_pull_request_opened", "sprintengine", f"Opened pull request for {branch}: {url or '(url unavailable)'}.")
    return {"ok": True, "branch": branch, "base": base_branch, "pullRequestUrl": url}


def refresh_run_pull_request_state(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    """Resolve and persist whether the run's branch has merged.

    Merged if EITHER signal says so: the GitHub PR reports ``MERGED`` (authoritative,
    also covers squash/rebase done through the PR), OR the branch tip is an ancestor
    of its base ref (catches a branch merged into main manually, without the PR merge
    button — and a branch merged with no PR at all). A squash/rebase merge performed
    outside a PR rewrites history and is not detectable here; through a PR, ``gh``
    reports it. All git/gh calls are best-effort and never raise.
    """
    vcs = get_run_vcs(state)
    if not vcs:
        return {"ok": True, "enabled": False, "pullRequestState": None}

    worktree = worktree_for_vcs(state, state_path)
    repo = worktree if (worktree and worktree.exists()) else workspace_root_for_state_path(state_path)
    branch = str(vcs.get("branchName") or "").strip()
    base = str(vcs.get("baseRef") or "").strip()
    url = str(vcs.get("pullRequestUrl") or "").strip()

    pr_state = "open"

    # 1. Authoritative: the GitHub PR's own state.
    if url:
        try:
            viewed = run_gh_checked(repo, ["pr", "view", url, "--json", "state"], allow_failure=True)
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
    #    Only meaningful once the run has committed work: an empty branch whose tip
    #    still equals base would otherwise read as a spurious "merged" (a commit is
    #    its own ancestor). `lastCommitSha` is set exactly when the run committed.
    has_commits = bool(str(vcs.get("lastCommitSha") or "").strip())
    if pr_state == "open" and has_commits and branch and base:
        run_git_checked(repo, ["fetch", "origin", base], allow_failure=True)
        tip = run_git_checked(repo, ["rev-parse", branch], allow_failure=True)
        branch_tip = tip.stdout.strip() if tip.returncode == 0 else ""
        if branch_tip:
            for candidate in (base, f"origin/{base}"):
                ancestor = run_git_checked(repo, ["merge-base", "--is-ancestor", branch_tip, candidate], allow_failure=True)
                if ancestor.returncode == 0:
                    pr_state = "merged"
                    break

    vcs["pullRequestState"] = pr_state
    return {"ok": True, "enabled": True, "pullRequestState": pr_state, "vcs": vcs}


def cleanup_merged_worktree(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    """Remove the run worktree once the branch has merged, if it is clean.

    Only runs after a merge is confirmed. A worktree with uncommitted changes is
    left in place (the work would be lost) — never force-removed. The branch is not
    deleted. The run record lives outside the worktree dir, so the summary survives.
    """
    from sprintengine_core.tool.state import append_event

    vcs = get_run_vcs(state)
    if not vcs:
        return {"removed": False, "reason": "not_worktree_mode"}
    worktree = worktree_for_vcs(state, state_path)
    if not worktree or not worktree.exists():
        return {"removed": False, "reason": "missing"}
    if git_status_short(worktree).strip():
        return {"removed": False, "reason": "dirty"}

    workspace_root = workspace_root_for_state_path(state_path)
    removed = run_git_checked(workspace_root, ["worktree", "remove", str(worktree)], allow_failure=True)
    if removed.returncode != 0:
        return {"removed": False, "reason": (removed.stderr.strip() or removed.stdout.strip() or "git worktree remove failed")}
    append_event(state, "run_worktree_removed", "sprintengine", f"Removed merged run worktree {vcs.get('worktreePath')}.")
    return {"removed": True}
