# Review: Emphasis Tags for Skills (`<what-to-do>` / `<supporting-info>`)

**Date:** 2026-06-11
**Status:** Proposal — no skill content changed yet
**Prompted by:** Matt Pocock's public skills repo ([mattpocock/skills](https://github.com/mattpocock/skills)) and its use of semantic envelope tags to separate core directives from reference material.

## 1. What the pattern actually is

In `mattpocock/skills`, a handful of skills (`grill-with-docs`, plus the
in-progress `writing-shape` / `writing-beats` / `writing-fragments`) structure
the SKILL.md body as exactly two top-level blocks:

```markdown
<what-to-do>

Short, imperative, non-negotiable. Typically 3–6 sentences. Defines what the
agent must do and the contract it must not break ("Do not edit the raw
material file — it is read-only to this skill").

</what-to-do>

<supporting-info>

Everything else: workflows, file formats, heuristics, worked examples,
edge-case guidance. Ordinary markdown headings live *inside* this block.

</supporting-info>
```

Two things are worth being precise about, because the pattern is easy to
over-read:

1. **It is a two-tag vocabulary, not a tag system.** The other angle-bracket
   strings in his repo (`<path>`, `<issue-template>`, `<dash-case-name>`…) are
   placeholders inside templates, not emphasis markers. The emphasis vocabulary
   is exactly `what-to-do` and `supporting-info`.
2. **The mechanism is salience that survives flattening.** Markdown headings
   carry no priority information — `## Lifecycle Updates Are Mandatory` and
   `## Item Vocabulary` look identical to the model. A named semantic envelope
   says "this block is the directive, the rest is reference" in a way that
   still reads correctly when the skill is buried in a long prompt, because
   the boundary is explicit rather than positional. It is the same reason
   Anthropic's own prompting guidance favours XML-ish section tags.

His companion `write-a-skill` guidance adds the related discipline: keep
SKILL.md under ~100 lines and push overflow into `REFERENCE.md` /
`EXAMPLES.md` (progressive disclosure). For our *composed* skills that escape
hatch doesn't exist — everything in the file lands in the prompt — which makes
the in-band `<supporting-info>` demotion the only lever we have there.

## 2. Where our skills stand today

We have two skill families with different failure modes.

### 2a. Sprint Engine Soul skills (`resources/sprintengine/skills/`)

These are composed: `RoleRegistry.render_soul()`
(`sprintengine_core/role_registry.py:178`) joins each referenced SKILL.md body
with `\n\n`, in manifest order, into one flat prompt. Every role manifest in
`resources/sprintengine/roles/` pulls in **eight** skills — e.g. `developer`:

| Skill | Lines | Nature |
|---|---|---|
| `developer` | 62 | role identity + principles + slop list |
| `multicode_backlog` | 105 | ~15 lines of contract + ~90 lines of mechanics (FNV-1a command, schema fields) |
| `project_relative_paths` | 5 | pure directive |
| `production_reality_gate` | 11 | pure directive |
| `fallback_discipline` | 7 | pure directive |
| `evidence_quality_assessment` | 7 | pure directive |
| `post_change_self_review` | 7 | pure directive |
| `workspace_knowledge` | 55 | 1 crucial gate + workflows/checklists |

The composed soul is ~260 lines containing roughly 30 markdown headings, all
at the same level of emphasis. The dilution shows up three ways:

- **Crucial behaviours and plumbing look identical.** "Set `needs_input` the
  moment you stop to wait" (a behaviour users directly see in the Backlog
  panel) has the same visual weight as the `node -e` FNV-1a one-liner and the
  schema-v1 field list. The five discipline micro-skills — which are *entirely*
  core directive — are indistinguishable from reference bulk.
- **Heading collisions.** `developer/SKILL.md` and `security/SKILL.md` both
  open with `# Role` and `# Core Principles`. Composed, the document outline is
  ambiguous: a second `# Core Principles` 200 lines later reads as a
  continuation, an override, or noise depending on the model's mood.
- **Redundancy amplifies the flatness.** `production_reality_gate`,
  `post_change_self_review`, `evidence_quality_assessment`, and
  `fallback_discipline` restate overlapping "no mocks / no fake success / real
  evidence" rules in different words, and the developer skill's AI-slop list
  overlaps again. Repetition without hierarchy reads as boilerplate, which is
  exactly what trains a model to skim.

### 2b. User-invocable skills (`.claude/skills/`, `resources/skills/`)

