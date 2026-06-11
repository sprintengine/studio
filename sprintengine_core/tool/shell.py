"""Shell and Git helpers for Sprint Engine run worktrees."""

from __future__ import annotations

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


def ensure_run_worktree(state: Dict[str, Any], state_path: Path, *, base_ref: Optional[str] = None, branch_name: Optional[str] = None) -> Dict[str, Any]:
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
    vcs.update({
        "mode": "run_worktree",
        "repoRoot": ".",
        "worktreePath": rel_worktree,
        "branchName": branch,
        "baseRef": base,
        "status": vcs.get("status") if vcs.get("status") in VALID_VCS_STATUSES else "not_created",
        "pullRequestUrl": vcs.get("pullRequestUrl") if isinstance(vcs.get("pullRequestUrl"), str) else None,
        "lastCommitSha": vcs.get("lastCommitSha") if isinstance(vcs.get("lastCommitSha"), str) else None,
    })

    existing = run_git_checked(workspace_root, ["worktree", "list", "--porcelain"])
    if str(worktree_path.resolve()) not in existing.stdout:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        if git_branch_exists(workspace_root, branch):
            run_git_checked(workspace_root, ["worktree", "add", str(worktree_path), branch])
        else:
            run_git_checked(workspace_root, ["worktree", "add", "-b", branch, str(worktree_path), base])
    if not worktree_path.exists():
        raise SystemExit(f"Sprint Engine worktree was not created: {rel_worktree}")
    actual_branch = current_git_branch(worktree_path)
    if actual_branch != branch:
        raise SystemExit(f"Sprint Engine worktree is on {actual_branch}, expected {branch}.")
    vcs["status"] = "ready"
    append_event(state, "run_worktree_ready", "sprintengine", f"Sprint Engine run worktree is ready at {rel_worktree} on {branch}.")
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
            vcs["status"] = "dirty" if dirty else "ready"
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
        vcs["status"] = "committed"
        vcs["lastCommitSha"] = sha
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
    pr_body = body if isinstance(body, str) and body.strip() else (f"Sprint Engine run delivery for branch `{branch}`.\n\nGoal: {goal or '(not set)'}")

    if push:
        pushed = run_git_checked(worktree, ["push", "-u", remote, branch], allow_failure=True)
        if pushed.returncode != 0:
            vcs["status"] = "failed"
            return {"ok": False, "error": (pushed.stderr.strip() or pushed.stdout.strip() or "git push failed"), "branch": branch}
        vcs["status"] = "pushed"

    pr = run_gh_checked(
        worktree,
        ["pr", "create", "--base", base_branch, "--head", branch, "--title", pr_title, "--body", pr_body, *(["--draft"] if draft else [])],
        allow_failure=True,
    )
    if pr.returncode != 0:
        stderr = pr.stderr.strip()
        existing = parse_url_from_output(stderr) or parse_url_from_output(pr.stdout)
        if existing:
            vcs["pullRequestUrl"] = existing
            return {"ok": True, "branch": branch, "base": base_branch, "pullRequestUrl": existing, "alreadyExists": True}
        return {"ok": False, "error": stderr or pr.stdout.strip() or "gh pr create failed", "branch": branch}

    url = parse_url_from_output(pr.stdout) or parse_url_from_output(pr.stderr)
    vcs["pullRequestUrl"] = url
    vcs["status"] = "pr_opened"
    append_event(state, "run_pull_request_opened", "sprintengine", f"Opened pull request for {branch}: {url or '(url unavailable)'}.")
    return {"ok": True, "branch": branch, "base": base_branch, "pullRequestUrl": url}
