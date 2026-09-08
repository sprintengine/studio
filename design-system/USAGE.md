# Using this design system

This folder is a self-contained design system. This file is its contract: how
to consume the system when building UI, and how to contribute new pieces back
without forking its language. It assumes nothing about your tooling — any
agent or human with Node.js can follow it. `design-system.json` is the
manifest (name, version, naming grammar, contents, and which files are
generated).

## Commands

Run from this folder (each script also resolves the bundle from its own
location, so an absolute or repo-relative invocation works too):

```
node scripts/lint.mjs           # contribution gate — must exit 0 before you are done
node scripts/build-tokens.mjs   # regenerate foundations/tokens.css after token edits
node scripts/build-catalog.mjs  # regenerate catalog/index.html after component/pattern edits
```

## Consume

- Load `foundations/tokens.css` and style only with the `--sem-*` custom
  properties. The `--ref-*` variables are internal plumbing for the token file
  itself — component and pattern CSS never references them (the lint enforces
  this).
- Never hard-code a color, a space, a control height, a radius, a duration, or
  a z-index. Every one comes from a `--sem-*` variable; each token's meaning
  (`role`, `use`, `doNotUse`) is documented in
  `foundations/tokens.tokens.json`, so pick by meaning, not by looks.
- Spacing is `--sem-space-*` on every padding, margin, and gap. A value the
  scale does not have is a missing step: add it to the token source rather
  than writing a local pixel value.
- The system ships **two font families, permanently** — `--sem-font-family-ui`
  and `--sem-font-family-mono`. There is no third family and no serif; adding
  one is a system change, not a styling choice.
- Dark mode: set `data-mode="dark"` on the document element or any container.
  Light is the default (`:root`). Never write per-mode style overrides —
  consume the semantic variables and both modes come for free.
- Reuse components from `components/` before building new ones. Read each
  component's `component.md` (anatomy, variants, states, usage, accessibility)
  before use. `catalog/index.html` shows everything the system offers.
- Read `foundations/principles.md` before designing anything the system does
  not already cover.
- Do not invent styles this system already defines.

### A new UI element goes into the system first

In the consuming app this is not advice, it is the build. `npm run lint`
fails on a raw `<button>`, `<input>` or `<textarea>` written in product code
(`scripts/lint-primitive-duplication.mjs`, rule `no-raw-primitive`). Each of
those tags already has a component here — `components/button/`,
`components/input/`, `components/field/`, and `components/checkbox/` /
`components/switch/` for the two input shapes that are their own control — and
a primitive that implements it in `src/renderer/src/components/ui/`. Writing
the bare element instead is how a focus ring, a control height, a disabled
tone and a radius get decided one more time, privately.

So the order is:

1. **Use the primitive** the kit already exports (`ui/Buttons`, `ui/Input`,
   `ui/Textarea`, `ui/Checkbox`, `ui/Switch`, `ui/Select`, …).
2. If it does not do what you need, **change it** — add the variant or state to
   the component spec under `components/<name>/` and to the primitive under
   `src/renderer/src/components/ui/`, so the next surface inherits it.
3. If the thing genuinely does not exist yet, **add it to the system**: a new
   directory under `components/<name>/` following the per-component template in
   *Contribute* below, plus the primitive under
   `src/renderer/src/components/ui/` that consumes it.

There is no fourth option. The rule has **no per-line marker and no allow-list
entry to add**: the only tolerance is a per-area count in
`scripts/design-system-conformance/raw-primitives.json`, holding the raw
elements that predate the rule, and that file only ever gets smaller — its
`--update-baseline` refuses to run when any area grew, and an area *under* its
number fails too, so nothing that drains leaves headroom behind for the next
regression. An area that is not in the file fails on its first raw element,
which is what makes a brand-new surface the strictest place in the tree rather
than the loosest.

The same discipline governs the other gates' exemptions. Every per-file
exemption in `scripts/lint-design-tokens.mjs` carries a measured `max`; the
occurrence past it is an ordinary violation, and a `max` left above what the
file actually spends is itself a violation. A file-level exemption with no
number would admit not just what it was written for but everything that file
ever gains afterwards, which is not an exception — it is an unmonitored region.

## Adapt to your framework

Components here are framework-neutral **reference implementations**
(`component.html` + `component.css`), not drop-in widgets. When your project
uses a component framework (React, Vue, Svelte, …), rebuild each component
idiomatically in that stack — never paste the raw HTML into a component tree.
Preserve, exactly:

- the tokens it consumes (same `--sem-*` variables),
- its anatomy (the parts and their structure from `component.md`),
- its states (hover, focus-visible, disabled, and any variant modifiers),
- its accessibility behavior (roles, labels, focus order, keyboard handling).

**Tailwind:** map the token variables into your Tailwind config instead of
restating their values — e.g.
`colors: { 'accent-primary': 'var(--sem-color-accent-primary)' }` — and keep
`foundations/tokens.css` loaded so light/dark modes keep working. Utilities
then stay token-backed (`bg-accent-primary`), and arbitrary values like
`bg-[#2f6a4a]` stay banned.

## Contribute

The contribution gate is free append + mandatory lint: no review or approval
step, but `node scripts/lint.mjs` must exit 0 before your contribution is
done.

1. **Reuse existing tokens — never invent parallel ones.** Check
   `foundations/tokens.tokens.json` first; if a token with the right meaning
   exists, use it even when its value is not your first aesthetic choice.
2. **Add a token only with full semantic metadata.** Edit
   `foundations/tokens.tokens.json` only (never the derived CSS). Every token
   carries an explicit `$type` and a `$description`; every `sem.*` token also
   carries `$extensions["com.multicode"]` with `role` and `use` (plus
   `doNotUse` / `components` where relevant). A token whose value differs by
   mode declares `modes: { light, dark }` there, with `$value` equal to the
   light value. Then regenerate: `node scripts/build-tokens.mjs`.
