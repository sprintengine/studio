"""Soul and Sprint Engine prompt composition helpers."""

from __future__ import annotations

from typing import Iterable, Optional, Sequence

from sprintengine_core.tool.paths import PROMPTS_DIR, REPO_ROOT
from sprintengine_core.role_registry import (
    SOUL_LEGEND,
    RegistryDiscovery,
    RoleManifest,
    SkillDocument,
    SoulRenderError,
    discover_role_registry,
    normalize_role_id,
)
from sprintengine_core.skill_layers import (
    SPRINTENGINE_ROLELESS_WORKFLOW_SKILL,
    SPRINTENGINE_NORM_SKILLS,
    knowledge_root_is_configured,
    multicode_layer_skills_for_run,
    sprintengine_soul_extra_skills,
)


SPRINTENGINE_SKILLS_DIR = REPO_ROOT / "resources" / "sprintengine" / "skills"
SPRINTENGINE_IMPLEMENTATION_ROLES = {"blog_writer", "creative", "developer", "devops", "frontend", "presentation", "product"}


def load_soul_prompt(
    role: Optional[str],
    *,
    backlog_sourced: bool = True,
    knowledge_root_configured: Optional[bool] = None,
) -> Optional[str]:
    # Role manifests carry only the portable role identity. A Sprint Engine dispatch
    # layers the Multicode product skills (gated per run) and the Sprint Engine
    # quality norms on top, so the rendered brief carries the full quality bar
    # without any of it being baked into the manifest.
    # `knowledge_root_configured=None` resolves from this process's env — correct
    # for CLI/stdio composition, overridden by the HTTP run context.
    if knowledge_root_configured is None:
        knowledge_root_configured = knowledge_root_is_configured()
    if not str(role or "").strip():
        # No role at all (MC-2057). There is no manifest to render, so render the
        # roleless layer (norms + orchestration) instead — this shared chokepoint
        # must never drop the norms for a roleless agent on the CLI-join or
        # plan-review composition paths.
        return load_roleless_soul_prompt(
            backlog_sourced=backlog_sourced,
            knowledge_root_configured=knowledge_root_configured,
        )
    try:
        discovery = discover_role_registry()
        return (
            discovery
            .render_soul(
                role,
                workspace_root=REPO_ROOT,
                extra_skills=sprintengine_soul_extra_skills(
                    backlog_sourced=backlog_sourced,
                    knowledge_root_configured=knowledge_root_configured,
                ),
            )
            .content
        )
    except (KeyError, SoulRenderError):
        return None


def load_roleless_soul_prompt(
    registry: Optional[RegistryDiscovery] = None,
    *,
    backlog_sourced: bool = True,
    knowledge_root_configured: Optional[bool] = None,
) -> Optional[str]:
    """Render a roleless agent's quality + orchestration layer.

    An agent with no role carries no role-personality Soul. It still receives the
    full Sprint Engine quality bar — the same universal norm + Multicode product
    skills every dispatched agent gets (product skills gated per run, like a
    specialist render) — plus the orchestration skill that describes the shape of
    a roleless run and drives one agent through build -> self-review -> publish.
    There is no manifest to render, so this composes the layer skills directly
    (in the same ``<skill>`` envelope a soul render uses). Composing it
    deliberately is what stops the universal norms from being dropped the way a
    manifest-less role otherwise would fall through to the no-soul fallback.

    ``registry`` lets a workspace-scoped caller (the MCP join) reuse its already
    discovered registry so workspace skill overrides apply, exactly as they do for
    a specialist soul render; callers without one get the default discovery.
    """
    registry = registry if registry is not None else discover_role_registry()
    if knowledge_root_configured is None:
        knowledge_root_configured = knowledge_root_is_configured()
    roleless_skills = (
        SPRINTENGINE_ROLELESS_WORKFLOW_SKILL,
        *multicode_layer_skills_for_run(
            backlog_sourced=backlog_sourced,
            knowledge_root_configured=knowledge_root_configured,
        ),
        *SPRINTENGINE_NORM_SKILLS,
    )
    parts: list[str] = []
    for raw_skill in roleless_skills:
        skill_id = normalize_role_id(raw_skill)
        entry = registry.skills.get(skill_id)
        if entry is None or not isinstance(entry.value, SkillDocument):
            continue
        body = entry.value.body.strip()
        if body:
            parts.append(f'<skill name="{skill_id}">\n{body}\n</skill>')
    if not parts:
        return None
    return "\n\n".join((SOUL_LEGEND, *parts))


