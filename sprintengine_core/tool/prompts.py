"""Soul and Sprint Engine prompt composition helpers."""

from __future__ import annotations

from typing import Optional

from sprintengine_core.tool.paths import PROMPTS_DIR, REPO_ROOT
from sprintengine_core.role_registry import SoulRenderError, discover_role_registry


SPRINTENGINE_SKILLS_DIR = REPO_ROOT / "resources" / "sprintengine" / "skills"
SPRINTENGINE_IMPLEMENTATION_ROLES = {"blog_writer", "coordinator", "creative", "developer", "devops", "frontend", "presentation", "product"}
SPRINTENGINE_GATE_ROLES = {"code_reviewer", "performance", "product", "security", "spec_reviewer", "tester"}


def load_soul_prompt(role: str) -> Optional[str]:
    try:
        return discover_role_registry().render_soul(role, workspace_root=REPO_ROOT).content
    except (KeyError, SoulRenderError):
        return None


def load_sprintengine_runtime_skill(skill_id: str) -> str:
    path = SPRINTENGINE_SKILLS_DIR / skill_id / "SKILL.md"
    if not path.exists():
        raise FileNotFoundError(f"Sprint Engine runtime skill is missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def sprintengine_runtime_skill_ids(role: str) -> list[str]:
    skill_ids = ["sprintengine_workflow"]
    if role == "architect":
        skill_ids.append("sprintengine_architect_workflow")
    if role in SPRINTENGINE_IMPLEMENTATION_ROLES:
        skill_ids.append("sprintengine_publish_feedback")
    if role in SPRINTENGINE_GATE_ROLES:
        skill_ids.append("sprintengine_gate_feedback")
    return skill_ids


def generic_role_swarm_prompt(role: str) -> str:
    return "\n\n".join([
        f"# {role.replace('_', ' ').title()}",
        "",
        "You are a configured Sprint Engine specialist. Follow your rendered Soul guidance for domain judgment, and follow the Sprint Engine coordination rules for all task, gate, artifact, evidence, and handoff mechanics.",
        "",
        "## Responsibilities",
        "",
        f"- Claim tasks and gates assigned exactly to the `{role}` role.",
        "- Read the task description, acceptance criteria, implementation notes, owned paths, evidence, and latest feedback before acting.",
        "- Keep edits scoped to owned paths unless a directly required companion edit is logged as a scope expansion.",
        "- Verify the real product path before publishing or completing work.",
        "- Log touched files, commands, and results before handoff.",
        "",
        "## Work Sequence",
        "",
        "Coordinate through the Sprint Engine MCP tools. Do not run `sprintengine` shell commands for autonomous work — the CLI is reserved for human and debug operators.",
        "",
        f"1. Call `sprintengine.agent.next_directive` with `{{ role: \"{role}\", agentId: \"<your-id>\" }}` to get your next directive.",
        "2. Follow the directive's `nextMcpToolName` with `nextMcpArguments` verbatim to claim or resume work.",
        "3. Log evidence via `sprintengine.task.log` with `{ taskId, id, summary, file, command, result }`.",
        "4. Publish implementation evidence via `sprintengine.task.publish` with `{ taskId, id, summary, path, data }`.",
        "5. Record gate verdicts via `sprintengine.gate.verdict` with `{ taskId, gateId, role, id, verdict, summary }`.",
        "6. After each completion or verdict, call `sprintengine.agent.next_directive` again to receive the next directive.",
        "",
        "## Quality Standards",
        "",
        "- Do not edit Sprint Engine run-store files directly.",
        "- Do not claim work assigned to another role.",
        "- Do not mark work complete when the main behavior depends on sample data, fake responses, mocked transports, stubbed commands, placeholder persistence, or disconnected local state.",
        "- If real verification is blocked, route the task or gate to `needs_input` via `sprintengine.task.status` with the appropriate actor, reason, and question.",
        "- If `MULTICODE_KNOWLEDGE_ROOT` is set and your change affects a behavior, contract, file layout, or convention documented in the Knowledge Graph, update the relevant note in the same publish. Log the note path as `sprintengine.task.log` `file` evidence. See the `workspace_knowledge` skill for the full read/update workflow and the env-var gate.",
    ])


def load_sprintengine_coordination_prompt(role: str) -> str:
    path = PROMPTS_DIR / f"{role}.md"
    role_prompt = path.read_text(encoding="utf-8").strip() if path.exists() else generic_role_swarm_prompt(role)
    runtime_skills = [load_sprintengine_runtime_skill(skill_id) for skill_id in sprintengine_runtime_skill_ids(role)]
    return "\n\n---\n\n".join([
        *runtime_skills,
        role_prompt,
    ])


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
            "`resources/sprintengine/skills/developer/SKILL.md`, or `.multi-code/sprintengine/<team>/reviews/code-review-1.md`."
        ),
        (
            "For Sprint Engine MCP payload fields that carry paths — `path` on `sprintengine.plan.add_task`, "
            "`file` on `sprintengine.task.log`, `path` on `sprintengine.artifact.add`, and the corresponding "
            "fields on plan/artifact updates — pass only project-root-relative paths. If a tool result returns "
            "an absolute path, convert it to a project-relative path before logging or writing it into an artifact."
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
    return compose_prompt(
        "# SprintEngine Coordination Rules",
        load_sprintengine_coordination_prompt(role),
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
        "via the Sprint Engine MCP tools before stopping.\n\n"
        "Call `sprintengine.artifact.add` with `{ taskId, kind, title, path, "
        f"createdBy: \"{agent_id}\", ready }}`. Set `ready: true` only when the artifact should "
        "wait for human approval (this moves the linked task to `needs_input`). Otherwise call "
        "`sprintengine.artifact.ready` with `{ artifactId, id }` later when you are "
        "ready to hand off for review. Use `sprintengine.artifact.list` with `{ taskId }` "
        "to confirm registration.\n\n"
        "Use the task's requested kind when specified. Otherwise use `security_review` for "
        "security reviews, `code_review` for code reviews, `spec_review` for spec reviews, "
        "`performance_review` for performance reviews, `cross_platform_review` for compatibility reviews, "
        "`validation_report` for validation reports, "
        "`requirements` or `product_strategy` for product outputs, `design_notes` or `html_mockup` "
        "for frontend outputs, and `architect_plan` for plan gates. If a review artifact approves "
        "the work with no findings, register the artifact, log evidence, and follow the completion "
        "rule below."
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
