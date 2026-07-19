// Pure projections the walkthrough surface renders from the validated triple
// (ReviewChangeSet + ReviewBrief + ReviewWorkspaceState). No React, no IPC — the
// rail meter, step rings, footer, chips, and file why-lines all derive here so a
// fixture triple produces a deterministic surface and the derivations are
// unit-testable on their own.

import type {
  ReviewBrief,
  ReviewChangeSet,
  ReviewStep,
  ReviewWorkspaceState,
} from '../../../../../shared/review'

export const OVERVIEW_PANE_ID = 'overview'

export interface StepView {
  step: ReviewStep
  index: number // 1-based position among steps, for the ring label
  read: boolean // every file in the step is marked read
  fileCount: number
  noteCount: number
  metaLabel: string // "2 files · 2 notes" — the notes clause drops at zero
}

export interface RailModel {
  steps: StepView[]
  totalFiles: number // all changed files (the reading universe)
  readFiles: number
  progressLabel: string // "3 of 10 files read"
  meterFraction: number // 0..1 for the progress meter fill
  continueStepId: string | null // first step with an unread file, or null when done
  continueLabel: string | null // "Continue with step 2", or null when done
}

// Steps in reading order — sorted by the guide's `order`, stable on ties.
export function orderedSteps(brief: ReviewBrief): ReviewStep[] {
  return brief.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.order - b.step.order || a.index - b.index)
    .map((entry) => entry.step)
}

function stepMetaLabel(fileCount: number, noteCount: number): string {
  const files = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
  if (noteCount === 0) return files
  return `${files} · ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`
}

export function buildRailModel(
  changeset: ReviewChangeSet,
  brief: ReviewBrief,
  readFiles: ReadonlySet<string>,
): RailModel {
  const steps = orderedSteps(brief)
  const stepViews: StepView[] = steps.map((step, i) => {
    const fileCount = step.files.length
    const read = fileCount > 0 && step.files.every((file) => readFiles.has(file.path))
    return {
      step,
      index: i + 1,
      read,
      fileCount,
      noteCount: step.annotations.length,
      metaLabel: stepMetaLabel(fileCount, step.annotations.length),
    }
  })

  const totalFiles = changeset.files.length
  // Only count reads against files that actually changed, so a stale path in
  // readFiles can never push the meter past 100%.
  const changedPaths = new Set(changeset.files.map((file) => file.path))
  let readCount = 0
  for (const path of readFiles) if (changedPaths.has(path)) readCount += 1

  const continueStep = stepViews.find((view) => !view.read)

  return {
    steps: stepViews,
    totalFiles,
    readFiles: readCount,
    progressLabel: `${readCount} of ${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} read`,
    meterFraction: totalFiles === 0 ? 0 : Math.min(1, readCount / totalFiles),
    continueStepId: continueStep ? continueStep.step.id : null,
    continueLabel: continueStep ? `Continue with step ${continueStep.index}` : null,
  }
}

// The active pane id, resolved against what exists. Honors a persisted choice
// when it still points at the overview or a real step; otherwise opens on the
// first step, falling back to the overview for a brief with no steps.
export function resolveActivePaneId(brief: ReviewBrief, state: ReviewWorkspaceState | null): string {
  const steps = orderedSteps(brief)
  const stepIds = new Set(steps.map((step) => step.id))
  const persisted = state?.activeStepId
  if (persisted === OVERVIEW_PANE_ID || (persisted && stepIds.has(persisted))) return persisted
  return steps.length > 0 ? steps[0].id : OVERVIEW_PANE_ID
}

// Human source identity for the top bar (mono). Plain language only — never
// "changeset"/"branch ref" jargon. PR: "owner/repo #<n>"; branch: "head → base";
// patch: the label or "Pasted patch". A short head sha rides along when known.
export function sourceIdentity(changeset: ReviewChangeSet): string {
  const { source } = changeset
  let base: string
  if (source.kind === 'pull-request') {
    base = `${source.owner}/${source.repo} #${source.number}`
  } else if (source.kind === 'branch') {
    base = `${changeset.headRef ?? source.headRef} → ${changeset.baseRef}`
  } else {
    base = source.label ?? 'Pasted patch'
  }
  const sha = changeset.headSha ? changeset.headSha.slice(0, 7) : null
  return sha ? `${base} · ${sha}` : base
}

export interface StatsChip {
  files: number
  additions: number
  deletions: number
}

export function statsChip(changeset: ReviewChangeSet): StatsChip {
  return {
    files: changeset.stats.files,
    additions: changeset.stats.additions,
    deletions: changeset.stats.deletions,
  }
}

// The why-line under a file card path. The mechanical-skim reading note appends a
// standing reassurance so a reviewer knows the file is a safe skim.
export function fileWhyLine(why: string, readingNote?: 'read-closely' | 'mechanical-skim'): string {
  if (readingNote === 'mechanical-skim') return `${why} — mechanical mirror, safe to skim`
  return why
}
