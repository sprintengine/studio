// Result shape for running a bundle's own scripts/lint.mjs on demand
// (main-process runner ↔ preload ↔ renderer). The guided-brief studio runs it
// as its validating preview — `findings` is the lint report the UI renders
// inline; `error` means the lint could not run at all (missing script,
// misconfiguration), which reads differently to the user.
export type DesignSystemBundleLintRunResult =
  | { ok: true }
  | { ok: false; kind: 'findings'; findings: string }
  | { ok: false; kind: 'error'; message: string }
