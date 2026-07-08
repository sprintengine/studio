# Skill Rule Inventory

Canonical registry of the critical behaviour rules carried by the bundled
Sprint Engine skills (`resources/sprintengine/skills/`). Every rule has a
stable ID, one canonical home, and one or more **anchor phrases** that the
soul contract tests (`tests/sprintengine_tool/test_soul_contracts.py`) assert
are present in every rendered soul that includes the owning skill.

Rules for editing skills:

- An anchor phrase may not be reworded without updating the contract test in
  the same change.
- A duplicate statement of a rule may be deleted only if the canonical home
  is part of the same composed soul (all 18 bundled roles include all seven
  shared skills, so duplicates of shared rules are always deletable from role
  skills).
- Reviewer-side restatements (enforcement rubrics) are deliberate and stay;
  they should cite the canonical vocabulary rather than re-enumerate it.

## Cross-cutting rules (shared skills, in every role's soul)

| Rule ID | Canonical home | Anchor phrase(s) |
|---|---|---|
| `no-fake-success` | `production_reality_gate` | "Do not treat \`MVP\`, \`first pass\`, \`local\`, or \`works in UI\` as permission"; "not completion evidence" |
| `explicit-failure` | `fallback_discipline` | "explicit failure over surprising fallback" |
| `evidence-required` | `evidence_quality_assessment` | "Completion claims must be backed by" |
| `evidence-machine-first` | `evidence_quality_assessment` | "for the next agent, not for narration"; "under 700 characters" |
| `self-review` | `post_change_self_review` | "inspect your own diff" |
| `relative-paths` | `project_relative_paths` | "relative to the project root" |
| `kg-opt-in-gate` | `workspace_knowledge` | "MULTICODE_KNOWLEDGE_ROOT" |
| `lifecycle-truthful` | `multicode_backlog` | "part of the work, not optional bookkeeping"; "needs_input" |

## Phase directive packs (MC-1542)

Not part of any role's soul: the engine resolves a phase's base pack by id
(`sprintengine_phase_<phase>`) and delivers it inside the owner's own
`task.publish` / `task.advance` tool response. Pinned by
`test_phase_review_base_pack_carries_folded_reviewer_rules` via
`PHASE_REVIEW_ANCHORS`, not by the per-soul anchor tests.

| Rule ID | Canonical home | Anchor phrase(s) |
|---|---|---|
| `adversarial-self-review` | `sprintengine_phase_review` | "read it as if a stranger wrote it" |
| `contract-drift-blocking` | `sprintengine_phase_review` | "Contract drift is blocking"; "in the same publish" |
| `requirements-coverage` | `sprintengine_phase_review` | "Requirements coverage" |
| `smoke-not-validation` | `sprintengine_phase_review` | "quick smoke check"; "planned QA tasks own that" |
| `fix-forward` | `sprintengine_phase_review` | "Fix everything you find, now" |
| `escalation-default` | `sprintengine_phase_review` | "Never escalate to have your work confirmed" |
| `forward-only-walk` | `sprintengine_phase_review` | "A phase is visited at most once" |

## Sweep layer (MC-1542)

`sprintengine_sweep_workflow` is a HOST layer, not a manifest reference: it is
composed onto any role whose manifest declares a `sweep` block (bundled or
custom), by `skill_layers.sprintengine_extra_skills_for_role`. That is what lets a
third-party sweep pack declare `sweep: {focus, when}` and inherit the mandate for
free, without coupling its manifest to Sprint Engine. Pinned by
`tests/sprintengine_tool/test_sweeps.py`.

| Rule ID | Canonical home | Anchor phrase(s) |
|---|---|---|
| `sweep-fix-forward` | `sprintengine_sweep_workflow` | "Patch what you find, directly." |
| `sweep-no-hostage` | `sprintengine_sweep_workflow` | "Never take the whole sprint hostage over one finding." |
| `sweep-chained` | `sprintengine_sweep_workflow` | "never hosts two sweeps editing at once" |

