import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  GitBranchSnapshot,
  ReviewMatchPrProjectResult,
  ReviewSourceInput,
  ReviewSourceProbe,
} from '../../../../shared/electron-api'
import { FOCUS_RING_CLASS, InlineNotice, Select } from '../../components/ui'
import { PrimaryButton, GhostButton } from '../../components/ui/Buttons'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { StatusDot } from '../../components/ui/StatusDot'
import { ingestReviewChange, ReviewControllerError } from './reviewCreation'
import { controlDefaultRoot, looksLikePrUrl, resolvePrProject, type PrProjectControl } from './reviewController'

// "Review a change" (MC-1708 T6, mockup §4): the Reviews-door entry point that
// replaced the retired review-workspace creation flow. It ingests a change from a
// pull request, branch, or patch — the same three source paths the wizard covered
// — into an instance-level review (no workspace row minted), then lands on it so
// the guide can prepare the walkthrough. The guide preparation choices the old
// wizard captured are gone with the workspace type: the run is depth-standard,
// consistent with the instance-level review model.

const SOURCE_SEGMENTS: { value: ReviewSourceInput['kind']; label: string }[] = [
  { value: 'pull-request', label: 'Pull request' },
  { value: 'branch', label: 'Branch' },
  { value: 'patch', label: 'Pasted patch' },
]

