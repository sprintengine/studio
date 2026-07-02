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