def load_sprintengine_runtime_skill(skill_id: str) -> str:
    path = SPRINTENGINE_SKILLS_DIR / skill_id / "SKILL.md"
    if not path.exists():
        raise FileNotFoundError(f"Sprint Engine runtime skill is missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def sprintengine_runtime_skill_ids(role: Optional[str]) -> list[str]:
    skill_ids = ["sprintengine_workflow"]
    if role == "architect":
        skill_ids.append("sprintengine_architect_workflow")
    if role in SPRINTENGINE_IMPLEMENTATION_ROLES:
        skill_ids.append("sprintengine_publish_feedback")
    return skill_ids


def generic_role_swarm_prompt(role: Optional[str]) -> str:
    # Role identity + the claim payload shape only. Claim/publish/advance,
    # owned-path, evidence, and quality mechanics are owned by the
    # `sprintengine_workflow` runtime skill and the shared norm skills — never
    # restate them here (prompt-layer policy: one behavior, one layer).
    if not str(role or "").strip():
        # No role to name and no role to filter by (MC-2057). Deliberately states
        # no identity: this sprint has no roles, so inventing one here would put
        # back the stand-in the engine just deleted.
        return "\n\n".join([
            "# Sprint Agent",
            "",
            (
                "This sprint runs no roles. Follow the Sprint Engine coordination rules for all task, "
                "artifact, evidence, and handoff mechanics. Claim work with `sprintengine.task.next` "
                "using `{ id: \"<your-id>\" }`; it resumes your active task or claims the next ready "
                "one, and every ready task is claimable by any agent. Do not run `sprintengine` shell "
                "commands for autonomous work — the CLI is reserved for human and debug operators."
            ),
        ])
    return "\n\n".join([
        f"# {role.replace('_', ' ').title()}",
        "",
        (
            "You are a configured Sprint Engine specialist. Follow your rendered Soul guidance for "
            "domain judgment and the Sprint Engine coordination rules for all task, artifact, "
            "evidence, and handoff mechanics. Claim work with `sprintengine.task.next` using "
            f"`{{ role: \"{role}\", id: \"<your-id>\" }}`; it resumes your active task or claims the "
            "next ready one, and you work tasks assigned to your role plus tasks carrying no role. "
            "Do not run `sprintengine` shell commands for autonomous work — the CLI is reserved for "
            "human and debug operators."
        ),
    ])


def architect_role_catalog(
    role: Optional[str],
    staffed_roles: Iterable[str],
    *,
    discovery: Optional[RegistryDiscovery] = None,
) -> Optional[str]:
    """The run's staffed roles and what each one is for, for the planning role.

    Only the architect picks who does what, so only its brief carries this. A
    role's capabilities are prose (MC-1831): the manifest `description` is
    rendered verbatim and nothing in the engine derives behaviour from its text.
    A staffed id with no manifest (a pack the user removed) is skipped rather than
    guessed at.
    """
    if normalize_role_id(str(role or "")) != "architect":
        return None
    resolved = discovery if discovery is not None else discover_role_registry()
    seen: set[str] = set()
    entries: list[RoleManifest] = []
    for raw_role in staffed_roles:
        try:
            manifest = resolved.get_role(str(raw_role))
        except KeyError:
            continue
        if manifest.normalized_id in seen:
            continue
        seen.add(manifest.normalized_id)
        entries.append(manifest)
    if not entries:
        return None
    return "\n".join([
        "# Roles On This Run",
        "",
        (
            "Each line is the role's own manifest description — what it does and when to staff it. "
            "This is the whole capability statement a role carries; read it as written and plan tasks "
            "for these roles only."
        ),
        "",
        *(
            f"- **{manifest.label}** (`{manifest.id}`): "
            f"{manifest.description or '(its manifest carries no description)'}"
            for manifest in entries
        ),
    ])


def load_sprintengine_coordination_prompt(role: Optional[str], *, role_catalog: Optional[str] = None) -> str:
    # A roleless dispatch has no per-role prompt file to look up; it composes the
    # generic swarm prompt directly rather than probing the filesystem for `None.md`.
    clean_role = str(role or "").strip()
    path = PROMPTS_DIR / f"{clean_role}.md" if clean_role else None
    role_prompt = (
        path.read_text(encoding="utf-8").strip()
        if path is not None and path.exists()
        else generic_role_swarm_prompt(clean_role)
    )
    runtime_skills = [
        load_sprintengine_runtime_skill(skill_id) for skill_id in sprintengine_runtime_skill_ids(role)
    ]
    return "\n\n---\n\n".join([
        *runtime_skills,
        role_prompt,
        *([role_catalog] if role_catalog else []),
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
    # Quality norms (project-relative paths, production reality, fallback
    # discipline, evidence, self-review) are composed into `soul_prompt` as the
    # Sprint Engine quality layer (see load_soul_prompt). Only the SE-specific
    # local-venv guidance, which has no skill equivalent, is inlined here. When
    # the soul fails to render, fall back to the standalone venv guidance plus
    # the norm guidance so a degraded dispatch still carries the quality bar.
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
        local_venv_install_guidance(),
        "---",
        "# Rule Priority",
        priority_text,
    ])


def load_prompt(
    role: Optional[str],
    *,
    backlog_sourced: bool = True,
    knowledge_root_configured: Optional[bool] = None,
    staffed_roles: Sequence[str] = (),
) -> str:
    return compose_prompt(
        "# SprintEngine Coordination Rules",
        load_sprintengine_coordination_prompt(
            role,
            role_catalog=architect_role_catalog(role, staffed_roles),
        ),
        load_soul_prompt(
            role,
            backlog_sourced=backlog_sourced,
            knowledge_root_configured=knowledge_root_configured,
        ),
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
        "`performance_review` for performance reviews, `production_readiness_review` for "
        "production-readiness release reviews, `cross_platform_review` for compatibility reviews, "
        "`validation_report` for validation reports, "
        "`requirements` or `product_strategy` for product outputs, `design_notes` or `html_mockup` "
        "for frontend outputs, and `architect_plan` for the plan approval task. If a review artifact approves "
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
