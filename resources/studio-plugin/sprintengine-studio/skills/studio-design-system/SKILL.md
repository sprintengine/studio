---
name: studio-design-system
description: Create, maintain and enforce a project's design system through SprintEngine Studio's Design door - the bundle format, the project lint that makes it stick, and the before/after page that proves a change. Use when a project has or wants a design system, or when UI changes against one.
---

# The Design System feature

A design system is **a folder in the project** — any name, versioned in the
project's own repo — built to the bundle format below and registered in the
Studio's **Design door**, which points at it and reads it live, never writing
there. The door renders it, previews components in light and dark, and runs the
bundle's own lint; agents read it before building UI, as its `AGENTS.md` tells
any that never opened this skill.

Two specifications meet in the folder:

- **The SprintEngine Studio design-system bundle format, schemaVersion 1** — the
  manifest `design-system.json` (`name`, semver `version`, `modes`,
  `namingGrammar`, `contents`, `derived`, `provenance`) over `foundations/`, one
  kebab-case folder per component, `patterns/`, `glyphs/`, `assets/`, and the
  derived `foundations/tokens.css` and `catalog/index.html`.
- **The Design Tokens Format Module** of the W3C Design Tokens Community Group
  — the shape of `foundations/tokens.tokens.json`: nested groups, a `$type` and
  `$value` per token, and `{dotted.path}` aliases between them.

**The bundle's own `USAGE.md` is the normative text** for both — consume rules,
contribution gate, naming grammar, derived files. Read it first; this skill does
not restate it.

## Create one

**New design system** in the Design door, then point at a folder. That stamps
the templates verbatim — `USAGE.md`, `AGENTS.md`, and `scripts/build-tokens.mjs`,
`build-catalog.mjs`, `lint.mjs` — plus empty content directories and a manifest
at `0.1.0`. It never overwrites an existing bundle and seeds **no** sample
content: tokens, principles and components are authored work. Then, in order:

1. `foundations/principles.md` — what tokens cannot decide: the accent rule,
   what structure is made of, the ceilings on type sizes and radii per view, a
   Don't list. Write it before the components; it settles the later arguments.
2. `foundations/tokens.tokens.json` — a `ref` tier (raw scale) and a `sem` tier
   (meaning) aliasing it. Every token carries `$type` and `$description`; every
   `sem.*` one also `$extensions["com.sprintengine"]` with `role` and `use`. A
   token whose value differs by mode declares `modes: { light, dark }`, so both
   modes ship from one source and no component CSS writes a per-mode override.
3. The first components — each the trio below, tokens only.
4. `node scripts/build-tokens.mjs && node scripts/build-catalog.mjs`, then
   `node scripts/lint.mjs` — the contribution gate; it must exit 0.
5. Register the folder in the door if the scaffold did not; commit the bundle
   with the project.

### Deriving one from a product that already exists

Handed screenshots, source, or both, an agent proposes the system rather than
inventing it. **From source**, harvest the tokens already implicit in it:
colour literals, font sizes and weights, spacing and radius values, shadows,
z-indices. Collect every occurrence, cluster near-duplicates into ramps, name
them in the manifest's `namingGrammar`, write them out in the Design Tokens
Format Module shape, then map each recurring element to a component spec with
the states the code sets.

**From screenshots**, sample and cluster the colours, and measure type and
spacing against a known reference in the image — a control height, a font size
you can pin down — to derive the ramps. Repeated elements are the components,
their visible states the ones you can see. What a still cannot show — focus
rings, hover, dark mode — is a gap recorded in `principles.md`, never invented.

**With both**, source is the truth for values and screenshots settle hierarchy
and what actually ships. Either way the first pass is a proposal: regenerate the
catalog, read it beside the screenshots, and review before any value is canon.

## Maintain it

**A component** is a kebab-case directory of exactly three files: `component.md`
(Anatomy / Variants / States / Usage / Accessibility), `component.css` (the real
source, consuming only `--sem-*` properties — never `var(--ref-*)`, the lint
refuses it), and `component.html` (a live demo). Adding or changing one means
the trio, the name in `contents.components`, a regenerated catalog and a clean
lint. **The demo** shows both modes (`data-mode="dark"` on a container) and
every state the spec names — hover, `:focus-visible`, disabled, each variant
modifier; one state proves the component exists, not that it works.

**Tokens change in `tokens.tokens.json` only.** Reuse before adding: a token with
the right meaning is the right token even when its value is not your first
aesthetic choice. A missing value is a missing step in the scale — add it with
semantics and regenerate, never a local pixel or hex; the one escape hatch is a
`ds-lint-allow: <reason>` on an un-tokenizable component value.
**Derived files are never hand-edited**; the manifest's `derived` map names each
one's generator, and you run it **twice and diff** — a second run that changes
the output means the generator reads something unordered, and every future diff
is noise.

**`principles.md` records rulings, dated.** When a question is settled — one
accent per view, no second radius, a shape rejected on sight — the ruling goes in
with the date. An undated rule cannot be told from an opinion, and gets relitigated.

