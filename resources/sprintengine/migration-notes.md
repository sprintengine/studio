# Sprint Engine Soul Composition Migration Notes

T3 migrated bundled role manifests from one monolithic role skill to ordered compositions of a role-specific skill plus shared reusable skills.

## Shared Skills

- `project_relative_paths`: extracted from repeated Path Rule sections so all bundled Souls use one portable-path instruction.
- `production_reality_gate`: consolidates no-mock-runtime, real-source-of-truth, and completion-evidence requirements that previously appeared under production implementation, production reality, or production evidence headings.
- `fallback_discipline`: consolidates explicit-failure and no-silent-fallback requirements.
- `evidence_quality_assessment`: consolidates evidence-quality expectations used by reviewer, tester, security, performance, and product roles.
- `post_change_self_review`: consolidates post-change self-review instructions.
- `workspace_knowledge`: adds env-var-gated Knowledge Graph read/update guidance for workspaces that configure it.
- `sprintengine_workflow`: retained as a Sprint Engine runtime workflow skill, but not included in base bundled role Souls. Sprint Engine roster agents receive coordination mechanics through `sprintengine.agent.join`, where the MCP server composes the role Soul with MCP-specific workflow rules.
- `sprintengine_architect_workflow`, `sprintengine_publish_feedback`, and `sprintengine_gate_feedback`: runtime-only Sprint Engine skills for role-specific planning, publish feedback, and gate verdict feedback. They live beside the bundled skills but are injected by the Sprint Engine runtime rather than referenced by role manifests.
- Removed shared skill: `collaboration_norms` was retired after migration because it mixed generic communication style, ask-vs-act policy, and Sprint Engine role-boundary behavior into pluggable Soul identity. Standalone specialist bootstrap now handles "load Soul, then wait for instruction"; Sprint Engine role-boundary behavior lives in Sprint Engine runtime prompts.

## Intentional Prompt Drift

- Some role-specific skills that did not previously carry every shared section now inherit common production, evidence, fallback, and Knowledge Graph rules. This is intentional so bundled roles render from a consistent production-quality baseline without coupling manual Souls to Sprint Engine dispatch.
- Role-specific sections remain in their original skill documents. The migration removed duplicated common sections only where the heading clearly matched one of the shared skills above.
- No bundled role has a documented exception to single-skill composition; each bundled role now uses its role-specific skill plus shared skills.
