# Sprint Engine Soul Composition Migration Notes

T3 migrated bundled role manifests from one monolithic role skill to ordered compositions of a role-specific skill plus shared reusable skills.

## Shared Skills

- `project_relative_paths`: extracted from repeated Path Rule sections so all bundled Souls use one portable-path instruction.
- `production_reality_gate`: consolidates no-mock-runtime, real-source-of-truth, and completion-evidence requirements that previously appeared under production implementation, production reality, or production evidence headings.
- `fallback_discipline`: consolidates explicit-failure and no-silent-fallback requirements.
- `evidence_quality_assessment`: consolidates evidence-quality expectations used by reviewer, tester, security, performance, and product roles.
- `post_change_self_review`: consolidates post-change self-review instructions.
- `collaboration_norms`: consolidates ask-vs-act and role-boundary collaboration instructions.
- `sprintengine_workflow`: adds the shared Sprint Engine command workflow, evidence logging, `needs_input`, and join-watch continuation rules to every bundled rendered Soul.

## Intentional Prompt Drift

- Some role-specific skills that did not previously carry every shared section now inherit the common Sprint Engine operating rules. This is intentional so bundled roles render from a consistent production-quality baseline.
- Role-specific sections remain in their original skill documents. The migration removed duplicated common sections only where the heading clearly matched one of the shared skills above.
- No bundled role has a documented exception to single-skill composition; each bundled role now uses its role-specific skill plus shared skills.
