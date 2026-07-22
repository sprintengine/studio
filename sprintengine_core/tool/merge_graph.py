"""Cross-repo merge-order graph algorithms for multi-repo Sprint Engine runs.

Pure functions over the task graph and a run's declared repos: the producer→consumer
edges that cross-repo task dependencies imply, the cycle detection that refuses an
unorderable plan, and the merge order (and per-repo blockers) those edges induce. No
subprocess or ``gh`` dependency; lifted out of ``shell.py`` (backlog 1737) so plan and
task authoring can ask about merge order without importing the git layer.
"""

from __future__ import annotations

from typing import Any, Dict, List

from sprintengine_core.tool.repo_model import _optional_str


def _state_tasks(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [task for task in (state.get("tasks") or []) if isinstance(task, dict)]


def cross_repo_merge_edges(tasks: List[Dict[str, Any]]) -> List[List[str]]:
    """``[producer, consumer]`` repo pairs implied by cross-repo task dependencies.

    A task in one project depending on a task in another says the other project's
    pull request must land first — otherwise the consumer merges against work that is
    not on its base yet. Dependencies inside one project say nothing about merge
    order: a single pull request carries both ends.

    Takes the tasks rather than the run state so the planner can ask the same
    question of a plan it is only considering.
    """
    from sprintengine_core import store as folder_store

    repo_by_task = {str(task.get("id") or ""): folder_store.task_repo(task) for task in tasks}
    edges: List[List[str]] = []
    for task in tasks:
        consumer = folder_store.task_repo(task)
        for dependency in task.get("dependsOn") or []:
            producer = repo_by_task.get(str(dependency))
            if producer and producer != consumer and [producer, consumer] not in edges:
                edges.append([producer, consumer])
    return edges


def repo_dependency_cycle(tasks: List[Dict[str, Any]]) -> List[str]:
    """One loop in the repo merge order these tasks induce, or ``[]`` when there is none.

    The task graph being acyclic does not make the REPO graph acyclic: a mobile task
    waiting on a desktop task and a desktop task waiting on a different mobile task are
    two perfectly orderable tasks whose projects each have to merge before the other.
    No merge order exists for that run, and nothing downstream can invent one — so it
    is refused where it is authored (:func:`assert_no_repo_dependency_cycle`).

    Returned as the loop a person can read, first repo repeated at the end
    (``["mobile", "primary", "mobile"]``).
    """
    successors: Dict[str, List[str]] = {}
    for producer, consumer in cross_repo_merge_edges(tasks):
        successors.setdefault(producer, []).append(consumer)

    settled: set[str] = set()

    def walk(repo_id: str, path: List[str]) -> List[str]:
        if repo_id in path:
            return [*path[path.index(repo_id) :], repo_id]
        if repo_id in settled:
            return []
        for consumer in successors.get(repo_id, []):
            found = walk(consumer, [*path, repo_id])
            if found:
                return found
        settled.add(repo_id)
        return []

    for repo_id in successors:
        cycle = walk(repo_id, [])
        if cycle:
            return cycle
    return []


def assert_no_repo_dependency_cycle(tasks: List[Dict[str, Any]]) -> None:
    """Refuse a plan whose projects would each have to merge before the other.

    Raises with the loop named, because "there is a cycle" is not something the author
    can act on: they need to know which two pieces of work are pointing at each other.
    """
    cycle = repo_dependency_cycle(tasks)
    if not cycle:
        return
    raise SystemExit(
        "This would make the projects wait on each other: " + " → ".join(cycle) + ". "
        "Each step is work in one project that builds on work in another, so that other project "
        "has to merge first — and around this loop every project is waiting for the next one, so "
        "none of them could ever merge. Depend on the work in one direction only, or move one of "
        "the tasks into the project it depends on."
    )


def repo_merge_order(state: Dict[str, Any], repo_ids: List[str]) -> List[str]:
    """The given repos in the order their pull requests must merge.

    Producers before consumers, declaration order breaking every tie so the same run
    always states the same order. Repo-level dependency cycles are rejected at plan
    time; if one reaches here anyway, the repos it traps keep their declaration order
    rather than being dropped — an order a reviewer can question beats a body that
    silently omits a pull request.
    """
    edges = [
        edge
        for edge in cross_repo_merge_edges(_state_tasks(state))
        if edge[0] in repo_ids and edge[1] in repo_ids
    ]
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


def _structural_merge_predecessors(state: Dict[str, Any], repos: List[Dict[str, Any]], repo_id: str) -> List[str]:
    """Every project this one's work transitively builds on, from the task graph alone.

    Structural only: derived from cross-repo task edges, with no reference to any
    project's current pull-request state. The merge command probes exactly this set
    (plus the merging repo) rather than every project, so a single-repo merge — or a
    merge of a project nothing else feeds — makes one `gh` probe, not one per project.
    """
    known = {repo["id"] for repo in repos}
    producers: Dict[str, List[str]] = {}
    for producer, consumer in cross_repo_merge_edges(_state_tasks(state)):
        if producer in known and consumer in known:
            producers.setdefault(consumer, []).append(producer)

    required: List[str] = []
    pending = [repo_id]
    while pending:
        for producer in producers.get(pending.pop(), []):
            if producer not in required:
                required.append(producer)
                pending.append(producer)
    return required


def _repos_that_must_merge_first(state: Dict[str, Any], repos: List[Dict[str, Any]], repo_id: str) -> List[str]:
    """Every project this one's pull request has to wait for, in merge order.

    Transitive: mobile waiting on desktop waiting on shared means mobile waits for
    shared too, even though no task of mobile's names one of shared's. A project that
    delivered nothing (no pull request and no commits) is not in anyone's way.
    """
    required = _structural_merge_predecessors(state, repos, repo_id)
    by_id = {repo["id"]: repo for repo in repos}
    unmerged = [
        candidate
        for candidate in required
        if by_id[candidate].get("pullRequestState") != "merged"
        and (_optional_str(by_id[candidate].get("pullRequestUrl")) or _optional_str(by_id[candidate].get("lastCommitSha")))
    ]
    return [candidate for candidate in repo_merge_order(state, [repo["id"] for repo in repos]) if candidate in unmerged]
