# Agent instructions — design system

A design system lives in this folder. When building or styling UI:

- Read `USAGE.md` for the consume-and-contribute contract.
- Style with the CSS custom properties in `foundations/tokens.css` — the
  `--sem-*` set. Do not hard-code colors, spacing, radii, or type values this
  system defines, and do not reference the internal `--ref-*` variables.
- Reuse components under `components/` before inventing new ones; each ships a
  `component.md` with usage and accessibility rules.
- Follow `foundations/principles.md` for anything the tokens don't decide.

Do not invent styles this system already defines.

`catalog/index.html` and `foundations/tokens.css` are GENERATED. Edit the
`component.md`, the component's own CSS or the token source and rebuild
(`node scripts/build-catalog.mjs`) — a hand-edit of a generated file reads as
correct in review and is reverted by the next build.

A `component.md` is prose that ships publicly: the naming rules in the root
`AGENTS.md` apply to it in full. No competitor product names, and no real
machine names, tailnet ids, emails or home paths in an example.