const LABEL = 'mb-1 block text-meta font-medium text-[color:var(--text-default)]'
const HELP = 'mt-1 text-micro leading-4 text-[color:var(--text-subtle)]'
const INPUT =
  'w-full rounded-[6px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-body ' +
  `text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ok'; probe: ReviewSourceProbe }
  | { status: 'error'; message: string }

export interface ReviewChangeFormProps {
  /** Distinct project roots to ingest into; the first is selected by default. */
  projectRoots: string[]
  /** Lands the surface on the freshly created review. */
  onCreated: (review: { reviewId: string; workspaceRoot: string }) => void
  /** Return to the previously selected review (or the empty state). */
  onCancel: () => void
}

export function ReviewChangeForm({ projectRoots, onCreated, onCancel }: ReviewChangeFormProps): JSX.Element {
  const [projectRoot, setProjectRoot] = useState<string | null>(projectRoots[0] ?? null)
  const [sourceKind, setSourceKind] = useState<ReviewSourceInput['kind']>('pull-request')
  const [prUrl, setPrUrl] = useState('')
  // PR tab is URL-first: the project is inferred from the URL's repository, not
  // picked up front. `prControl` is the inferred project control; `prPickedRoot`
  // is the reviewer's override within a picker (null → the control's default).
  const [prControl, setPrControl] = useState<PrProjectControl>({ kind: 'hidden' })
  const [prPickedRoot, setPrPickedRoot] = useState<string | null>(null)
  // Per-form-open cache of match answers keyed by URL, so re-typing or reverting
  // to an already-checked URL resolves instantly without another IPC round-trip.
  // Invalidated when the set of open projects changes (matches depend on it).
  const matchCacheRef = useRef<Map<string, ReviewMatchPrProjectResult>>(new Map())
  const [brBase, setBrBase] = useState('')
  const [brHead, setBrHead] = useState('')
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [patchText, setPatchText] = useState('')
  const [patchLabel, setPatchLabel] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectItems = useMemo(
    () => projectRoots.map((root) => ({ value: root, label: projectLabel(root) })),
    [projectRoots],
  )

  // The typed source the probe + ingest consume, or null when the fields for the
  // current kind are not filled in — mirrors the wizard's derivation exactly.
  const source = useMemo<ReviewSourceInput | null>(() => {
    if (sourceKind === 'pull-request') {
      const url = prUrl.trim()
      return url ? { kind: 'pull-request', url } : null
    }
    if (sourceKind === 'branch') {
      const baseRef = brBase.trim()
      const headRef = brHead.trim()
      return projectRoot && baseRef && headRef ? { kind: 'branch', repoRoot: projectRoot, baseRef, headRef } : null
    }
    const text = patchText.trim()
    if (!text) return null
    const label = patchLabel.trim()
    return label ? { kind: 'patch', text, label } : { kind: 'patch', text }
  }, [sourceKind, prUrl, brBase, brHead, projectRoot, patchText, patchLabel])

  // Branch list for the selected project, so base/head are pickable and default
  // sensibly (mainline as base, current branch as head — never base === head).
  useEffect(() => {
    if (sourceKind !== 'branch' || !projectRoot) return
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await window.api.getGitBranches(projectRoot)
        if (cancelled) return
        setBranches(snapshot)
        setBrHead((current) => current || snapshot.current || '')
        setBrBase((current) => current || pickBaseDefault(snapshot))
      } catch {
        if (!cancelled) setBranches(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sourceKind, projectRoot])

  // A change to the open projects invalidates cached matches (they are computed
  // against that exact set of roots).
  useEffect(() => {
    matchCacheRef.current.clear()
  }, [projectRoots])

  // Infer the storage project from the PR URL (MC-1787), debounced so typing is
  // never blocked. A looks-like-a-PR gate keeps a half-typed URL from spending a
  // match call or flashing the no-match picker; T9's IPC does the real matching.
  useEffect(() => {
    if (sourceKind !== 'pull-request') return
    const url = prUrl.trim()
    setPrPickedRoot(null)
    if (!looksLikePrUrl(url)) {
      setPrControl({ kind: 'hidden' })
      return
    }
    const cached = matchCacheRef.current.get(url)
    if (cached) {
      setPrControl(resolvePrProject(cached, projectRoots))
      return
    }
    let cancelled = false
    const handle = window.setTimeout(() => {
      if (cancelled) return
      setPrControl({ kind: 'matching' })
      void window.api
        .reviewMatchPrProject(url, projectRoots)
        .then((result) => {
          matchCacheRef.current.set(url, result)
          if (!cancelled) setPrControl(resolvePrProject(result, projectRoots))
        })
        .catch((err) => {
          if (!cancelled) {
            setPrControl(resolvePrProject({ ok: false, error: err instanceof Error ? err.message : String(err) }, projectRoots))
          }
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [sourceKind, prUrl, projectRoots])

  // The project a review is stored in. Branch/patch keep the explicit top-of-form
  // select; the PR tab uses the URL-inferred control (picker override, then default).
  const prRoot = prPickedRoot ?? controlDefaultRoot(prControl)
  const storageRoot = sourceKind === 'pull-request' ? prRoot : projectRoot

  // Live, debounced source probe (350ms) — the same cheap read the wizard used, so
  // "Start review" is only enabled once the source is confirmed reachable.
  useEffect(() => {
    if (!source) {
      setProbe({ status: 'idle' })
      return
    }
    let cancelled = false
    const handle = window.setTimeout(() => {
      setProbe({ status: 'probing' })
      void window.api
        .reviewDetectSource(source)
        .then((result) => {
          if (cancelled) return
          setProbe(result.ok ? { status: 'ok', probe: result } : { status: 'error', message: result.error ?? 'Could not read this source.' })
        })
        .catch((err) => {
          if (!cancelled) setProbe({ status: 'error', message: err instanceof Error ? err.message : String(err) })
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [source])

  const canStart = Boolean(storageRoot && source && probe.status === 'ok' && !starting)

  const start = async (): Promise<void> => {
    if (!storageRoot || !source) return
    setStarting(true)
    setError(null)
    try {
      const reviewId = await ingestReviewChange(
        { folderPath: storageRoot, source },
        { ingestSource: (input, target) => window.api.reviewIngestSource(input, target) },
      )
      onCreated({ reviewId, workspaceRoot: storageRoot })
    } catch (err) {
      setError(err instanceof ReviewControllerError || err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const branchNames = branches?.branches.map((branch) => branch.name) ?? []

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[color:var(--bg-surface)] px-6 py-6">
      <header className="mb-5 max-w-xl">
        <h2 className="text-title font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">Review a change</h2>
        <p className="mt-1 text-body leading-5 text-[color:var(--text-muted)]">
          Point the guide at a pull request, a pair of branches, or a pasted patch. It reads the change and prepares a
          walkthrough — no workspace, no project row.
        </p>
      </header>

      <div className="max-w-xl space-y-4">
        {/* Branch and patch reads run against a repository, so they keep the
            explicit project select. The PR tab is URL-first — its project is
            inferred from the URL below, never picked up front. */}
        {sourceKind !== 'pull-request' ? (
          projectItems.length > 0 ? (
            <div>
              <span className={LABEL}>Project</span>
              <Select ariaLabel="Project to review in" items={projectItems} value={projectRoot} onChange={setProjectRoot} />
              <p className={HELP}>Where the change lives. Branch reads run against this repository.</p>
            </div>
          ) : (
            <InlineNotice tone="warn" className="max-w-xl">
              Open a project first — a review reads a change from one of your projects.
            </InlineNotice>
          )
        ) : null}

        <div>
          <span className={LABEL}>What are you reviewing?</span>
          <SegmentedControl ariaLabel="What are you reviewing" items={SOURCE_SEGMENTS} value={sourceKind} onChange={setSourceKind} />
        </div>

        {sourceKind === 'pull-request' ? (
          <>
            <label className="block">
              <span className={LABEL}>Pull request URL</span>
              <input
                type="text"
                value={prUrl}
                onChange={(event) => setPrUrl(event.target.value)}
                placeholder="https://github.com/owner/repo/pull/123"
                className={INPUT}
              />
              <span className={HELP}>A github.com or GitHub Enterprise pull request. Private hosts use your saved token.</span>
            </label>
            <PrProjectField control={prControl} selectedRoot={prRoot} onSelect={setPrPickedRoot} />
          </>
        ) : null}

        {sourceKind === 'branch' ? (
          <>
            <label className="block">
              <span className={LABEL}>Compare against</span>
              <input
                type="text"
                value={brBase}
                onChange={(event) => setBrBase(event.target.value)}
                placeholder="main"
                list="review-change-branches"
                className={INPUT}
              />
              <span className={HELP}>Base the walkthrough against this branch.</span>
            </label>
            <label className="block">
              <span className={LABEL}>Branch to review</span>
              <input
                type="text"
                value={brHead}
                onChange={(event) => setBrHead(event.target.value)}
                placeholder="feature/…"
                list="review-change-branches"
                className={INPUT}
              />
              <span className={HELP}>Agent worktree branches appear here too — review your agents’ work before it merges.</span>
            </label>
            <datalist id="review-change-branches">
              {branchNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        ) : null}

        {sourceKind === 'patch' ? (
          <>
            <label className="block">
              <span className={LABEL}>Patch text</span>
              <textarea
                value={patchText}
                onChange={(event) => setPatchText(event.target.value)}
                placeholder="diff --git a/… b/…"
                className={`${INPUT} min-h-[120px] font-mono`}
              />
              <span className={HELP}>Paste unified diff or `git format-patch` output. Nothing leaves this machine.</span>
            </label>
            <label className="block">
              <span className={LABEL}>Label (optional)</span>
              <input
                type="text"
                value={patchLabel}
                onChange={(event) => setPatchLabel(event.target.value)}
                placeholder="What this patch is"
                className={INPUT}
              />
            </label>
          </>
        ) : null}

        <ProbeCard probe={probe} sourceKind={sourceKind} />

        {error ? <InlineNotice tone="error" className="max-w-xl">{error}</InlineNotice> : null}

        <div className="flex items-center gap-2 pt-1">
          <PrimaryButton onClick={start} disabled={!canStart}>
            {starting ? 'Starting…' : 'Start review'}
          </PrimaryButton>
          <GhostButton onClick={onCancel} disabled={starting}>
            Cancel
          </GhostButton>
        </div>
      </div>
    </div>
  )
}

// The URL-first project control for the PR tab (MC-1787): the storage project is
// inferred from the pull request's repository, so this renders per match count
// rather than as an up-front picker.
//   hidden      → the URL is not a PR link yet; nothing to show.
//   matching    → the match check is running.
//   confirmed   → exactly one project matches; a quiet confirmation line, not a
//                 control the reviewer has to touch.
//   choose      → several checkouts (only those), no match (any open project), or
//                 a failed check (any open project) — a compact picker + one line.
//   no-projects → nothing is open, so there is nowhere to store the review.
function PrProjectField({
  control,
  selectedRoot,
  onSelect,
}: {
  control: PrProjectControl
  selectedRoot: string | null
  onSelect: (root: string) => void
}): JSX.Element | null {
  if (control.kind === 'hidden') return null
  if (control.kind === 'matching') {
    // Static dot, not a pulse — the probe card below owns the one "alive" motion
    // treatment while a source is being read; two pulses at once would compete.
    return (
      <p className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
        <StatusDot tone="neutral" />
        Finding the matching project…
      </p>
    )
  }
  if (control.kind === 'no-projects') {
    return (
      <InlineNotice tone="warn" className="max-w-xl">
        Open a project first — a review is stored inside one of your open projects.
      </InlineNotice>
    )
  }
  if (control.kind === 'confirmed') {
    return (
      <p className="text-meta leading-5 text-[color:var(--text-muted)]">
        Stored in <span className="font-medium text-[color:var(--text-default)]">{projectLabel(control.root)}</span> — the open
        project that matches this pull request.
      </p>
    )
  }
  const items = control.roots.map((root) => ({ value: root, label: projectLabel(root) }))
  return (
    <div>
      <span className={LABEL}>Store the review in</span>
      <Select ariaLabel="Project to store the review in" items={items} value={selectedRoot} onChange={onSelect} />
      <p className={HELP}>{CHOOSE_HELP[control.reason]}</p>
    </div>
  )
}

const CHOOSE_HELP: Record<'many' | 'none' | 'error', string> = {
  many: 'Several open projects are checkouts of this repository — pick which one keeps the review.',
  none: 'No open project matches this pull request. Pick where to keep the review — the walkthrough still reads the change from the pull request itself.',
  error: 'Could not check which project matches this pull request. Pick where to keep the review.',
}

// The live probe result, styled as the wizard's detection card: quiet while idle,
// a settling line while probing, the change identity + stats on success, and the
// source error on failure. Never a thrown error — the probe itself never throws.
function ProbeCard({ probe, sourceKind }: { probe: ProbeState; sourceKind: ReviewSourceInput['kind'] }) {
  if (probe.status === 'idle') return null
  if (probe.status === 'probing') {
    return (
      <p className="flex items-center gap-2 text-meta text-[color:var(--text-muted)]">
        <StatusDot tone="neutral" pulse label="Reading the change" />
        Reading the change…
      </p>
    )
  }
  if (probe.status === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-[6px] border border-[color:var(--tone-error)] bg-[color:var(--tone-error-soft)] px-3 py-2">
        <StatusDot tone="error" label="Could not read this source" className="mt-1.5" />
        <p className="text-meta leading-5 text-[color:var(--tone-error)]">{probe.message}</p>
      </div>
    )
  }
  const { title, stats } = probe.probe
  return (
    <div className="flex items-start gap-2 rounded-[6px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
      <StatusDot tone="accent" label={reachabilityLabel(sourceKind)} className="mt-1.5" />
      <div className="min-w-0">
        <p className="truncate text-body text-[color:var(--text-default)]">{title ?? 'Ready to review'}</p>
        {stats ? (
          <p className="font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
            {stats.files} {stats.files === 1 ? 'file' : 'files'} · <span className="text-[color:var(--tone-good)]">+{stats.additions}</span>{' '}
            <span className="text-[color:var(--tone-error)]">−{stats.deletions}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

function reachabilityLabel(kind: ReviewSourceInput['kind']): string {
  if (kind === 'branch') return 'Local'
  if (kind === 'patch') return 'Valid diff'
  return 'Reachable'
}

function projectLabel(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

// The base ref a Branch review defaults to: the project mainline if present (never
// the branch being reviewed), else the first other local branch.
function pickBaseDefault(snapshot: GitBranchSnapshot): string {
  const names = snapshot.branches.map((branch) => branch.name)
  for (const preferred of ['main', 'master', 'develop']) {
    if (preferred !== snapshot.current && names.includes(preferred)) return preferred
  }
  return names.find((name) => name !== snapshot.current) ?? ''
}

export default ReviewChangeForm
