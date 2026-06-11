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

## 4. The duplication inventory — what is repeated and why

Four rules are restated across the skill set, with file:line evidence. Each
appears multiple times *within a single composed soul* because every role
manifest includes all five discipline micro-skills plus a role skill that
predates them.

1. **No fake success (real implementation).** Canonical home:
   `production_reality_gate`. Also restated in `developer:62` (slop-list
   bullet), `post_change_self_review:5`, `fallback_discipline:5`, and per
   role in `security:49`, `performance:106`, `code_reviewer:125,130`,
   `production_readiness_reviewer:21,58,74`, `spec_reviewer:37,103`,
   `creative:81,143`, `architect:63`, `presentation:64`. The developer soul
   states it 4×; reviewer souls 5–6×.
2. **Explicit failure over fallback.** `fallback_discipline:3` and
   `developer:11` are near-verbatim duplicates of each other.
3. **Evidence requirements.** `evidence_quality_assessment:3`'s list
   reappears almost verbatim in `spec_reviewer:18` and overlaps
   `production_reality_gate:7`, `post_change_self_review:7`, and
   `multicode_backlog:100-101`.
4. **Project-relative paths.** The 5-line `project_relative_paths` skill plus
   restatements in `developer:16`, `multicode_backlog`,
   `workspace_knowledge:49`, `cross_platform`, and `blog_writer`.

Why it happened, because the mechanism dictates the fix:

- **Layering without subtraction** — role skills were written self-contained;
  the shared micro-skill layer was added later and the role-skill copies were
  never removed (`developer:11` vs `fallback_discipline:3` is the smoking
  gun). Fix: delete the shadowed copies.
- **À-la-carte composition makes authors defensive** — a skill can't assume
  which others are present, so each inlines its dependencies. All current
  manifests include all five micro-skills, so the defensive copies never pay
  off. Fix: the consolidated discipline skill becomes a guaranteed layer.
- **Producer/reviewer symmetry — partially legitimate.** "Don't ship fakes"
  (producer) and "fail work that ships fakes" (reviewer rubric, with scoring
  weights) are genuinely different obligations. Keep both; but each currently
  re-enumerates the fake-things vocabulary from scratch and the seven copies
  have drifted — no two lists agree. Fix: one canonical vocabulary, cited.
- **Incident-driven accretion** — rules grew a restatement per incident,
  wherever the author was looking. Repetition-as-emphasis works only with
  hierarchy; by the fourth flat restatement it reads as boilerplate.

Target state per soul: **two deliberate statements** of each critical rule —
once in the consolidated discipline layer (producer obligation, owning the
canonical vocabulary) and once per reviewer skill (enforcement rubric citing
that vocabulary) — instead of four-to-six drifted copies.

## 5. Compression — fewer words per rule

Two different "too long" problems hide under one complaint, and only one is
real:

