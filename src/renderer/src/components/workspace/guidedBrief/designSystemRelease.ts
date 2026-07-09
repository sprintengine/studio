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
    case 'error':
      return 'Retry release'
    case 'idle':
    case 'released':
    case 'lint-failed':
      return 'Save as design system'
  }
}

// --- Release card presentation (MC-1505 §4) ---------------------------------
// The card renders the lint report as rows and routes a failure to the
// designer as one message; these are the pure pieces of that presentation.

/** One row of the bundle lint report (the bundle's own scripts/lint.mjs). */
export type DesignSystemLintIssue = {
  /** Bundle-relative file the finding block was reported under. */
  file: string
  /** The report's own row text, e.g. "12:5  no-raw-hex  #30d058". */ // design-tokens-allow: doc example of a bundle lint-report row, not a rendered color
  detail: string
}

export type ParsedLintFindings = {
  /** From the report's own "Total violations: N" summary line; null when absent. */
  totalViolations: number | null
  issues: DesignSystemLintIssue[]
}

/**
 * Parse the lint report for row-level display. The report groups indented
 * finding rows under non-indented file-path lines and ends with a summary
 * block; everything from the summary heading on is dropped. An unrecognized
 * shape parses to zero issues — the card then shows the raw report verbatim,
 * never an invented row.
 */
export function parseLintFindings(findings: string): ParsedLintFindings {
  const totalMatch = /^Total violations: (\d+)$/m.exec(findings)
  const issues: DesignSystemLintIssue[] = []
  let currentFile: string | null = null
  for (const line of findings.split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.trim() === 'Design-system lint summary') break
    if (/^\s/.test(line)) {
      if (currentFile) issues.push({ file: currentFile, detail: line.trim() })
      continue
    }
    currentFile = line.trim()
  }
  return { totalViolations: totalMatch ? Number(totalMatch[1]) : null, issues }
}

/** Lint chip label for the blocked card, counted from the report itself. */
export function lintIssueCountLabel(parsed: ParsedLintFindings): string {
  const count = parsed.totalViolations ?? parsed.issues.length
  if (count === 1) return '1 lint issue'
  if (count > 1) return `${count} lint issues`
  return 'Lint failed'
}

/**
 * The one message the blocked card sends to the designer (the user never
 * hand-fixes bundle files). The conversation transport carries the full
 * report inline; terminal (PTY) stdin submits on every newline, so that
 * transport gets a single-line instruction to re-run the bundle's own lint.
 */
export function lintFixRequestMessage(findings: string, transport: 'conversation' | 'terminal'): string {
  const intro =
    'The design-system bundle failed its release lint. Fix every finding in the bundle files, then confirm scripts/lint.mjs passes.'
  if (transport === 'terminal') return intro
  return `${intro}\n\nLint report:\n${findings.trim()}`
}

/** Display root of the user-global library (real layout: releases are copied under it). */
export const DESIGN_SYSTEM_LIBRARY_DISPLAY_ROOT = '~/.multicode/design-systems'

/**
 * Pre-release destination line: the canonical library layout with the real
 * manifest name and the entered version. Null when the name is unknown — the
 * card omits the line rather than invent a path.
 */
export function releaseDestinationDisplay(bundleName: string | null, version: string): string | null {
  if (!bundleName) return null
  const trimmed = version.trim()
  const segment = DESIGN_SYSTEM_VERSION_PATTERN.test(trimmed) ? trimmed : '<version>'
  return `${DESIGN_SYSTEM_LIBRARY_DISPLAY_ROOT}/${bundleName}/${segment}`
}

/** Abbreviate a released copy's absolute path to the ~ display form. */
export function displayLibraryPath(absolutePath: string): string {
  const marker = '/.multicode/design-systems/'
  const index = absolutePath.indexOf(marker)
  if (index === -1) return absolutePath
  return `~${marker}${absolutePath.slice(index + marker.length)}`
}
