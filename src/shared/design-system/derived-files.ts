// Result shapes for design-system derived-file regeneration (main-process
// runner ↔ preload ↔ renderer). The runner forks each bundle's own generator
// scripts (the manifest `derived` map names them) so consuming repos and the
// app regenerate with one implementation — see
// knowledge/multicode/design-system-bundle.md.

/** One generator-script execution inside a bundle. */
export interface DerivedScriptRun {
  /** Bundle-relative script path, e.g. `scripts/build-tokens.mjs`. */
  script: string
  /**
   * `ok`: exited 0. `failed`: spawned but exited non-zero (or could not
   * spawn/timed out — see stderr). `missing`: listed in the manifest `derived`
   * map but not present in the bundle yet (authoring-time state, not an
   * error).
   */
  status: 'ok' | 'failed' | 'missing'
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Regeneration outcome for a single bundle directory. */
export interface BundleRegenResult {
  bundleDir: string
  /** False when the manifest is unreadable or any script run failed. */
  ok: boolean
  /** Human-readable failure summary when ok is false. */
  message?: string
  runs: DerivedScriptRun[]
}

/** Regeneration outcome for every design-system bundle found under a root. */
export interface DesignSystemRegenResult {
  /** False when any discovered bundle failed to regenerate. */
  ok: boolean
  /** Empty when the root contains no design-system bundle (a successful no-op). */
  bundles: BundleRegenResult[]
  /** Set when the request itself was invalid (e.g. empty root path). */
  message?: string
}
