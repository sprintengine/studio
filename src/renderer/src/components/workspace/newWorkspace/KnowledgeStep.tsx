import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

import { GhostButton, InlineNotice, StatusDot } from '../../ui'
import type { Tone } from '../../ui'
import { isAbsolutePath } from '../../../store/slices/memorySlice'
import { relativePathBetween } from '../../../utils/projectKnowledge'
import { knowledgeCandidatePaths } from './knowledgeFolders'

const INPUT_CLASS =
  'h-10 w-full min-w-0 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 font-mono text-[13px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)]'

type Status = MemoryRootStatus | null

function dotTone(status: Status, checking: boolean, hasValue: boolean): Tone {
  if (checking) return 'neutral'
  if (!hasValue) return 'neutral'
  if (!status) return 'neutral'
  return status.ok ? 'good' : 'warn'
}

type Props = {
  /** Resolved project root for the chosen workspace folder. */
  projectRoot: string
  /** Knowledge folder currently stored for this project, or null. */
  committedRelativeRoot: string | null
  /** Persist the chosen folder (relative path) or null to clear it. */
  onCommit: (relativeRoot: string | null) => void
  /**
   * Project roots already auto-applied, owned by the parent so it survives this
   * step unmounting/remounting on wizard navigation. Without it, re-entering the
   * step would re-apply the detected folder and silently undo an explicit clear.
   */
  autoApplyGuard: MutableRefObject<Set<string>>
}

/**
 * Wizard step for pointing new agents at a knowledge-graph folder. Mirrors the
 * Settings → Knowledge graph picker, but tuned for first setup: it probes the
 * project for a conventional folder and auto-applies a strong match so the
 * common case (a repo with knowledge/) needs no input, while keeping the manual
 * path field and folder picker. Writes go through the same project-keyed store
 * mutation as Settings, so the choice immediately drives the agent runtime.
 */
export function KnowledgeStep({ projectRoot, committedRelativeRoot, onCommit, autoApplyGuard }: Props) {
  const [draft, setDraft] = useState(committedRelativeRoot ?? '')
  const [status, setStatus] = useState<Status>(null)
  const [checking, setChecking] = useState(false)
  const [suggestions, setSuggestions] = useState<Array<{ name: string; strong: boolean }>>([])

  // Latest committed value, read inside the detection effect without making it a
  // dependency (which would re-probe the filesystem after every auto-apply).
  const committedRef = useRef(committedRelativeRoot)
  useEffect(() => {
    committedRef.current = committedRelativeRoot
  }, [committedRelativeRoot])

  const validate = useCallback(
    async (value: string) => {
      const relativeRoot = value.trim()
      if (!relativeRoot) {
        setStatus(null)
        return
      }
      if (isAbsolutePath(relativeRoot)) {
        setStatus({
          ok: false,
          status: 'invalid-relative-path',
          relativeRoot: null,
          message: 'Knowledge path must be relative to the project folder.',
        })
        return
      }
      setChecking(true)
      try {
        const resolved = await window.api.memoryResolveRoot({ workspaceRoot: projectRoot, relativeRoot })
        setStatus(resolved)
      } catch (error) {
        setStatus({
          ok: false,
          status: 'inaccessible',
          relativeRoot,
          message: error instanceof Error ? error.message : 'Unable to check knowledge path.',
        })
      } finally {
        setChecking(false)
      }
    },
    [projectRoot],
  )

  const commit = useCallback(
    (value: string) => {
      const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
      setDraft(trimmed)
      onCommit(trimmed || null)
      if (trimmed) void validate(trimmed)
      else setStatus(null)
    },
    [onCommit, validate],
  )

  // `commit` closes over the parent's `onCommit`, which is recreated per render;
  // read it through a ref so the detection effect can stay keyed on projectRoot
  // alone and never re-probe the filesystem on an unrelated re-render.
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  // On entering the step (or switching projects), reset to the stored value,
  // probe the project for conventional knowledge folders, and auto-apply a
  // strong match when nothing is configured yet.
  useEffect(() => {
    if (!projectRoot) return undefined
    let cancelled = false
    setDraft(committedRef.current ?? '')
    setStatus(null)
    setSuggestions([])
    if (committedRef.current) void validate(committedRef.current)

    void Promise.all(
      knowledgeCandidatePaths(projectRoot).map(async (candidate) => ({
        ...candidate,
        exists: await window.api.pathExists(candidate.path).catch(() => false),
      })),
    ).then((results) => {
      if (cancelled) return
      const existing = results.filter((result) => result.exists)
      setSuggestions(existing.map(({ name, strong }) => ({ name, strong })))

      // Auto-apply the top strong match once per project, and only when nothing is
      // configured yet — so the common case needs no input, but we never override
      // a value the user has since set or explicitly cleared on re-entry.
      const topStrong = existing.find((result) => result.strong)
      if (topStrong && !committedRef.current && !autoApplyGuard.current.has(projectRoot)) {
        autoApplyGuard.current.add(projectRoot)
        commitRef.current(topStrong.name)
      }
    })

    return () => {
      cancelled = true
    }
  }, [projectRoot, validate, autoApplyGuard])

  const chooseFolder = useCallback(async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    const relative = relativePathBetween(projectRoot, dir)
    if (!relative || relative === '.') {
      setStatus({
        ok: false,
        status: 'invalid-relative-path',
        relativeRoot: null,
        message: 'Choose a folder inside the project folder.',
      })
      return
    }
    commit(relative)
  }, [projectRoot, commit])

  const error = status && !status.ok ? status.message : null

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <StatusDot tone={dotTone(status, checking, Boolean(draft.trim()))} label="Knowledge folder status" />
        <input
          value={draft}
          aria-label="Knowledge folder, relative to the project folder"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          placeholder="knowledge"
          className={INPUT_CLASS}
        />
        <GhostButton
          size="md"
          onClick={() => void chooseFolder()}
          className="h-10 shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
        >
          Choose…
        </GhostButton>
      </div>

      {error ? <InlineNotice tone="warn">{error}</InlineNotice> : null}

      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-medium text-[color:var(--text-subtle)]">Detected in this project</span>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => {
              const active = draft.trim() === suggestion.name
              return (
                <button
                  key={suggestion.name}
                  type="button"
                  onClick={() => commit(suggestion.name)}
                  aria-pressed={active}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors',
                    'focus-visible:focus-ring',
                    active
                      ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                      : 'border-[color:var(--border-default)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                  ].join(' ')}
                >
                  {suggestion.name}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {draft.trim() ? (
        <button
          type="button"
          onClick={() => commit('')}
          className="w-fit rounded text-[12px] text-[color:var(--text-subtle)] underline-offset-2 hover:text-[color:var(--text-default)] hover:underline focus-visible:focus-ring"
        >
          Clear knowledge folder
        </button>
      ) : null}

      <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        Agents in this project read the folder you pick here for product, architecture, and ecosystem context. It is
        stored per project, so every workspace in this folder shares it. You can change or clear it later in Settings →
        Knowledge graph.
      </p>
    </div>
  )
}
