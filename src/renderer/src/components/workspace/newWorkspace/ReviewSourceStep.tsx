import { useMemo } from 'react'
import { CliModelPickerButton, StatusDot } from '../../ui'
import type { GitBranchSnapshot, ReviewSourceInput, ReviewSourceProbe } from '../../../../../shared/electron-api'
import type { AgentCli } from '../../../types/workspace'
import { type AgentCliCatalogOption } from './cliRuntimeOptions'

// The "Review a change set" creation step — source picker (PR / branch / patch),
// live detection card, and walkthrough context (knowledge graph, guide runtime,
// depth). Extracted from NewWorkspacePanel to arrest that file's growth; the
// step is fully prop-driven, so behavior is unchanged.
export type ReviewProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ok'; probe: ReviewSourceProbe }
  | { status: 'error'; message: string }

const REVIEW_SOURCE_SEGMENTS: Array<{ kind: ReviewSourceInput['kind']; label: string }> = [
  { kind: 'pull-request', label: 'Pull request' },
  { kind: 'branch', label: 'Branch' },
  { kind: 'patch', label: 'Pasted patch' },
]

const REVIEW_DEPTHS: Array<{ id: 'brief' | 'standard' | 'thorough'; label: string }> = [
  { id: 'brief', label: 'Brief' },
  { id: 'standard', label: 'Standard' },
  { id: 'thorough', label: 'Thorough' },
]

const reviewFieldLabelClass = 'text-[12px] font-medium text-[color:var(--text-strong)]'
const reviewHelpClass = 'text-[11.5px] leading-4 text-[color:var(--text-subtle)]'
const reviewInputClass =
  'w-full rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12.5px] text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent-primary)] focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]'

