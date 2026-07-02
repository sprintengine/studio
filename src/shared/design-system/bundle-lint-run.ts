// Result shape for running a bundle's own scripts/lint.mjs on demand
// (main-process runner ↔ preload ↔ renderer). The studio's "Save as design
// system" action runs this as its validating phase before calling release —
// `findings` is the lint report the UI renders inline; `error` means the lint
// could not run at all (missing script, misconfiguration), which blocks the
// release just as hard but reads differently to the user.
export type DesignSystemBundleLintRunResult =
  | { ok: true }
  | { ok: false; kind: 'findings'; findings: string }
  | { ok: false; kind: 'error'; message: string }
