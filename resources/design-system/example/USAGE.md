# Using this design system

> Placeholder contract. The full consume-and-contribute governance contract
> (with the bundle lint) replaces this file; the section shape below is stable.

## Consume

- Load `foundations/tokens.css` and style only with the `--sem-*` custom
  properties. The `--ref-*` variables are internal plumbing for the token file
  itself — component and pattern CSS never references them.
- Dark mode: set `data-mode="dark"` on the document element or any container.
  Light is the default (`:root`).
- Reuse components from `components/` before building new ones. Read each
  component's `component.md` (anatomy, variants, states, usage, accessibility)
  before use.
- Read `foundations/principles.md` before designing anything the system does
  not already cover.

## Contribute

- New component: add `components/<kebab-name>/component.html`, `component.css`,
  and `component.md`, following `components/button/` as the template. Consume
  only `--sem-*` variables.
- New or changed tokens: edit `foundations/tokens.tokens.json` only. Every
  meaningful token carries `$description` and `com.multicode` semantics
  (`role`, `use`, and where relevant `doNotUse` / `components`).
- Never hand-edit derived files. `foundations/tokens.css` and
  `catalog/index.html` are generated — the `derived` map in
  `design-system.json` names each file's generator under `scripts/`.
