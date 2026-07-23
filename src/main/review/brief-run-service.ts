// The review brief on disk, and the channel that announces it (MC-1679).
//
// The brief (`brief.json`) is the walkthrough a guide produced for a review:
// steps ordered for understanding, a per-file why, narration, and annotations.
// The guide explains and organizes; it never judges, so nothing here produces
// verdicts — the annotation-kind enum in `validateReviewBrief` is the firewall.
//
// This module used to run the guide as well, on the companion/conversation
// surface. That producer is gone (MC-1783): the guide is an ordinary terminal
// agent (`guide-terminal-service.ts`) that delivers through the Studio gateway's
// `review_submit_brief`, and both writers land the brief through the atomic
// writer here. What remains is the artifact and its vocabulary — the read, the
// write, the run-event channel, and the phase names — which no transport owns.
// Node/Electron-main only; the renderer reaches it through review IPC.

import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { validateReviewBrief, type ReviewBrief } from '../../shared/review'
import type { GuideRunPhase } from './guide-run-registry'

// The IPC channel the review module forwards BriefRunEvent over. Exported so the
// host wiring and the renderer bridge name it from one place.
export const BRIEF_RUN_EVENT_CHANNEL = 'review:brief-run-event'

const BRIEF_FILE = 'brief.json'

// Honest run progress the panel renders. `reading` is the guide starting up on
// the change set; `grouping` is it working; `annotating` and `writing` are the
// produced brief being validated and persisted; `done`/`failed` are terminal. A
// generating turn is opaque, so these are coarse milestones, never inferred
// sub-steps. Owned by the guide-run registry so the live event stream and the
// polled run status speak one vocabulary.
export type BriefRunPhase = GuideRunPhase

export interface BriefRunEvent {
  workspaceId: string
  phase: BriefRunPhase
  detail?: string
}

// Read the walkthrough currently on disk. Any problem (missing file, bad JSON,
// invalid shape) returns null so a caller falls back to a full run — a re-run or a
// plain read never fails just because the old brief is unusable. Shared with the
// review MCP tools (review_get_brief) so both readers agree on "no usable brief".
export async function readBriefFromDir(targetDir: string): Promise<ReviewBrief | null> {
  let raw: string
  try {
    raw = await readFile(join(targetDir, BRIEF_FILE), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = validateReviewBrief(JSON.parse(raw))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

// Write-temp-then-rename, mirroring the changeset service: a crash mid-write
// leaves the prior brief.json (or nothing) intact rather than a truncated file.
// Exported so the review MCP tools (review_submit_brief) land the brief through
// one atomic writer.
export async function writeBriefAtomic(targetDir: string, brief: ReviewBrief): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  const finalPath = join(targetDir, BRIEF_FILE)
  const tempPath = join(targetDir, `.${BRIEF_FILE}.${randomUUID()}.tmp`)
  const data = `${JSON.stringify(brief, null, 2)}\n`
  try {
    await writeFile(tempPath, data, 'utf-8')
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}