- **Token budget: mostly a non-issue.** A 260-line soul is ~3–4k tokens.
- **Salience: a real issue.** Verbosity is dilution at the sentence level,
  exactly as duplication is dilution at the document level. Exhaustive
  enumerations ("inputs, permissions, configuration, state, external data,
  user intent, or unavailable dependencies") are incident logs — each item
  closed a loophole — but models generalize from a crisp category plus 2–3
  examples; the seventh item adds attention cost, not binding force.

Levers, in descending order of value:

1. **One full statement per rule; short references elsewhere.** This is the
   §4 dedup move — compression and deduplication are the same edit.
2. **Category + examples in directives; the exhaustive vocabulary survives
   exactly once**, in the canonical skill's `<supporting-info>`, where
   reviewer rubrics cite it. Relocate full lists, never delete them.
3. **Qualifier audit — per instance, never mechanical.** Hedges split into
   load-bearing escape hatches ("where practical" on relative paths: strip it
   and agents will mangle legitimately-absolute paths) and flab ("Respect the
   user's choice when it is unset", restating the directive above it). Each
   gets a keep/cut call recorded in the rule inventory (§6).
4. **(Deferred)** Extracting the FNV-1a/items.json mechanics into a script or
   MCP tool was considered and rejected for now: a loose script can't assume
   `node` on shipped customer machines, and an MCP tool is overkill for a
   status write. The prose procedure stays, demoted to `<supporting-info>`.

Ballpark: dedup + compression + script extraction takes the developer soul
from ~260 to ~130–150 lines with zero rules lost.

## 6. Regression net — changing scar tissue without reopening wounds

These prompts are load-bearing production code that accreted through
incidents. Refactor them like such code: put a net under current behaviour
first, then change one seam at a time.

1. **Rule inventory before any edit.** Extract every normative rule into a
   canonical list with stable IDs (`no-fake-success`, `explicit-failure`,
   `evidence-required`, `relative-paths`, `lifecycle-truthful`, …) and map
   every occurrence (file:line) to its ID. Deletion is allowed only when the
   rule ID is provably stated elsewhere in the same composed soul. The
   inventory is also where canonical wording is chosen (usually the most
   complete enumeration) and where §5's qualifier keep/cut calls live.
2. **Soul contract tests, green on the status quo first.** `render_soul()`
   is deterministic; extend `sprintengine-role-registry.test.ts` /
   `souls-service.test.ts` with a test that renders every role's soul and
   asserts each required rule ID is present. **Anchor on rule IDs (e.g.
   embedded comment anchors), not exact phrasing** — §5's canonicalization
   rewrites the words. Once green against today's souls, no refactor — or
   future architecture change — can silently drop a critical behaviour.
3. **Producers before reviewers, one role at a time.** Convert the
   `developer` soul first and leave all reviewer souls untouched: the
   unchanged reviewer rubrics are the safety net, surfacing any
   producer-side regression as gate findings before it reaches users.
   Reviewers convert last, so scoring weights are never in flux at the same
   time as producer prompts.
4. **Measure with what Sprint Engine already emits.** Gate findings per
   sprint (especially `real-integration`/`evidence` categories), reviewer
   rejection categories, and `items.json` lifecycle truthfulness are the
   observable proxies for the behaviours at risk. Run two or three
   comparable backlog items on old vs new developer souls and compare.
5. **One-line rollback.** Build `delivery_discipline` *alongside* the five
   micro-skills and switch roles via manifest edits; reverting a damaged
   role is a one-line manifest change, not a content restoration. Delete the
   deprecated micro-skill files only after every role has migrated and
   survived observation.

## 7. Honest caveats

- **Tags are not the whole fix.** The biggest dilution driver in the composed
  souls is volume plus redundancy — four skills restating the
  no-fake-success rule (§4). Tagging without the consolidation in §3.2 gets
  maybe half the benefit. Conversely, consolidation alone still leaves crucial
  rules visually equal to FNV-1a plumbing, so do both.
- **The enumerations are scar tissue.** Compress wording (§5) only where the
  full vocabulary survives once and is referenced; a stripped qualifier or a
  deleted list item may reopen the loophole that put it there. The rule
  inventory (§6.1) is the ledger that keeps every cut accountable.
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

## 8. Decided plan (2026-06-11)

Scope decided: tags + provenance envelopes, dedup/compression, and tests.
No MCP tool, no script extraction, no architecture changes.

**Phase 0 — safety net (do first, no behaviour change)**

1. Rule inventory: critical rules get stable IDs; every occurrence mapped
   (file:line). The §4 table is the starting point.
2. Soul contract tests: extend `sprintengine-role-registry.test.ts` to render
   every role's soul and assert each required rule ID is present (anchor on
   rule IDs, not phrasing). Green against current souls before any edit.

**Phase 1 — renderer (one small PR)**

3. `render_soul()` wraps each composed part in
   `<skill name="<skill_id>">…</skill>` (provenance + fixes heading
   collisions).
4. Three-line legend at the top of every rendered soul defining
   `<what-to-do>` (mandatory, overrides) vs `<supporting-info>` (reference).
5. `RegistryWarning` lint: skill missing `<what-to-do>` or block over ~10
   lines.

**Phase 2 — tag and trim the Soul skills (one PR per role group)**

6. Each SKILL.md gets `<what-to-do>` (≤10 lines) + `<supporting-info>`.
   In the same edit, apply §4/§5: delete duplicates covered by the inventory
   (`developer:11`, the shadowed slop-list bullets, `spec_reviewer:18`'s
   copied evidence list, relative-paths restatements), cut restated
   rationale and dead qualifiers, keep one canonical vocabulary in
   `production_reality_gate` with reviewers citing it.
7. Order: `developer` soul set first → run real sprints with reviewers
   unchanged (they are the net) → remaining producer roles → reviewer souls
   last. Contract tests gate every PR.

**Phase 3 — user-invocable skills**

8. Same tag-and-trim on the `/backlog` family; propagate to all synced
   harness copies in one change.

Expected outcome: souls roughly 40–50% smaller, every critical rule pinned
by a test, and every line in a rendered soul attributable to its source
skill.
