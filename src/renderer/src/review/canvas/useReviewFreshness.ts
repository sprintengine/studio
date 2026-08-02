import { useCallback, useEffect, useRef, useState } from 'react'

import type { ReviewBrief, ReviewChangeSet } from '../../../../shared/review'
import { useGitStatus } from '../../hooks/useGitStatus'
import {
  computeFreshness,
  reconstructSourceInput,
  shouldProbePullRequest,
  sourceCanGoStale,
  type FreshnessResult,
} from './freshness'

export interface ReviewFreshness {
  result: FreshnessResult
  probedChangeset: ReviewChangeSet
}

// Detects when the reviewed head has moved past the walkthrough (MC-1682), the
// honest-staleness half of the feature. It never mutates anything — it only
// probes (rebuild-without-persist) and reports a verdict the panel turns into a
// banner. Freshness detection is source-specific:
//
//   - branch: keyed off the shared git-status snapshot. `useGitStatus` re-renders
//     with a new `status` reference only when its internal signature changes (a
//     commit moves HEAD and clears staged changes), so a `useEffect` on `status`
//     is the change seam — no new polling loop.
//   - pull-request: probed on mount/reveal and on explicit recheck only, debounced
//     to >=60s. There is deliberately NO timer, so nothing runs while the
//     workspace is hidden (visibilitychange is the only reveal trigger).
//   - patch: never probed — a patch has no upstream and can never be stale.
export function useReviewFreshness(
  workspaceRoot: string | null,
  changeset: ReviewChangeSet | null,
  brief: ReviewBrief | null,
): ReviewFreshness | null {
  const [freshness, setFreshness] = useState<ReviewFreshness | null>(null)
  const probingRef = useRef(false)
  const lastProbeAtRef = useRef<number | null>(null)

  // Only a branch source subscribes to git status; a PR/patch source passes null
  // so no repo status subscription is created on its behalf.
  const branchRoot = changeset?.source.kind === 'branch' ? workspaceRoot : null
  const { status } = useGitStatus(branchRoot)

  const probe = useCallback(async () => {
    if (!changeset || !brief || !sourceCanGoStale(changeset)) return
    const input = reconstructSourceInput(changeset)
    if (!input || probingRef.current) return
    probingRef.current = true
    lastProbeAtRef.current = Date.now()
    try {
      const result = await window.api.reviewProbeChangeset(input)
      // A probe failure (unreachable ref, rate limit) is non-fatal: keep showing
      // the current walkthrough rather than a scary banner about a failed check.
      if (!result.ok) return
      const verdict = computeFreshness(changeset, result.changeset, brief)
      setFreshness(verdict.headMoved ? { result: verdict, probedChangeset: result.changeset } : null)
    } catch {
      // Same posture for a rejected probe (transport/IPC error): a background
      // staleness check must never throw into the surface. Swallow and keep the
      // current walkthrough; the next reveal or git-status change re-probes.
    } finally {
      probingRef.current = false
    }
  }, [changeset, brief])

  // A fresh walkthrough (a re-run replaced the changeset/brief) drops any banner.
  useEffect(() => {
    setFreshness(null)
    lastProbeAtRef.current = null
  }, [changeset?.id, brief?.changeSetId])

  // Branch: probe whenever the git status snapshot changes (and once on mount).
  useEffect(() => {
    if (changeset?.source.kind !== 'branch' || !brief) return
    void probe()
    // `status` is the change seam; `probe` closes over the current changeset/brief.
  }, [status, changeset, brief, probe])

  // Pull request: probe on mount/reveal only, debounced. No timer — the workspace
  // being hidden means no probe at all.
  useEffect(() => {
    if (changeset?.source.kind !== 'pull-request' || !brief) return
    const check = (): void => {
      if (shouldProbePullRequest(Date.now(), lastProbeAtRef.current, !document.hidden)) void probe()
    }
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [changeset, brief, probe])

  return freshness
}