export function ReviewSourceStep({
  sourceKind,
  onChangeSourceKind,
  prUrl,
  onChangePrUrl,
  branches,
  baseRef,
  headRef,
  onChangeBaseRef,
  onChangeHeadRef,
  patchText,
  onChangePatchText,
  patchLabel,
  onChangePatchLabel,
  probe,
  knowledgeRoot,
  knowledgeEnabled,
  onChangeKnowledgeEnabled,
  guideCli,
  guideModel,
  guideCliOptions,
  onChangeGuideCli,
  onChangeGuideModel,
  depth,
  onChangeDepth,
  createError,
}: {
  sourceKind: ReviewSourceInput['kind']
  onChangeSourceKind: (kind: ReviewSourceInput['kind']) => void
  prUrl: string
  onChangePrUrl: (value: string) => void
  branches: GitBranchSnapshot | null
  baseRef: string
  headRef: string
  onChangeBaseRef: (value: string) => void
  onChangeHeadRef: (value: string) => void
  patchText: string
  onChangePatchText: (value: string) => void
  patchLabel: string
  onChangePatchLabel: (value: string) => void
  probe: ReviewProbeState
  knowledgeRoot: string | null
  knowledgeEnabled: boolean
  onChangeKnowledgeEnabled: (value: boolean) => void
  guideCli: AgentCli
  guideModel: string | null
  guideCliOptions: AgentCliCatalogOption[]
  onChangeGuideCli: (cli: AgentCli) => void
  onChangeGuideModel: (cli: AgentCli, model: string | null) => void
  depth: 'brief' | 'standard' | 'thorough'
  onChangeDepth: (depth: 'brief' | 'standard' | 'thorough') => void
  createError: string | null
}) {
  const branchNames = branches?.branches.map((branch) => branch.name) ?? []
  const reachabilityChip =
    sourceKind === 'branch' ? 'Local' : sourceKind === 'patch' ? 'No remote' : 'Remote'
  // The success dot's accessible label tracks the source kind — "Reachable" is only
  // accurate for a remote PR; a local branch or a pasted patch has no remote to reach.
  const successDotLabel =
    sourceKind === 'branch' ? 'Local' : sourceKind === 'patch' ? 'Valid diff' : 'Reachable'

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[12.5px] leading-5 text-[color:var(--text-muted)]">
        Your guide reads this change set and the project’s knowledge graph, then prepares a walkthrough before you start.
      </p>

      <div
        role="tablist"
        aria-label="What are you reviewing"
        className="flex gap-1 rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] p-0.5"
      >
        {REVIEW_SOURCE_SEGMENTS.map((segment) => {
          const selected = segment.kind === sourceKind
          return (
            <button
              key={segment.kind}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChangeSourceKind(segment.kind)}
              className={`flex-1 rounded-[5px] px-2 py-1.5 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
                selected
                  ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
              }`}
            >
              {segment.label}
            </button>
          )
        })}
      </div>

      {sourceKind === 'pull-request' ? (
        <label className="flex flex-col gap-1.5">
          <span className={reviewFieldLabelClass}>Pull request URL</span>
          <input
            className={reviewInputClass}
            value={prUrl}
            placeholder="https://github.com/owner/repo/pull/123"
            spellCheck={false}
            onChange={(event) => onChangePrUrl(event.currentTarget.value)}
          />
          <span className={reviewHelpClass}>A github.com or GitHub Enterprise pull request. Private hosts use your saved token.</span>
        </label>
      ) : null}

      {sourceKind === 'branch' ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={reviewFieldLabelClass}>Compare against</span>
            <ReviewRefField value={baseRef} branchNames={branchNames} onChange={onChangeBaseRef} placeholder="main" />
            <span className={reviewHelpClass}>Base the walkthrough against this branch.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={reviewFieldLabelClass}>Branch to review</span>
            <ReviewRefField value={headRef} branchNames={branchNames} onChange={onChangeHeadRef} placeholder="feature/…" />
            <span className={reviewHelpClass}>Agent worktree branches appear here too — review your agents’ work before it merges.</span>
          </label>
        </div>
      ) : null}

      {sourceKind === 'patch' ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={reviewFieldLabelClass}>Patch text</span>
            <textarea
              className={`${reviewInputClass} min-h-[120px] resize-y font-mono text-[11.5px] leading-4`}
              value={patchText}
              placeholder="diff --git a/… b/…"
              spellCheck={false}
              onChange={(event) => onChangePatchText(event.currentTarget.value)}
            />
            <span className={reviewHelpClass}>Paste unified diff or `git format-patch` output. Nothing leaves this machine.</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={reviewFieldLabelClass}>Label (optional)</span>
            <input
              className={reviewInputClass}
              value={patchLabel}
              placeholder="What this patch is"
              onChange={(event) => onChangePatchLabel(event.currentTarget.value)}
            />
          </label>
        </div>
      ) : null}

      <ReviewDetectionCard probe={probe} reachabilityChip={reachabilityChip} successLabel={successDotLabel} />

      <div className="flex flex-col gap-2.5 border-t border-[color:var(--border-subtle)] pt-4">
        <span className="text-[11px] font-medium text-[color:var(--text-subtle)]">Walkthrough context</span>

        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[12px] font-medium text-[color:var(--text-strong)]">Knowledge graph</span>
            <span className="mt-0.5 block font-mono text-[11px] leading-4 text-[color:var(--text-muted)]">
              {knowledgeRoot ? knowledgeRoot : 'None configured — the guide reads code only.'}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={knowledgeEnabled}
            aria-label="Read the knowledge graph"
            disabled={!knowledgeRoot}
            onClick={() => onChangeKnowledgeEnabled(!knowledgeEnabled)}
            className={`mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] disabled:opacity-50 ${
              knowledgeEnabled && knowledgeRoot
                ? 'bg-[color:var(--accent-primary)]'
                : 'bg-[color:var(--bg-selected)]'
            }`}
          >
            <span
              className={`h-3 w-3 rounded-full bg-white transition-transform ${
                knowledgeEnabled && knowledgeRoot ? 'translate-x-3' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[12px] font-medium text-[color:var(--text-strong)]">Guide</span>
            <span className="mt-0.5 block text-[11.5px] leading-4 text-[color:var(--text-muted)]">
              Runs in the background like any workspace agent.
            </span>
          </span>
          <CliModelPickerButton
            ariaLabel="Guide agent runtime"
            options={guideCliOptions}
            cli={guideCli}
            effectiveModelFor={(candidateCli) => (candidateCli === guideCli ? guideModel ?? undefined : undefined)}
            onSelectCli={(nextCli) => onChangeGuideCli(nextCli)}
            onSelectModel={(_cli, nextModel) => onChangeGuideModel(guideCli, nextModel)}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-[12px] font-medium text-[color:var(--text-strong)]">Explanation depth</span>
            <span className="mt-0.5 block text-[11.5px] leading-4 text-[color:var(--text-muted)]">
              How much the guide explains before you start reading.
            </span>
          </span>
          <div
            role="tablist"
            aria-label="Explanation depth"
            className="flex shrink-0 gap-0.5 rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] p-0.5"
          >
            {REVIEW_DEPTHS.map((option) => {
              const selected = option.id === depth
              return (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onChangeDepth(option.id)}
                  className={`rounded-[5px] px-2 py-1 text-[11.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
                    selected
                      ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
                      : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
                  }`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {createError ? (
        <p className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {createError}
        </p>
      ) : null}
    </div>
  )
}

// A ref field that offers the repo's local branches as a datalist when they are
// known, while still accepting a typed ref (tag, sha, remote-tracking name) the
// probe will resolve or reject.
function ReviewRefField({
  value,
  branchNames,
  onChange,
  placeholder,
}: {
  value: string
  branchNames: string[]
  onChange: (value: string) => void
  placeholder: string
}) {
  const listId = useMemo(() => `review-refs-${Math.random().toString(36).slice(2)}`, [])
  return (
    <>
      <input
        className={reviewInputClass}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        list={branchNames.length > 0 ? listId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {branchNames.length > 0 ? (
        <datalist id={listId}>
          {branchNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}

function ReviewDetectionCard({
  probe,
  reachabilityChip,
  successLabel,
}: {
  probe: ReviewProbeState
  reachabilityChip: string
  successLabel: string
}) {
  if (probe.status === 'idle') return null
  if (probe.status === 'probing') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5 text-[12px] text-[color:var(--text-muted)]">
        <StatusDot tone="neutral" pulse />
        Reading the changes…
      </div>
    )
  }
  if (probe.status === 'error') {
    // An error must read as an error, not as neutral field help: error-tone text
    // and a matching status dot instead of muted body copy.
    return (
      <div className="flex items-start gap-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5 text-[12px] leading-4 text-[color:var(--tone-error)]">
        <StatusDot tone="error" className="mt-1" />
        <span>{probe.message}</span>
      </div>
    )
  }
  const stats = probe.probe.stats
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2.5">
      <StatusDot tone="accent" label={successLabel} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-[color:var(--text-strong)]">
          {probe.probe.title ?? 'Ready to review'}
        </span>
        {stats ? (
          <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-[color:var(--text-muted)]">
            {stats.files} files · +{stats.additions} −{stats.deletions}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 rounded-full border border-[color:var(--border-subtle)] px-2 py-0.5 text-[10px] text-[color:var(--text-subtle)]">
        {reachabilityChip}
      </span>
    </div>
  )
}
