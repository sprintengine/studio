import { DESIGN_SYSTEM_VERSION_PATTERN } from '../../../../../shared/design-system/manifest'
import type { DesignSystemBundleLintRunResult } from '../../../../../shared/design-system/bundle-lint-run'
import type { DesignSystemReleaseResult } from '../../../../../shared/design-system/library'
import type { DesignSystemStudioRelease } from '../../../types/workspace'

// Pure state model for the design-system studio's "Save as design system"
// completion action. The UI orchestrates two real IPC calls — the bundle lint
// (validating) and then the T6 release pipeline (releasing) — and every phase
// below maps onto an observed result, never a timer or a guess. The release
// pipeline re-runs the lint as its own gate, so the validating pass is a
// preview for fast, findings-first feedback, not a bypass.

export type DesignSystemReleasePhase =
  | { kind: 'idle' }
  | { kind: 'validating' }
  | { kind: 'releasing' }
  | { kind: 'released'; release: DesignSystemStudioRelease }
  | { kind: 'lint-failed'; findings: string }
  | { kind: 'error'; message: string }

export function isReleaseInFlight(phase: DesignSystemReleasePhase): boolean {
  return phase.kind === 'validating' || phase.kind === 'releasing'
}

export function isValidReleaseVersion(version: string): boolean {
  return DESIGN_SYSTEM_VERSION_PATTERN.test(version.trim())
}

/**
 * First release defaults to 1.0.0; after a release the input prefills the
 * last released version for the user to bump — no auto-bump logic (T6 note).
 */
export function initialReleaseVersion(lastRelease: DesignSystemStudioRelease | null): string {
  return lastRelease?.version ?? '1.0.0'
}

/** The action is armed only on a ready designer, a valid version, and no in-flight call. */
export function canRelease(input: {
  phase: DesignSystemReleasePhase
  designerReady: boolean
  version: string
}): boolean {
  return (
    input.designerReady && !isReleaseInFlight(input.phase) && isValidReleaseVersion(input.version)
  )
}

export function releasePhaseAfterLint(result: DesignSystemBundleLintRunResult): DesignSystemReleasePhase {
  if (result.ok) return { kind: 'releasing' }
  if (result.kind === 'findings') return { kind: 'lint-failed', findings: result.findings }
  return { kind: 'error', message: result.message }
}

export function releasePhaseAfterRelease(result: DesignSystemReleaseResult): DesignSystemReleasePhase {
  if (result.ok) {
    return {
      kind: 'released',
      release: {
        name: result.name,
        version: result.version,
        path: result.path,
        releasedAt: result.releasedAt,
      },
    }
  }
  // The designer can edit the bundle between the validating pass and the
  // release's own lint gate; a stage-'lint' failure is still lint-failed, with
  // the pipeline's findings when it carried them.
  if (result.stage === 'lint' && result.lintFindings) {
    return { kind: 'lint-failed', findings: result.lintFindings }
  }
  return { kind: 'error', message: result.message }
}

/** Footer status line per phase; null phases render no status. */
export function releaseStatusLine(phase: DesignSystemReleasePhase): string | null {
  switch (phase.kind) {
    case 'idle':
      return null
    case 'validating':
      return 'Running the bundle lint…'
    case 'releasing':
      return 'Copying the release into your library…'
    case 'released':
      return `Released ${phase.release.name}@${phase.release.version} to ${phase.release.path}. Bump the version to release again.`
    case 'lint-failed':
      return 'The lint found violations — iterate with the designer, then retry.'
    case 'error':
      return phase.message
  }
}

export function releaseButtonLabel(phase: DesignSystemReleasePhase): string {
  switch (phase.kind) {
    case 'validating':
      return 'Validating…'
    case 'releasing':
      return 'Releasing…'
    case 'lint-failed':
    case 'error':
      return 'Retry release'
    case 'idle':
    case 'released':
      return 'Save as design system'
  }
}
