// The degraded walkthrough model (T1). When a changeset is ingested but no guide
// has produced a brief.json — Claude Code absent, the run failed, or it was never
// started — the human review loop must still work end to end. This module
// synthesizes an in-memory ReviewBrief from the changeset alone so the walkthrough
// renders the full diff, read-toggles, comments, and post-to-PR without a guide.
//
// It is renderer-only and is NEVER written to disk: `brief.json` existing on disk
// always means a guide produced it (plan §3.5). The synthesized brief carries no
// annotations and no change map — the guide's judgment-free explanation chrome —
// only a deterministic grouping of the changed files so they can be read in order.
// The output passes `validateReviewBrief` + `checkBriefMatchesChangeSet`, so the
// pure walkthrough projection renders it exactly as it renders a real brief.

import type { ChangeSetFile, ReviewBrief, ReviewChangeSet, ReviewStep } from '../../../../shared/review'
import { BRIEF_SCHEMA_VERSION } from '../../../../shared/review'

// The placeholder why-line under every file card — honest, never invented insight.
const DEGRADED_WHY = 'Changed in this review'
// At or below this many files a single flat step reads better than folder groups.
const SINGLE_STEP_MAX_FILES = 8

// Path-sort comparator (byte order), the deterministic file/dir ordering used
// throughout so the same changeset always yields the same walkthrough.
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// The top-level directory a path lives under, or '' for a repository-root file.
function topLevelDir(path: string): string {
  const slash = path.indexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function stepFiles(files: ChangeSetFile[]): ReviewStep['files'] {
  return files.map((file) => ({ path: file.path, why: DEGRADED_WHY }))
}

// Group the (already path-sorted) files into reading steps. A small change is one
// "All files" step; a larger one splits into a step per top-level directory so the
// rail stays scannable. Every file lands in exactly one step (the double-assignment
// and coverage checks in `checkBriefMatchesChangeSet` depend on it).
function buildSteps(sortedFiles: ChangeSetFile[]): ReviewStep[] {
  if (sortedFiles.length <= SINGLE_STEP_MAX_FILES) {
    return [
      {
        id: 'degraded-all',
        order: 0,
        title: 'All files',
        narrative: 'Every file in this change, in path order. No guide has grouped or explained them yet.',
        files: stepFiles(sortedFiles),
        annotations: [],
      },
    ]
  }

  const groups = new Map<string, ChangeSetFile[]>()
  for (const file of sortedFiles) {
    const dir = topLevelDir(file.path)
    const bucket = groups.get(dir)
    if (bucket) bucket.push(file)
    else groups.set(dir, [file])
  }

  return [...groups.keys()].sort(byPath).map((dir, index) => ({
    id: `degraded-${index}`,
    order: index,
    title: dir === '' ? 'Repository root' : dir,
    narrative:
      dir === '' ? 'Files at the repository root.' : `Files changed under ${dir}, in path order.`,
    files: stepFiles(groups.get(dir) as ChangeSetFile[]),
    annotations: [],
  }))
}

// Synthesize the degraded (no-guide) walkthrough model for a changeset. Pure and
// deterministic; renderer-only; never persisted. The overview copy is honest about
// the missing guide rather than fabricating intent, and the blast-radius line is
// the changeset's own stats — no invented judgment anywhere.
export function synthesizeDegradedBrief(changeset: ReviewChangeSet): ReviewBrief {
  const sortedFiles = [...changeset.files].sort((a, b) => byPath(a.path, b.path))
  const steps = buildSteps(sortedFiles)
  const { files, additions, deletions } = changeset.stats

  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    changeSetId: changeset.id,
    headSha: changeset.headSha,
    // Deterministic and honest: the change's own fetch time, so a re-fetch never
    // reads as a fresher walkthrough. Kept purely in memory regardless.
    generatedAt: changeset.fetchedAt,
    overview: {
      intent:
        'No guide walkthrough has been prepared yet. These files are the raw change, grouped by folder so you can read them in order.',
      blastRadius: `${files} ${files === 1 ? 'file' : 'files'} changed, +${additions} −${deletions}.`,
      readingGuide:
        'Read each file below and comment as you go. Prepare a walkthrough to add guided ordering and the guide’s notes.',
      // No complexity (MC-1815). It is the guide's reading-effort judgment, and no
      // guide has judged this change. It used to be hardcoded 'low', which labelled
      // a 300-file degraded review "Complexity low" wherever the walkthrough's own
      // top bar renders. Deriving one from changeset size would be the same defect
      // with arithmetic: the degraded model's whole contract is that it invents no
      // judgment, and a size-derived complexity is a judgment.
    },
    steps,
    knowledgeRefs: [],
    coverage: {
      // Every file is assigned to a step, so nothing is uncovered and nothing is
      // double-assigned — the two invariants the cross-check enforces.
      assignedPaths: sortedFiles.map((file) => file.path),
      unassignedPaths: [],
    },
  }
}
