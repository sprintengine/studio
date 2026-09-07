# SDK findings

Gaps and pattern decisions surfaced while extracting features onto the module
SDK, recorded here so later (bigger) extractions inherit answers instead of
rediscovering questions. Paths are project-root-relative.

## Design-system conformance for extracted modules (MC-1861)

`scripts/lint-design-system-conformance.mjs` runs at zero tolerance over
`src/renderer/src`. When a module's UI leaves that tree (out-of-tree
extraction), the guard silently checks a smaller tree and stays green — the
extracted UI is simply out of scope, which reads as "covered" when it isn't.

**Recommendation (pinned): the sibling module repo runs
`scripts/lint-design-system-conformance.mjs` against its own source
post-extraction.** The script is self-contained enough to ship with the SDK
toolchain when MC-1888 stands the sibling repo up; the module repo wires it
into its own verify script over its `src/` tree at the same zero tolerance.
No exemption path: an extracted first-party module keeps the same conformance
bar it had in-tree, enforced where its source now lives.

Phase 1 (MC-1861) keeps the voice UI inside `src/renderer/src`
(`src/renderer/src/modules/voice-dictation/`), so the guard's coverage is
unchanged this run; the recommendation binds MC-1888 and every later
extraction (Switchboard MC-1530, Review, Sprint Engine).
