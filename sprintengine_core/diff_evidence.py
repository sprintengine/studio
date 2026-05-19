from __future__ import annotations

import fnmatch
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Iterable, Optional


MAX_DIFF_FILES = 50
MAX_HUNKS_PER_FILE = 100
MAX_LINES_PER_FILE = 2000
MAX_LINES_PER_TASK = 10000
MAX_LINE_CHARS = 256
MAX_SYNTHETIC_FILE_BYTES = 200_000

SECRET_PATH_PATTERNS = {
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_ed25519",
}


def _run_git(cwd: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GH_PROMPT_DISABLED": "1"},
    )


def _normalize_declared_path(value: Any) -> Optional[str]:
    path = str(value or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return None
    parts = [part for part in path.split("/") if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        return None
    return "/".join(parts)


def _unique_paths(values: Iterable[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        path = _normalize_declared_path(value)
        if not path or path in seen:
            continue
        seen.add(path)
        result.append(path)
    return result


def _is_secret_sensitive_path(path: str) -> bool:
    basename = path.rsplit("/", 1)[-1]
    lowered = path.lower()
    if "/secrets/" in f"/{lowered}/" or "/.ssh/" in f"/{lowered}/":
        return True
    return any(fnmatch.fnmatch(basename, pattern) for pattern in SECRET_PATH_PATTERNS)


def _strip_git_prefix(path: str) -> str:
    if path == "/dev/null":
        return path
    if path.startswith("a/") or path.startswith("b/"):
        return path[2:]
    return path


def _diff_header_paths(line: str) -> tuple[str, str]:
    match = re.match(r"^diff --git a/(.+) b/(.+)$", line)
    if not match:
        return "unknown", "unknown"
    return match.group(1), match.group(2)


def _new_diff(path: str, actor: str, source: str) -> dict[str, Any]:
    return {
        "path": path,
        "status": "modified",
        "additions": 0,
        "deletions": 0,
        "capturedBy": actor,
        "source": source,
        "binary": False,
        "truncated": False,
        "skippedReason": None,
        "hunks": [],
    }


def _truncate_content(content: str, diff: dict[str, Any]) -> str:
    if len(content) <= MAX_LINE_CHARS:
        return content
    diff["truncated"] = True
    return f"{content[:MAX_LINE_CHARS]}..."


def _append_hunk_line(
    diff: dict[str, Any],
    hunk: dict[str, Any],
    line_type: str,
    content: str,
    old_line: Optional[int],
    new_line: Optional[int],
    counters: dict[str, int],
) -> bool:
    if counters["file_lines"] >= MAX_LINES_PER_FILE or counters["task_lines"] >= MAX_LINES_PER_TASK:
        diff["truncated"] = True
        return False
    hunk["lines"].append({
        "type": line_type,
        "oldLine": old_line,
        "newLine": new_line,
        "content": _truncate_content(content, diff),
    })
    counters["file_lines"] += 1
    counters["task_lines"] += 1
    if line_type == "added":
        diff["additions"] += 1
    elif line_type == "removed":
        diff["deletions"] += 1
    return True


def parse_unified_diff(patch: str, *, actor: str, source: str, captured_at: str) -> list[dict[str, Any]]:
    diffs: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None
    current_hunk: Optional[dict[str, Any]] = None
    old_line = 0
    new_line = 0
    counters = {"task_lines": 0, "file_lines": 0}

    def finish_current() -> None:
        nonlocal current, current_hunk
        if not current:
            return
        current["capturedAt"] = captured_at
        if current.get("skippedReason"):
            current["hunks"] = []
        diffs.append(current)
        current = None
        current_hunk = None

    for raw_line in patch.splitlines():
        if raw_line.startswith("diff --git "):
            finish_current()
            old_path, new_path = _diff_header_paths(raw_line)
            path = _strip_git_prefix(new_path if new_path != "/dev/null" else old_path)
            current = _new_diff(path, actor, source)
            counters["file_lines"] = 0
            current_hunk = None
            continue

        if current is None:
            continue

        if raw_line.startswith("new file mode"):
            current["status"] = "added"
            continue
        if raw_line.startswith("deleted file mode"):
            current["status"] = "deleted"
            continue
        if raw_line.startswith("rename from "):
            current["oldPath"] = raw_line.removeprefix("rename from ").strip()
            current["status"] = "renamed"
            continue
        if raw_line.startswith("rename to "):
            current["path"] = raw_line.removeprefix("rename to ").strip()
            current["status"] = "renamed"
            continue
        if raw_line.startswith("copy from "):
            current["oldPath"] = raw_line.removeprefix("copy from ").strip()
            current["status"] = "copied"
            continue
        if raw_line.startswith("copy to "):
            current["path"] = raw_line.removeprefix("copy to ").strip()
            current["status"] = "copied"
            continue
        if raw_line.startswith("Binary files ") or raw_line.startswith("GIT binary patch"):
            current["binary"] = True
            current["skippedReason"] = "binary_file"
            continue
        if raw_line.startswith("--- ") or raw_line.startswith("+++ ") or raw_line.startswith("index "):
            continue

        hunk_match = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$", raw_line)
        if hunk_match:
            if len(current["hunks"]) >= MAX_HUNKS_PER_FILE:
                current["truncated"] = True
                current_hunk = None
                continue
            old_line = int(hunk_match.group(1))
            new_line = int(hunk_match.group(3))
            current_hunk = {
                "oldStart": old_line,
                "oldLines": int(hunk_match.group(2) or "1"),
                "newStart": new_line,
                "newLines": int(hunk_match.group(4) or "1"),
                "section": hunk_match.group(5) or None,
                "lines": [],
            }
            current["hunks"].append(current_hunk)
            continue

        if current_hunk is None:
            continue
        if raw_line.startswith("\\ No newline at end of file"):
            continue

        prefix = raw_line[:1]
        content = raw_line[1:] if prefix in {" ", "+", "-"} else raw_line
        if prefix == "+":
            if _append_hunk_line(current, current_hunk, "added", content, None, new_line, counters):
                new_line += 1
        elif prefix == "-":
            if _append_hunk_line(current, current_hunk, "removed", content, old_line, None, counters):
                old_line += 1
        else:
            if _append_hunk_line(current, current_hunk, "context", content, old_line, new_line, counters):
                old_line += 1
                new_line += 1

    finish_current()
    return diffs[:MAX_DIFF_FILES]


def _skipped_diff(path: str, actor: str, source: str, captured_at: str, reason: str) -> dict[str, Any]:
    return {
        **_new_diff(path, actor, source),
        "capturedAt": captured_at,
        "skippedReason": reason,
    }


def _synthetic_added_diff(git_root: Path, path: str, actor: str, captured_at: str) -> dict[str, Any]:
    target = (git_root / path).resolve()
    try:
        relative = target.relative_to(git_root.resolve())
    except ValueError:
        return _skipped_diff(path, actor, "working_tree", captured_at, "path_outside_worktree")
    if not target.exists() or not target.is_file():
        return _skipped_diff(path, actor, "working_tree", captured_at, "file_unavailable")
    try:
        if target.stat().st_size > MAX_SYNTHETIC_FILE_BYTES:
            return _skipped_diff(path, actor, "working_tree", captured_at, "file_too_large")
        data = target.read_bytes()
    except OSError:
        return _skipped_diff(path, actor, "working_tree", captured_at, "file_unavailable")
    if b"\0" in data[:8192]:
        diff = _skipped_diff(path, actor, "working_tree", captured_at, "binary_file")
        diff["binary"] = True
        return diff
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    diff = _new_diff(relative.as_posix(), actor, "working_tree")
    diff["capturedAt"] = captured_at
    diff["status"] = "added"
    hunk = {
        "oldStart": 0,
        "oldLines": 0,
        "newStart": 1,
        "newLines": len(lines),
        "section": None,
        "lines": [],
    }
    diff["hunks"].append(hunk)
    counters = {"task_lines": 0, "file_lines": 0}
    for index, line in enumerate(lines, start=1):
        if not _append_hunk_line(diff, hunk, "added", line, None, index, counters):
            break
    return diff


def _git_root_for(cwd: Path) -> Optional[Path]:
    inside = _run_git(cwd, ["rev-parse", "--is-inside-work-tree"])
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return None
    root = _run_git(cwd, ["rev-parse", "--show-toplevel"])
    if root.returncode != 0:
        return None
    return Path(root.stdout.strip())


def capture_task_diff_evidence(
    cwd: Path,
    declared_paths: Iterable[Any],
    *,
    actor: str,
    captured_at: str,
) -> list[dict[str, Any]]:
    git_root = _git_root_for(cwd)
    paths = _unique_paths(declared_paths)
    if not git_root or not paths:
        return []

    diffs: list[dict[str, Any]] = []
    safe_paths: list[str] = []
    for path in paths:
        if _is_secret_sensitive_path(path):
            diffs.append(_skipped_diff(path, actor, "working_tree", captured_at, "secret_sensitive_path"))
        else:
            safe_paths.append(path)

    if safe_paths:
        diff_result = _run_git(git_root, ["diff", "--find-renames", "--unified=3", "HEAD", "--", *safe_paths])
        if diff_result.returncode == 0 and diff_result.stdout:
            diffs.extend(parse_unified_diff(diff_result.stdout, actor=actor, source="working_tree", captured_at=captured_at))

        untracked_result = _run_git(git_root, ["ls-files", "--others", "--exclude-standard", "--", *safe_paths])
        if untracked_result.returncode == 0:
            tracked_paths = {str(diff.get("path") or "") for diff in diffs}
            for path in _unique_paths(untracked_result.stdout.splitlines()):
                if path in tracked_paths or _is_secret_sensitive_path(path):
                    continue
                diffs.append(_synthetic_added_diff(git_root, path, actor, captured_at))
                if len(diffs) >= MAX_DIFF_FILES:
                    break

    return diffs[:MAX_DIFF_FILES]