These load on demand, so they don't compose with each other — but they *do*
land inside an already-long agent context, and they have the same internal
flatness. In `.claude/skills/backlog/SKILL.md`, the truthfulness contract
("status updates are part of the work, not optional bookkeeping"; "never
compute the hash in your head") shares level-2 headings with the object-store
schema walk-through. The crucial lifecycle rules are the *last* section of the
file, after 90 lines of mechanics.

## 3. Proposed integration

### 3.1 Adopt the two-tag vocabulary, verbatim

Use `<what-to-do>` and `<supporting-info>`, exactly as Matt Pocock does, in
every SKILL.md in both families. Reasons to not invent our own names: the
semantics are self-describing, there's prior art the team can point at, and a
two-tag vocabulary is the point — a richer taxonomy (`<critical>`,
`<important>`, `<nice-to-have>`…) recreates the dilution problem one level up
and invites grade inflation until everything is `<critical>`.

Budget rule of thumb: `<what-to-do>` should fit in **~10 lines** per skill. If
it doesn't, the skill is trying to make too many things core, and that is the
dilution we're fighting — cut or demote, don't grow the block.

### 3.2 Restructure per skill (worked examples)

- **The five discipline micro-skills** (`fallback_discipline`,
  `production_reality_gate`, `post_change_self_review`,
  `evidence_quality_assessment`, `project_relative_paths`): these are 100%
  directive. Rather than wrapping five tiny files in five `<what-to-do>`
  blocks, **merge them into a single `delivery_discipline` skill** whose body
  is one `<what-to-do>` block of deduplicated rules (real implementation, real
  evidence, explicit failure, self-review before handoff, relative paths).
  Five same-weight headings collapse into one high-salience block, and the
  overlapping restatements get said once, well. Role manifests swap five
  `soul` entries for one.
- **`multicode_backlog` / `.claude/skills/backlog`**: `<what-to-do>` carries
  the contract — items are durable records; set `in_progress` before work,
  `needs_input` with a stated question when blocked, `completed` only when
  verified; the object store is the source of truth; *follow the recorded
  update procedure exactly and never hand-compute ids or timestamps*.
  `<supporting-info>` carries the schema fields, matching rules, the FNV-1a
  command, and the survey/ranking flow. Note the last what-to-do clause: a
  hard constraint that lives inside otherwise-supporting mechanics gets a
  one-line pointer in `<what-to-do>` so demotion doesn't bury it.
- **`workspace_knowledge`**: the env-var gate ("if neither
  `MULTICODE_KNOWLEDGE_ROOT` nor the legacy alias is set, skip everything —
  do not create notes, do not nag") plus "KG updates ship in the same handoff
  as the source change" is `<what-to-do>`. Read/update workflows, do-not-store
  list, and the reviewer-responsibility rule are `<supporting-info>`.
- **Role-identity skills** (`developer`, `security`, `code_reviewer`,
  `devops`…): role framing + core principles + risk classification →
  `<what-to-do>` (trimmed to the budget); workflows, checklists, and the
  AI-slop catalogue → `<supporting-info>`. The 250–320-line reviewers
  (`security`, `code_reviewer`) are also over the ~100-line guideline; since
  they always render in full, the supporting-info demotion matters most there.

### 3.3 Make the renderer scope each skill (our integration point)

Matt's skills are loaded one at a time, so he never hits the composition
problem; we do, and we own the renderer. Two small changes to
`render_soul()`:

1. **Wrap each composed part in a provenance envelope** instead of a bare
   `\n\n` join:

   ```xml
   <skill name="multicode_backlog">
   …SKILL.md body…
   </skill>
   ```

   This fixes the `# Role` heading collisions structurally (each skill's
   headings are scoped to its envelope) and gives reviewers/debuggers
   provenance when reading a rendered soul.

2. **Emit a three-line legend once, at the top of the rendered soul**, telling
   the model what the tags mean: sections in `<what-to-do>` are mandatory
   behaviour that override anything in `<supporting-info>`; supporting-info is
   reference detail to consult when relevant. Claude treats XML section tags
   well innately, but the legend makes the contract explicit and is cheap
   insurance for the non-Claude agents we also target (`agents/openai.yaml`
   exists in the installable backlog skill).

   Do **not** reorder content (e.g. hoisting all `<what-to-do>` blocks to the
   top). Per-skill cohesion is worth more than positional priority, and the
   tags carry the salience on their own.

Optionally, the registry's existing warning machinery
(`RegistryWarning`, which already covers missing/invalid skills) can lint for
skills with no `<what-to-do>` block or with an oversized one, so the
convention doesn't decay.

### 3.4 Propagation constraints

The backlog skill exists as synchronized copies in `.claude/`, `.gemini/`,
`.cursor/`, `.opencode/`, `.agents/`, `resources/skills/`, and (as
`multicode_backlog`) in the Soul family — the files carry "keep in sync"
comments. Any restructure lands in all copies in the same change. Frontmatter
(`name`/`description`) is untouched by this proposal; tags only structure the
body, so skill discovery/triggering is unaffected.

## 4. Honest caveats

- **Tags are not the whole fix.** The biggest dilution driver in the composed
  souls is volume plus redundancy — four skills restating the
  no-fake-success rule. Tagging without the consolidation in §3.2 gets maybe
  half the benefit. Conversely, consolidation alone still leaves crucial rules
  visually equal to FNV-1a plumbing, so do both.
- **The evidence for the pattern is directional, not measured.** It aligns
  with Anthropic's published prompting guidance and our own experience that
  flat long prompts decay, but nobody (including Matt Pocock — the tagged
  writing skills sit in his `in-progress/` folder) has benchmarked it. Treat
  the first conversion as an experiment: convert one role (`developer` is the
  best candidate — smallest role skill, all eight soul entries), run it
  through a few Sprint Engine cycles, and watch specifically whether lifecycle
  status discipline and evidence quality hold up before converting the
  reviewer roles.
- **Discipline is the hard part.** The convention only works if
  `<what-to-do>` stays small. The lint in §3.3 is what keeps the floor from
  sloping back.

## 5. Suggested sequencing

1. Renderer: envelope-wrap + legend in `render_soul()` (no skill edits needed;
   immediately fixes heading collisions). Add the lint warnings.
2. Merge the five discipline micro-skills into `delivery_discipline`; update
   all role manifests.
3. Convert `developer` + its soul set; trial in real sprints.
4. Convert remaining Soul skills (reviewers last — they're the largest and
   benefit most from a careful what-to-do trim, not a mechanical wrap).
5. Convert the user-invocable family, propagating the backlog skill to all
   synced copies in one change.
