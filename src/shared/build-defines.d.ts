// Compile-time constants substituted by the `define` block in
// `electron.vite.config.ts`. They exist only in a bundled build: under the test
// runner (plain Node, no Vite) the identifiers are simply undeclared, so every
// read must be guarded with `typeof` and fall back to a literal default.
// Declared as ambient globals here rather than inline so esbuild's define pass
// has no `declare const` of the same name to rewrite.

/** Build-time default for `MULTIAUTH_BASE_URL` (the account service). */
declare const __MULTIAUTH_BASE_URL__: string | undefined