Relocation ledger — the retired reviewer souls (`code_reviewer`, `spec_reviewer`,
`nuclear_reviewer`) are deleted in MC-1542 Stage 4. Their rules move as follows:

| From | Rule | New home |
|---|---|---|
| `nuclear_reviewer` | structural-decay bar, large-file risk, special-case sprawl | `sprintengine_phase_review` ("Structure" bullet) |
| `nuclear_reviewer` | contract-drift blocking, KG note in the same publish | `sprintengine_phase_review` (`contract-drift-blocking`) |
| `code_reviewer` | correctness, regressions, fallback-masking, evidence quality | `sprintengine_phase_review` (`fix-forward` + `explicit-failure` citation) |
| `spec_reviewer` | acceptance-criteria coverage, behaviour gaps, missing tests | `sprintengine_phase_review` (`requirements-coverage`) |
| `tester` | real-path validation, regression coverage, `validation_report` | `tester` (QA sweep role's `directives.implement`) — kept, not folded |
| `sprintengine_gate_feedback` | finding telemetry vocabulary, ~280-char summary budget | `sprintengine_phase_review` (`<supporting-info>`) |

## Duplicate occurrences and their dispositions

Recorded at the time of the 2026-06 dedup pass (see
`docs/2026-06-11-skill-emphasis-tags-review.md` §4 for why they accreted).

| Rule | Occurrence | Disposition |
|---|---|---|
| `explicit-failure` | `developer` core-principles bullet (near-verbatim copy of `fallback_discipline`) | **Deleted** — shadowed by shared skill |
| `relative-paths` | `developer` core-principles bullet | **Deleted** — shadowed by shared skill |
| `no-fake-success` | `developer` slop-list bullet ("Hardcoded sample entities…") | **Deleted** — shadowed by shared skill |
| `evidence-required` | `spec_reviewer` principle 6 (verbatim copy of the evidence list) | **Compressed to a citation** of the shared rule |
| `no-fake-success` | reviewer rubrics in `code_reviewer`, `production_readiness_reviewer`, `spec_reviewer`, `security`, `performance`, `creative`, `architect`, `presentation` | **Kept** — deliberate producer/reviewer duality; rubrics cite the canonical vocabulary |
| `kg-opt-in-gate` | "Respect the user's choice when it is unset" (`workspace_knowledge`) | **Deleted** — restated the directive above it |

## Role identity anchors

Each role skill carries one identity anchor so the contract tests catch a
role skill being dropped or hollowed out.

| Skill | Anchor |
|---|---|
| `developer` | "principal software engineer" |
| `security` | "principal application security engineer" |
| `code_reviewer` | "principal-level code quality reviewer" |
| `tester` | "principal QA engineer" |
| `architect` | "expert software architect" |
| `product` | "principal product strategist" |
| `frontend` | "senior frontend engineer" |
| `devops` | "principal DevOps and infrastructure engineer" |
| `performance` | "principal performance engineer" |
| `presentation` | "senior product storyteller" |
| `creative` | "senior creative engineer" |
| `cross_platform` | "principal cross-platform compatibility engineer" |
| `nuclear_reviewer` | "Nuclear Reviewer" |
| `production_readiness_reviewer` | "principal production readiness reviewer" |
| `spec_reviewer` | "principal-level specification reviewer" |
| `ui_ux_reviewer` | "senior frontend UI/UX reviewer" |
| `coordinator` | "principal-level coordination agent" |
| `blog_writer` | "senior blog writer" |

## Adding a new rule or skill

1. Add the rule here with an ID, canonical home, and anchor phrase.
2. Add the anchor to `SKILL_ANCHORS` in
   `tests/sprintengine_tool/test_soul_contracts.py` (the test fails for any
   bundled skill with no anchor entry, so this is enforced).
3. State the rule once in its canonical home's `<what-to-do>` block; other
   skills reference it instead of restating it.