3. **Follow the per-component template.** A component is a kebab-case
   directory under `components/` with exactly `component.html` (a live demo
   exercising both modes), `component.css` (the real source, consuming only
   `--sem-*` variables), and `component.md` (sections: Anatomy / Variants /
   States / Usage / Accessibility). `components/button/` is the reference.
4. **Register it.** Add the directory name to `contents.components` in
   `design-system.json`, then regenerate the catalog:
   `node scripts/build-catalog.mjs`.
5. **Honor the naming grammar** declared in `design-system.json` under
   `namingGrammar` — it defines token paths, CSS variable names, component
   directory names, and glyph names. Do not introduce a second dialect.
6. **Run the lint**: `node scripts/lint.mjs`. It fails on raw hex or other
   untokenized color values in `components/` and `patterns/`, on raw
   px/rem/em spacing on `padding`/`margin`/`gap`, on a `font-family` that is
   not one of the two family tokens, on any `var(--ref-*)` use outside the
   token file, and on tokens missing the semantic metadata above. For a legitimately un-tokenizable component value,
   add a `ds-lint-allow: <reason>` comment on the same line or one of the two
   lines above it — the reason is mandatory, and token metadata has no such
   escape hatch.

## What this system deliberately does not contain

Ruled 2026-08-05 (MC-2118). The consuming app exports a handful of primitives
from its kit that have **no entry here, on purpose**:

`CliModelPickerButton`, `CliModelPopoverSurface`, `ReasoningSelector`,
`CliProviderStateLine`, `InlineSkillPicker`, `SkillPickerPopover`,
`FilePreviewPane`, `HtmlPreviewCard`.

*(`SkillPickerPopover` joined the list on 2026-09-08. It is the popover-hosted
twin of `InlineSkillPicker` — same inventory, same install-on-pick behaviour,
same domain — and the ruling above always covered it; the list simply named
one of the module's two exports.)*

Each encodes a **product** decision rather than a reusable pattern — which
agent CLIs exist and how their models are grouped, what a reasoning axis means,
how a skill installs, which file types get a preview. A design system that
absorbed them would be shipping one product's domain model as though it were
design vocabulary, and every future consumer would inherit choices that are not
theirs to make.

They are still held to the system: they consume the same tokens and are policed
by the same conformance gates. What they do not get is a spec here, because
there is nothing framework-neutral to specify.

The general shapes underneath them **are** documented, and that is where a
rebuild should start: [popover](components/popover/component.md) for the
anchored surface, [menu](components/menu/component.md) for the action list,
[select](components/select/component.md) for one value out of a closed list,
and [provider-row](components/provider-row/component.md) for the
connected-service row.

Every other export from the app's `ui/index.ts` resolves to an entry here — as
a component, a pattern, a glyph, or a named part of one (`CloseIconButton` under
button, `TabPanel` under tabs, the `Menu*` vocabulary under menu, and so on).

### Primitives that live outside the barrel

`ui/index.ts` is not the whole kit. A handful of files under
`src/renderer/src/components/ui/` are imported directly — because a caller must
stay clear of the kit's component graph (`DefaultChip`), because the file is a
document-scoped singleton (`ToastRegion`), or simply because the export was
never added. The clause above only ever covered the barrel, so those files went
unspecified by construction rather than by ruling. Closed 2026-09-08:

| Primitive | Entry |
|---|---|
| `CommandPalette` | [command-palette](components/command-palette/component.md) |
| `WorkspacePanel` | [workspace-panel](components/workspace-panel/component.md) |
| `DefaultChip` (over `MicroChip`) | [micro-chip](components/micro-chip/component.md) |
| `ExtensionIcon` | [extension-icon](components/extension-icon/component.md) |
| `ToastRegion` | [toast](components/toast/component.md), under Usage |
| `CursorErrorPopover` | [popover](components/popover/component.md), the `--cursor-error` variant |
| `TerminalReplaySkeleton` | [skeleton](components/skeleton/component.md) |
| `LoadingOverlay` | [spinner](components/spinner/component.md) |
| `CapabilityGlyphs` | [glyphs](components/glyphs/component.md) |

**Two files are non-visual plumbing and get no entry, which is not the same as
being undocumented.** `FocusTrap` renders two `sr-only` sentinels and nothing
else — it is the *mechanism* behind the modal spec's focus-trap clause, and it
is named there. `SuspenseFallback` renders `LoadingOverlay` inside a fade
delay; the spinner entry owns the mark, and the delay is a chunk-loading
detail, not a design decision. Specifying either would be specifying an
implementation, and this system specifies surfaces.

## Proving the gates still bite

A lint that passes proves the guard found nothing. It does not prove the guard
would find anything. `scripts/testing/design-system-guard-probes.mjs` proves the
second thing: it builds an isolated copy of the tree, feeds the guards defects
they are trusted to catch — one at a time, reverting between — and fails if a
guard stays quiet. It runs as the last step of `npm run lint`, so the guards are
re-proved on every run rather than the day someone remembers to check.

Widening a rule means running the probes; a probe that no longer proves anything
is a rule that quietly stopped being enforced. One had already gone stale that
way: `sem.radius.pill` was added to the token file after the probe was written,
and being the last key it silently became the one the probe mutated — a token
the guard deliberately never reads, so the probe was pushing on nothing and
reporting the guard as broken.

## Derived files — never hand-edit

`foundations/tokens.css` and `catalog/index.html` are generated; the `derived`
map in `design-system.json` names each file's generator under `scripts/`.
Hand edits there are lost on the next regeneration — change the source
(`tokens.tokens.json`, `components/`) and rerun the named script instead.