## Enforce it in the project

A system nobody is forced to use decays into suggestions. Once it covers a real
surface, add a lint rule **to the project** — not the bundle, whose lint governs
only its own sources — failing the build when product code goes around it:

- **Tokens only.** Over the project's UI sources, reject hex literals, raw
  colour functions, and hard-coded values for anything the system tokenises
  (spacing, radii, control heights, type steps, z-index, durations). Grep with
  an ignore list starts it; under Tailwind, ban arbitrary values instead.
- **No raw primitives.** Reject a raw `<button>`, `<input>`, `<textarea>` — and
  whatever else the system ships — in product code, against a **per-area
  baseline file** of pre-existing counts. It only ever drains: over the number
  fails, and **under** it fails too, naming the smaller number to write, or a
  lowered count becomes parking space for the next regression. An area absent
  from the file fails on its first raw element — a new surface is the strictest
  place in the tree.
- **Wire it into the project's lint and CI**, so it blocks a merge.
- **Add a probe**: a script that injects the exact defect the rule exists to
  catch and fails if the rule stays quiet. A passing lint proves the rule found
  nothing; only a probe proves it would find something.

The studio's own `scripts/lint-primitive-duplication.mjs` (rule (h)
`no-raw-primitive` with its per-area baseline) and
`scripts/testing/design-system-guard-probes.mjs` are that pair worked out; the
studio's own design system is built this way — see it for an example.

## Prove a change

A diff does not show a person what changed, and a screenshot shows one theme,
one state, one moment. The artefact is a **rendered before/after page**: each
specimen is real markup — as it stood, and as the system renders it — painted
by the project's own built stylesheet, on a checker ground, LIGHT and DARK side
by side at 1x and 2x, with a state strip pairing A (before) and B (after) under
each band. Then **"Left alone, and why"**, each control kept raw shown once as it
stands, under the reason; then **"Waiting on a kit variant"**, pairing each
control the system cannot yet express with the nearest component forced onto it;
then a footer of counts and one collapsible site list, the only place a file
path appears. Almost no prose, no code blocks: the specimens are the content.

The sweep writes one JSON array of
`{file, line, element, status, before, after, kit, note}`, where `status` is
`swapped` (an existing component, variant and size reproduce it exactly), `kept`
(raw for a reason that is not debt — say which) or `needs-variant` (the system
has no such shape; `kit` names the variant that would cover it). A record to be
drawn adds `specimen: {id, name, eyebrow, ground, states, wrap, near, want}`,
`ground` being the token the control really sits on. Two optional fields shape
the page: `lane`, the pass of the sweep the row came from, counted beside the
statuses in the masthead, and `kitMember`, the component drawing the site now,
which groups the swapped bands under it. `before` comes from
`git show <sha>^:<file>`, never retyped.

`scripts/render-swap-report.mjs` builds the page from those records plus a `.tsx`
module exporting `SPECIMENS: Record<string, ReactNode>` (keys
`<id>-before-<state>` / `<id>-after-<state>` for a swap, `<id>-raw` alone for a
`kept` record, `<id>-raw` / `<id>-forced` for a `needs-variant` one):

```
node <skill>/scripts/render-swap-report.mjs \
  --repo /path/to/project --out report.html --sites sweep.json \
  --css dist/assets/index-a1b2c3.css \
  --tokens design/foundations/tokens.css --tokens src/styles/app.css \
  --specimens ./specimens.tsx --alias @app=src --sha $(git rev-parse --short HEAD)
```

`--css` (required) is the project's built stylesheet, so build first. `--tokens`
repeats in cascade order and rebuilds both grounds as classes out of the real
`:root` blocks — a bare `:root` feeds both, a `dark`-qualified selector the dark
one, and a rule qualified by any other attribute value (a named palette, a window
material) neither — because an attribute-driven theme selects nothing on an inner
wrapper, and a mode the report is not in contaminates both grounds.
`--specimens` and `--alias` are the module and its import prefixes; `--repo` is
the project root the sources and `node_modules` come from. Output is an
artifact-ready fragment, non-zero on a missing specimen id, an empty ground or a
code block. Publish it with the Artifact tool.

Any React project with esbuild works as-is. **When it is not React**, render the
markup another way — the framework's own server-side render, or the component's
`component.html` beside the before markup — and assemble the same page: the
format is the deliverable, the script one way to reach it.

## Checklist

- [ ] Every control came from the system; anything new went into it.
- [ ] Spec trio complete; the demo shows both modes and every state.
- [ ] No hard-coded value the tokens cover; new tokens carry full semantics.
- [ ] Registered in `design-system.json`; derived files regenerated, byte-stable.
- [ ] The bundle's `node scripts/lint.mjs` exits 0.
- [ ] The project's rule enforces it in CI, and a probe proves the rule bites.
- [ ] Any baseline moved only downward, with a dated note.
- [ ] The before/after page renders, exits 0, counts matching the records.
