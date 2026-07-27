"""Repo-entry schema, mirror writes, and vcs.repos accessors for Sprint Engine runs.

Pure run-state helpers with no subprocess or ``gh`` dependency: the shape of a
declared repo entry, the accessors that read a run's repos from either store shape,
the setters that mirror the primary repo's fields onto the flat ``vcs`` block, and the
``--repo`` declaration parsers. Lifted out of ``shell.py`` (backlog 1737) so the
run-state layer reads and writes its own vcs model without importing the git layer.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.constants import VALID_VCS_STATUSES

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

# What a store says when it claims an open pull request it has no url for. A run
# recorded `pullRequestState: open` with neither a url nor an error is the exact
# state MC-1909 was filed on: the lane's auto-merge reads "there is a pull request"
# and "there is nothing to merge" at once and can act on neither. Writing that
# combination is refused outright (:func:`set_repo_pull_request`); a store that
# already carries it from before reads back with this error, so the pull request is
# never silently url-less.
PULL_REQUEST_URL_MISSING_ERROR = (
    "This run recorded an open pull request but no url for it. "
    "Re-run `vcs pr` to adopt the pull request, or open it on GitHub."
)

# The per-repo fields the primary repo also stores flat on `vcs`, because the app,
# the mobile snapshot, and the PR surfaces still read them there.
_PRIMARY_MIRRORED_KEYS = ("status", "lastCommitSha", "pullRequestUrl", "pullRequestState", "pullRequestError")


def get_run_vcs(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    vcs = state.get("sprintengine", {}).get("vcs")
    return vcs if isinstance(vcs, dict) and vcs.get("mode") == "run_worktree" else None


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

    An entry that claims an open pull request with neither a url nor an error reads
    back carrying :data:`PULL_REQUEST_URL_MISSING_ERROR`. Normalizing on READ rather
    than raising keeps a store written before that combination was refused openable —
    the run still says something true about its pull request instead of nothing.
    """
    resolved_state = pull_request_state if pull_request_state in VALID_PULL_REQUEST_STATES else None
    resolved_url = _optional_str(pull_request_url)
    resolved_error = _optional_str(pull_request_error)
    if resolved_state == "open" and not resolved_url and not resolved_error:
        resolved_error = PULL_REQUEST_URL_MISSING_ERROR
    return {
        "id": repo_id,
        "root": root,
        "worktreePath": worktree_path,
        "branchName": branch_name,
        "baseRef": base_ref,
        "status": status if status in VALID_VCS_STATUSES else "not_created",
        "lastCommitSha": last_commit_sha if isinstance(last_commit_sha, str) else None,
        "pullRequestUrl": resolved_url,
        "pullRequestState": resolved_state,
        "pullRequestError": resolved_error,
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

    An OPEN pull request with neither a url nor an error is that fact contradicting
    itself, and is refused here rather than persisted: it is the state a lane's
    auto-merge cannot act on (MC-1909). Every caller that opens a pull request either
    resolves the url or records why it has none.
    """
    if state == "open" and not _optional_str(url) and not _optional_str(error):
        raise SystemExit(
            f"Sprint Engine cannot record an open pull request for {repo_id!r} with neither a url nor "
            "an error: a pull request the run cannot name is one nothing can merge. "
            "Record the url it opened, or the reason it has none."
        )
    _set_repo_field(vcs, repo_id, "pullRequestUrl", url)
    _set_repo_field(vcs, repo_id, "pullRequestState", state)
    _set_repo_field(vcs, repo_id, "pullRequestError", error)


def repo_field_baseline(state: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """A per-repo copy of the vcs fields, taken before a network phase runs.

    Paired with :func:`persist_resolved_vcs` to carry only what the network phase
    actually changed onto freshly-loaded state, so a field an unrelated writer touched
    concurrently is never overwritten with a stale value.
    """
    vcs = get_run_vcs(state)
    return {repo["id"]: dict(repo) for repo in vcs_repos(vcs)} if vcs else {}


def persist_resolved_vcs(
    fresh: Dict[str, Any],
    resolved: Dict[str, Any],
    *,
    baseline: Dict[str, Dict[str, Any]],
    since_event_index: int,
) -> None:
    """Carry a network phase's resolved vcs outcome onto freshly-loaded run state.

    The pull-request, merge, and pr-status handlers do their git and ``gh`` work
    outside the run mutation lock, against a snapshot, then take the lock only to write
    what they resolved (see the ``vcs_*`` handlers in ``commands/run.py``). Only the
    fields the network phase actually changed from ``baseline`` are copied, and the
    events it logged are re-appended onto the fresh events list — so a ``vcs.commit``
    that raced the network phase on the same repo keeps its own ``lastCommitSha`` and
    ``status`` rather than being clobbered by a stale snapshot value.
    """
    from sprintengine_core.tool.state import append_event

    fresh_vcs = get_run_vcs(fresh)
    resolved_vcs = get_run_vcs(resolved)
    if fresh_vcs is not None and resolved_vcs is not None:
        for resolved_repo in vcs_repos(resolved_vcs):
            repo_id = resolved_repo["id"]
            if _stored_repo(fresh_vcs, repo_id) is None:
                continue
            before = baseline.get(repo_id, {})
            for key, value in resolved_repo.items():
                if key != "id" and before.get(key) != value:
                    _set_repo_field(fresh_vcs, repo_id, key, value)
    for event in resolved.get("events", [])[since_event_index:]:
        if not isinstance(event, dict):
            continue
        extra = {k: v for k, v in event.items() if k not in ("id", "timestamp", "type", "actor", "message")}
        append_event(
            fresh,
            str(event.get("type") or ""),
            str(event.get("actor") or "sprintengine"),
            str(event.get("message") or ""),
            extra or None,
        )


def parse_repo_declaration(value: str) -> Dict[str, str]:
    """One `--repo <id>=<path>` declaration, parsed but not yet resolved on disk.

    Syntax only: whether the path is a real git repo is decided against the
    workspace in :func:`sprintengine_core.tool.shell.declared_sibling_entries`, which
    is the only place that knows where the run lives.
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
