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
- Never hard-code a color. Every color comes from a `--sem-*` variable; each
  token's meaning (`role`, `use`, `doNotUse`) is documented in
  `foundations/tokens.tokens.json`, so pick by meaning, not by looks.
- Dark mode: set `data-mode="dark"` on the document element or any container.
  Light is the default (`:root`). Never write per-mode style overrides —
  consume the semantic variables and both modes come for free.
- Reuse components from `components/` before building new ones. Read each
  component's `component.md` (anatomy, variants, states, usage, accessibility)
  before use. `catalog/index.html` shows everything the system offers.
- Read `foundations/principles.md` before designing anything the system does
  not already cover.
- Do not invent styles this system already defines.

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
   untokenized color values in `components/` and `patterns/`, on any
   `var(--ref-*)` use outside the token file, and on tokens missing the
   semantic metadata above. For a legitimately un-tokenizable component value,
   add a `ds-lint-allow: <reason>` comment on the same line or one of the two
   lines above it — the reason is mandatory, and token metadata has no such
   escape hatch.

## Derived files — never hand-edit

`foundations/tokens.css` and `catalog/index.html` are generated; the `derived`
map in `design-system.json` names each file's generator under `scripts/`.
Hand edits there are lost on the next regeneration — change the source
(`tokens.tokens.json`, `components/`) and rerun the named script instead.
