import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'

import type {
  RedactedTrackerConnection,
  TrackerTransition,
  TrackerWriteBackCommentEvent,
  TrackerWriteBackConfig,
  TrackerWriteBackNotice,
  TrackerWriteBackTransitionEvent,
} from '../../../../shared/electron-api'
import {
  FOCUS_RING_PEER_CLASS,
  GhostButton,
  InlineNotice,
  Select,
  Switch,
  type SelectItem,
} from '../ui'
import { trackerProviderMonogram } from './trackerConnectionsForm'
import {
  COMMENT_EVENTS,
  masterDescription,
  previewComments,
  providerDisplayName,
  renderCommentBlocks,
  showsTransitionTier,
  TRANSITION_EVENTS,
  transitionSelectOptions,
} from './trackerWriteBackModel'

// Per-connection write-back surface (MC-1640 §4). Off by default; enabling reveals
// only the events the user ticks, and the preview mirrors exactly those using the
// engine's own comment composition. The transition tier is capability-gated
// (canTransition) and its options come from the tracker's own listTransitions —
// never a guessed workflow. Config round-trips the T10 schema over IPC; no secret
// or raw config is ever shown.

// Lazy load of a connection's real status transitions. Only fetched for providers
// that can transition and once the master switch is on. `reason` distinguishes an
// honest "no local issue to read statuses from yet" from a provider that can't
// transition; `error` carries the provider's own message on auth/network failure.
type TransitionsState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  transitions: TrackerTransition[]
  sampleKey: string | null
  reason?: 'no_sample_issue' | 'unsupported'
  error?: string
}

const INITIAL_TRANSITIONS: TransitionsState = { phase: 'idle', transitions: [], sampleKey: null }

const GROUP_TITLE_CLASS = 'mb-2 text-meta font-medium text-[color:var(--text-subtle)]'

