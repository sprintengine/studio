"""Soul and Sprint Engine prompt composition helpers."""

from __future__ import annotations

from typing import Optional

from sprintengine_core.tool.paths import PROMPTS_DIR

def load_soul_prompt(role: str) -> Optional[str]:
    try:
        from souls import render_soul
    except ImportError:
        return None

    try:
        return render_soul(role)
    except (KeyError, FileNotFoundError):
        return None


def project_relative_path_guidance() -> str:
    return "\n".join([
        "# Project-Relative Paths",
        (
            "Never use absolute or machine-specific paths in task cards, evidence, artifacts, "
            "plans, reviews, or handoff text. Full paths break when the repository is opened on "
            "another computer."
        ),
        (
            "All file and directory references must be relative to the project root, using forward "
            "slashes where practical, for example `src/renderer/src/App.tsx`, "
            "`souls/prompts/developer.md`, or `.multi-code/sprintengine/<team>/reviews/code-review-1.md`."
        ),
        (
            "For `Sprint Engine plan --path`, `sprintengine task log --file`, and `sprintengine artifact add --path`, "
            "pass only project-root-relative paths. If a tool prints an absolute path, convert it "
            "to a project-relative path before logging or writing it into an artifact."
        ),
    ])


def local_venv_install_guidance() -> str:
    return "\n".join([
        "# SprintEngine Local Python Environment",
        (
            "When running sprintengine work, you may install task-required Python packages into the "
            "repository-local virtual environment. Use `.venv/bin/python -m pip install <package>` "
            "on POSIX shells, or `.venv\\Scripts\\python.exe -m pip install <package>` on Windows."
        ),
        (
            "Do not install Python packages globally. If `.venv` is missing and the task genuinely "
            "requires Python dependencies, create or repair the repo-local virtual environment using "
            "the project's existing conventions, then log the commands as task evidence."
        ),
    ])


def production_reality_guidance() -> str:
    return "\n".join([
        "# Production Reality Gate",
        (
            "Sprint Engine work defaults to production implementation. Do not treat `MVP`, "
            "`first pass`, `local`, or `works in UI` as permission to ship sample data, generated "
            "demo entities, fake API responses, mocked transports, stubbed commands, placeholder "
            "persistence, disconnected local-only UI state, or controls that only simulate success."
        ),
        (
            "Mocks, fakes, fixtures, and generated sample data are allowed in tests, explicit "
            "prototypes, design mockups, or temporary scaffolding only when the task names that "
            "deliverable. They are not completion evidence for product behavior."
        ),
        (
            "Before marking implementation or review work done, identify the real source of truth, "
            "real mutation path, and real verification evidence for the user-visible behavior. "
            "Evidence must exercise the owned application module, IPC/API/CLI contract, file, "
            "database, service, command, device, or external integration that the product actually "
            "depends on."
        ),
        (
            "If the real dependency is unavailable, blocked, physically unverified, missing from "
            "the codebase, or outside the current task, do not claim the product behavior is done. "
            "Mark the task `needs_input` or record a blocker/follow-up, and make the remaining real "
            "integration explicit."
        ),
        (
            "Architect task cards and plan acceptance criteria must fail when the feature only "
            "works through hardcoded samples, disconnected UI state, fake success paths, mocks, "
            "stubs, or documentation of unverified limits."
        ),
    ])


def compose_prompt(
    swarm_heading: str,
    swarm_prompt: str,
    soul_prompt: Optional[str],
    priority_text: str,
) -> str:
    if not soul_prompt:
        return "\n\n".join([
            swarm_heading,
            swarm_prompt,
            "---",
            project_relative_path_guidance(),
            "---",
            local_venv_install_guidance(),
            "---",
            production_reality_guidance(),
            "---",
            "# Rule Priority",
            priority_text,
        ])

    return "\n\n".join([
        "# Soul Personality And Quality Bar",
        soul_prompt,
        "---",
        swarm_heading,
        swarm_prompt,
        "---",
        project_relative_path_guidance(),
        "---",
        local_venv_install_guidance(),
        "---",
        production_reality_guidance(),
        "---",
        "# Rule Priority",
        priority_text,
    ])


def load_prompt(role: str) -> str:
    path = PROMPTS_DIR / f"{role}.md"
    if not path.exists():
        raise SystemExit(f"Prompt file not found for role {role!r}: {path}")
    swarm_prompt = path.read_text(encoding="utf-8").strip()
    return compose_prompt(
        "# SprintEngine Coordination Rules",
        swarm_prompt,
        load_soul_prompt(role),
        (
            "Use the Soul prompt above for role personality, judgment, and quality bar. "
            "The Sprint Engine coordination rules below override it for tool mechanics: coordinate through "
            "the Sprint Engine tool, do not edit Sprint Engine state files directly, respect task ownership and owned "
            "paths, log evidence, create artifacts through the artifact commands, and stop when your "
            "Sprint Engine role instructions tell you to stop. Current user and task instructions override both "
            "when they are more specific and do not violate Sprint Engine coordination rules."
        ),
    )


def artifact_registration_instruction(agent_id: str) -> str:
    return (
        "Artifact-producing tasks: if the task asks for an artifact, review, report, "
        "requirements document, design notes, mockup, plan, or validation output, writing "
        "the file and logging evidence is not enough. Register the UI-visible artifact object "
        "before stopping. If the artifact needs human approval, register it ready for review:\n"
        "```\n"
        f"sprintengine artifact add --actor {agent_id} --task-id <task-id> --kind <artifact-kind> "
        f"--title \"<title>\" --path <path-under-team-folder> --created-by {agent_id} --ready\n"
        "sprintengine artifact list --task-id <task-id>\n"
        "```\n"
        "Use the task's requested kind when specified. Otherwise use `security_review` for "
        "security reviews, `code_review` for code reviews, `spec_review` for spec reviews, `performance_review` for performance "
        "reviews, `validation_report` for validation reports, `requirements` or `product_strategy` "
        "for product outputs, `design_notes` or "
        "`html_mockup` for frontend outputs, and `architect_plan` for plan gates. The `--ready` "
        "flag moves the linked task to `needs_input`; use it only when the artifact should wait for "
        "human approval. If a review artifact approves/passes the work with no findings, register "
        "the artifact, log evidence, and follow the completion rule below."
    )


def completion_reality_instruction() -> str:
    return (
        "Before any `done` status, verify that acceptance is met through real product paths, not "
        "sample data, hardcoded demo state, fake responses, mocked transports, stubbed commands, "
        "placeholder persistence, disconnected UI state, or documentation-only caveats. If the task "
        "requires hardware, native integration, an external service, persisted state, or a real "
        "cross-process contract, evidence must cover that real dependency or the task is not done. "
        "Use `needs_input`, a blocker note, or a concrete follow-up when real verification cannot be completed. "
    )