export function TrackerWriteBackSettings({
  connection,
  workspaceRoot,
}: {
  connection: RedactedTrackerConnection
  workspaceRoot: string | null
}) {
  const [config, setConfig] = useState<TrackerWriteBackConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [configNonce, setConfigNonce] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [transitions, setTransitions] = useState<TransitionsState>(INITIAL_TRANSITIONS)
  // Write-back failures for THIS connection (T18). Only read while posting is on —
  // a disabled connection has nothing pending, so a past failure is not actionable.
  const [notices, setNotices] = useState<TrackerWriteBackNotice[]>([])
  const [retrying, setRetrying] = useState(false)

  const masterId = useId()
  const showTier = showsTransitionTier(connection.capabilities)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.api.trackerGetWriteBackConfig({ connectionId: connection.id })
      if (cancelled) return
      if (result.ok) {
        setConfig(result.config)
        setLoadError(null)
      } else {
        setLoadError(result.error.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connection.id, configNonce])

  // Retry the config load after a failure: clear the error so the loading state
  // shows again, then re-run the effect.
  const reloadConfig = useCallback(() => {
    setLoadError(null)
    setConfigNonce((value) => value + 1)
  }, [])

  // Read the connection's real transitions once the tier is visible and the
  // master switch is on — deferred until the user actually reaches for them.
  useEffect(() => {
    if (!showTier || !config?.enabled || transitions.phase !== 'idle') return
    let cancelled = false
    setTransitions((prev) => ({ ...prev, phase: 'loading' }))
    void (async () => {
      const result = await window.api.trackerListTransitions({
        connectionId: connection.id,
        workspaceRoot: workspaceRoot ?? '',
      })
      if (cancelled) return
      if (result.ok) {
        setTransitions({
          phase: 'ready',
          transitions: result.transitions,
          sampleKey: result.sampleKey,
          ...(result.reason ? { reason: result.reason } : {}),
        })
      } else {
        setTransitions({ phase: 'error', transitions: [], sampleKey: null, error: result.error.message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showTier, config?.enabled, transitions.phase, connection.id, workspaceRoot])

  // Load this connection's write-back failure notices while posting is on. Nothing
  // consumed these before T18, so an expired token posted nothing and retried
  // forever with no signal; here the failures become visible and recoverable.
  useEffect(() => {
    if (!config?.enabled) {
      setNotices([])
      return
    }
    let cancelled = false
    void (async () => {
      const result = await window.api.trackerListWriteBackNotices()
      if (cancelled || !result.ok) return
      setNotices(result.notices.filter((notice) => notice.connectionId === connection.id))
    })()
    return () => {
      cancelled = true
    }
  }, [config?.enabled, connection.id])

  // Re-run write-back reconcile for this connection now. A fixed credential clears
  // the notices; a still-broken one honestly reports the same failure.
  const retryNotices = useCallback(async () => {
    setRetrying(true)
    try {
      const result = await window.api.trackerRetryWriteBack({ connectionId: connection.id })
      if (result.ok) setNotices(result.notices)
    } finally {
      setRetrying(false)
    }
  }, [connection.id])

  // Persist optimistically: reflect the change immediately, then write it through
  // the T10 store. A failed write surfaces honestly rather than silently dropping.
  const persist = useCallback(
    async (next: TrackerWriteBackConfig) => {
      setConfig(next)
      const result = await window.api.trackerSetWriteBackConfig({ connectionId: connection.id, config: next })
      setSaveError(result.ok ? null : result.error.message)
    },
    [connection.id],
  )

  const toggleMaster = useCallback(
    (enabled: boolean) => {
      if (!config) return
      void persist({ ...config, enabled })
    },
    [config, persist],
  )

  const toggleComment = useCallback(
    (key: TrackerWriteBackCommentEvent, on: boolean) => {
      if (!config) return
      void persist({ ...config, comments: { ...config.comments, [key]: on } })
    },
    [config, persist],
  )

  const setTransition = useCallback(
    (key: TrackerWriteBackTransitionEvent, value: string) => {
      if (!config) return
      void persist({ ...config, transitions: { ...config.transitions, [key]: value ? value : null } })
    },
    [config, persist],
  )

  const transitionItems: SelectItem[] = useMemo(() => transitionSelectOptions(transitions.transitions), [transitions.transitions])
  const preview = useMemo(() => (config ? previewComments(config) : []), [config])

  if (loadError) {
    return (
      <ConnectionFrame connection={connection}>
        <InlineNotice
          tone="error"
          title="Couldn’t load these posting settings."
          hint="This is usually temporary."
          detail={loadError}
          action={
            <GhostButton size="md" onClick={reloadConfig}>
              Try again
            </GhostButton>
          }
        />
      </ConnectionFrame>
    )
  }

  if (!config) {
    return (
      <ConnectionFrame connection={connection}>
        <p className="text-body text-[color:var(--text-subtle)]">Loading write-back settings…</p>
      </ConnectionFrame>
    )
  }

  const sampleLabel = transitions.sampleKey ? `on ${transitions.sampleKey}` : 'on the issue'

  return (
    <ConnectionFrame connection={connection}>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <div className="flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] pb-3.5">
            <Switch
              id={masterId}
              checked={config.enabled}
              onChange={toggleMaster}
              ariaLabel={`Post updates back to ${providerDisplayName(connection.provider)} for ${connection.label}`}
            />
            <label htmlFor={masterId} className="cursor-pointer select-none">
              <span className="block text-body font-medium text-[color:var(--text-strong)]">
                Post updates back to {providerDisplayName(connection.provider)}
              </span>
              <span className="block text-body text-[color:var(--text-subtle)]">
                {masterDescription(config.enabled, connection.provider)}
              </span>
            </label>
          </div>

          {config.enabled ? (
            <div className="flex flex-col gap-4 pt-3.5">
              {notices.length > 0 ? (
                <InlineNotice
                  tone="error"
                  title={`Couldn’t post ${
                    notices.length === 1 ? 'an update' : `${notices.length} updates`
                  } to ${providerDisplayName(connection.provider)}.`}
                  hint="This retries automatically the next time this sprint does anything. Reconnect this connection above, or turn posting off."
                  detail={distinctNoticeMessages(notices).join('\n')}
                  action={
                    <>
                      <GhostButton size="md" onClick={() => void retryNotices()} disabled={retrying}>
                        {retrying ? 'Retrying…' : 'Retry now'}
                      </GhostButton>
                      <GhostButton size="md" onClick={() => toggleMaster(false)} disabled={retrying}>
                        Turn off posting
                      </GhostButton>
                    </>
                  }
                />
              ) : null}

              <fieldset className="border-0 p-0">
                <legend className={GROUP_TITLE_CLASS}>Comment on the issue when…</legend>
                {COMMENT_EVENTS.map((event) => (
                  <CommentCheck
                    key={event.key}
                    label={event.label}
                    checked={config.comments[event.key]}
                    onChange={(on) => toggleComment(event.key, on)}
                  />
                ))}
                <p className="mt-1.5 max-w-[54ch] text-body leading-[1.5] text-[color:var(--text-subtle)]">
                  Each update posts exactly once, even across app restarts; a failed post shows on the backlog item and
                  never blocks the sprint.
                </p>
              </fieldset>

              {showTier ? (
                <fieldset className="border-0 p-0">
                  <legend className={GROUP_TITLE_CLASS}>Change the issue’s status when…</legend>
                  {transitions.phase === 'error' ? (
                    <InlineNotice
                      tone="warn"
                      title="Couldn’t read this tracker’s statuses."
                      hint="Status changes are paused; comments still post."
                      detail={transitions.error}
                      action={
                        <GhostButton size="md" onClick={() => setTransitions(INITIAL_TRANSITIONS)}>
                          Try again
                        </GhostButton>
                      }
                    />
                  ) : transitions.reason === 'no_sample_issue' ? (
                    <p className="max-w-[52ch] text-body leading-[1.5] text-[color:var(--text-subtle)]">
                      Add an issue from this tracker to your backlog first — its own statuses populate these options, so
                      a workflow is never guessed.
                    </p>
                  ) : (
                    <>
                      {TRANSITION_EVENTS.map((event) => (
                        <div key={event.key} className="flex items-center gap-3 py-1.5">
                          <span className="w-[150px] shrink-0 text-body text-[color:var(--text-default)]">
                            {event.label}
                          </span>
                          <Select
                            ariaLabel={`Status change when ${event.label}`}
                            items={transitionItems}
                            value={config.transitions[event.key] ?? ''}
                            onChange={(value) => setTransition(event.key, value)}
                            disabled={transitions.phase !== 'ready' || transitions.transitions.length === 0}
                            triggerMinWidthClassName="min-w-0"
                            className="min-w-0 flex-1"
                          />
                        </div>
                      ))}
                      <p className="mt-1.5 max-w-[54ch] text-body leading-[1.5] text-[color:var(--text-subtle)]">
                        Statuses come from this {providerDisplayName(connection.provider)} project’s own workflow
                        {transitions.sampleKey ? `, read from ${transitions.sampleKey}` : ''}. A transition is never
                        guessed.
                      </p>
                    </>
                  )}
                </fieldset>
              ) : null}

              {saveError ? (
                <InlineNotice
                  tone="error"
                  title="Couldn’t save your posting settings."
                  hint="Your last change wasn’t saved."
                  detail={saveError}
                  action={
                    <GhostButton size="md" onClick={() => void persist(config)}>
                      Try again
                    </GhostButton>
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-2 text-meta font-medium text-[color:var(--text-subtle)]">
            What your team sees {sampleLabel}
          </div>
          {!config.enabled ? (
            <p className="text-body text-[color:var(--text-subtle)]">Nothing — posting updates is off.</p>
          ) : preview.length === 0 ? (
            <p className="text-body leading-[1.5] text-[color:var(--text-subtle)]">
              No comments will be posted.
              {config.transitions.onStart || config.transitions.onComplete
                ? ' The issue’s status will change, with no comment.'
                : ''}
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {preview.map((comment) => (
                <CommentPreviewCard key={comment.key} markdown={comment.markdown} />
              ))}
            </div>
          )}
        </div>
      </div>
    </ConnectionFrame>
  )
}

// The distinct provider messages across a connection's failure notices, so the
// error card's "Show details" lists each real reason once rather than repeating
// the same message per stuck run.
function distinctNoticeMessages(notices: TrackerWriteBackNotice[]): string[] {
  return [...new Set(notices.map((notice) => notice.message))]
}

// The per-connection container + header, naming the exact connection whose
// write-back this configures ("Jira · ACME") so ownership is never ambiguous when
// several connections are listed.
function ConnectionFrame({
  connection,
  children,
}: {
  connection: RedactedTrackerConnection
  children: React.ReactNode
}) {
  return (
    <section className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-4">
      <div className="mb-3.5 flex items-center gap-2">
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-meta font-semibold text-[color:var(--text-muted)]"
          aria-hidden="true"
        >
          {trackerProviderMonogram(connection.provider)}
        </span>
        <h3 className="text-body font-medium text-[color:var(--text-strong)]">
          {providerDisplayName(connection.provider)} · {connection.label}
        </h3>
      </div>
      {children}
    </section>
  )
}

// A ticked lifecycle event. A native checkbox carries the semantics and keyboard
// path; the visual box is decorative and hidden from assistive tech.
function CommentCheck({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2.5 py-1 text-body text-[color:var(--text-default)]">
      <span className="relative inline-flex size-icon-sm shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden="true"
          className={[
            'inline-flex size-icon-sm items-center justify-center rounded-[3px] border transition-colors',
            // The <input> is the tab stop; this box is what the user sees, so it
            // takes the shared treatment on the input's focus. Previously a
            // hand-rolled ring with a `ring-offset-color` pinned to
            // --bg-surface-raised — which is wrong the moment this row sits on
            // any other surface. The outline's gap needs no such guess.
            FOCUS_RING_PEER_CLASS,
            checked
              ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
              : 'border-[color:var(--border-default)] bg-[color:var(--bg-app)]',
          ].join(' ')}
        >
          {checked ? (
            <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="M3.5 8.5 L6.5 11.5 L12.5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </span>
      </span>
      {label}
    </label>
  )
}

// One preview comment card mirroring the tracker's comment UI: the Multicode
// author line and the rendered body (the exact markdown the engine posts).
function CommentPreviewCard({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => renderCommentBlocks(markdown), [markdown])
  return (
    <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-hover)] px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-primary)] text-meta font-semibold text-[color:var(--text-on-accent)]">
          MC
        </span>
        <span className="text-body font-medium text-[color:var(--text-strong)]">Sprint Engine Studio</span>
      </div>
      <div className="flex flex-col gap-1.5 text-body leading-[1.5] text-[color:var(--text-default)]">
        {blocks.map((block, index) =>
          block.kind === 'link-list' ? (
            <ul key={index} className="flex flex-col gap-0.5">
              {block.urls.map((url) => (
                <li key={url} className="truncate font-mono text-meta text-[color:var(--accent-primary)]">
                  {url}
                </li>
              ))}
            </ul>
          ) : (
            <p key={index}>
              {block.segments.map((segment, segmentIndex) =>
                segment.bold ? (
                  <strong key={segmentIndex} className="font-semibold text-[color:var(--text-strong)]">
                    {segment.text}
                  </strong>
                ) : (
                  <React.Fragment key={segmentIndex}>{segment.text}</React.Fragment>
                ),
              )}
            </p>
          ),
        )}
      </div>
    </div>
  )
}
