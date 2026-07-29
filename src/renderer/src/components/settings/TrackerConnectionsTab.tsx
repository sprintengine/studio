import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'

import type {
  RedactedTrackerConnection,
  TrackerAuthMode,
  TrackerConnectionProbe,
  TrackerError,
  TrackerProviderId,
} from '../../../../shared/electron-api'
import { Field, GhostButton, InlineNotice, Input, OutlineButton, PrimaryButton, SegmentedControl, Select, StatusDot } from '../ui'
import type { SelectItem } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { TrackerWriteBackSettings } from './TrackerWriteBackSettings'
import {
  activeAuthModeSpec,
  canTestDraft,
  connectionCredentialKind,
  connectionHostLabel,
  connectionStatusView,
  defaultDraftForProvider,
  draftBlockedReason,
  draftTestKey,
  draftToAddConnectionInput,
  draftToTestConnectionDraft,
  presentTrackerError,
  providerHasAuthModeChoice,
  TRACKER_PROVIDER_FORM_SPECS,
  trackerProviderFormSpec,
  trackerProviderMonogram,
  type TrackerConnectionFormDraft,
} from './trackerConnectionsForm'

// The outcome of the most recent "Test connection" round-trip, tied to the exact
// draft content that produced it (via `testKey`) so any later edit invalidates
// it and re-locks "Add tracker".
type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; testKey: string; ok: boolean; message: string }

const monogramClass =
  'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-[11px] font-semibold text-[color:var(--text-muted)]'

function Monogram({ provider }: { provider: TrackerProviderId }) {
  return (
    <span className={monogramClass} aria-hidden="true">
      {trackerProviderMonogram(provider)}
    </span>
  )
}

// A dot + label status chip, matching the mockup's connection-status idiom. The
// dot is decorative — the adjacent text already names the state to a reader.
function StatusChip({ tone, label }: { tone: React.ComponentProps<typeof StatusDot>['tone']; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--text-default)]">
      <StatusDot tone={tone} />
      {label}
    </span>
  )
}

function ConnectionRow({
  connection,
  onRemove,
  onRecover,
  busy,
}: {
  connection: RedactedTrackerConnection
  onRemove: () => void
  onRecover: () => void
  busy: boolean
}) {
  const status = connectionStatusView(connection)
  const recoverLabel = status.recovery === 'reconnect' ? 'Reconnect' : 'Test'
  return (
    <div className="flex items-center gap-3 border-b border-[color:var(--border-subtle)] py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Monogram provider={connection.provider} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">{connection.label}</div>
          <div className="truncate font-mono text-[11px] text-[color:var(--text-subtle)]">
            {connectionHostLabel(connection)}
          </div>
        </div>
      </div>
      <div className="hidden w-44 shrink-0 text-[12px] text-[color:var(--text-muted)] sm:block">
        {connectionCredentialKind(connection)}
      </div>
      <div className="flex w-40 shrink-0 flex-col items-start gap-0.5">
        <StatusChip tone={status.tone} label={status.label} />
        {status.reason ? (
          <span className="text-[11px] leading-[1.35] text-[color:var(--text-subtle)]">{status.reason}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {status.recovery !== 'none' ? (
          <OutlineButton size="md" onClick={onRecover} disabled={busy}>
            {recoverLabel}
          </OutlineButton>
        ) : null}
        <OutlineButton size="md" onClick={onRemove} disabled={busy}>
          Remove
        </OutlineButton>
      </div>
    </div>
  )
}

function describeProbe(probe: TrackerConnectionProbe): string {
  if (probe.ok) return probe.summary ?? 'Connected.'
  return probe.reason ?? 'Could not reach this tracker.'
}

export function TrackerConnectionsTab({ workspaceRoot }: { workspaceRoot: string | null } = { workspaceRoot: null }) {
  const [connections, setConnections] = useState<RedactedTrackerConnection[] | null>(null)
  const [listError, setListError] = useState<TrackerError | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)

  const [provider, setProvider] = useState<TrackerProviderId>('github')
  const [draft, setDraft] = useState<TrackerConnectionFormDraft>(() => defaultDraftForProvider('github'))
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [addPending, setAddPending] = useState(false)
  const [addedMessage, setAddedMessage] = useState<string | null>(null)

  const spec = trackerProviderFormSpec(provider)
  const authModeSpec = activeAuthModeSpec(draft)
  const hostInputId = useId()
  const nameInputId = useId()
  const tokenInputId = useId()

  const refreshConnections = useCallback(async () => {
    const result = await window.api.trackerListConnections()
    if (result.ok) {
      setConnections(result.connections)
      setListError(null)
    } else {
      setConnections([])
      setListError(result.error)
    }
  }, [])

  useEffect(() => {
    void refreshConnections()
  }, [refreshConnections])

  // Switching provider resets the draft to that provider's defaults and clears
  // any prior test result, mirroring the mockup.
  const selectProvider = useCallback((next: TrackerProviderId) => {
    setProvider(next)
    setDraft(defaultDraftForProvider(next))
    setTest({ phase: 'idle' })
    setAddedMessage(null)
  }, [])

  const patchDraft = useCallback((patch: Partial<TrackerConnectionFormDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setAddedMessage(null)
  }, [])

  const currentKey = useMemo(() => draftTestKey(draft), [draft])
  const testPassedForCurrent = test.phase === 'done' && test.ok && test.testKey === currentKey
  const blockedReason = draftBlockedReason(draft)

  const runTest = useCallback(async () => {
    if (!canTestDraft(draft)) return
    const testKey = draftTestKey(draft)
    setTest({ phase: 'testing' })
    const result = await window.api.trackerTestConnection({ draft: draftToTestConnectionDraft(draft) })
    if (result.ok) {
      setTest({ phase: 'done', testKey, ok: result.probe.ok, message: describeProbe(result.probe) })
    } else {
      setTest({ phase: 'done', testKey, ok: false, message: presentTrackerError(result.error).title })
    }
  }, [draft])

  const runAdd = useCallback(async () => {
    if (!testPassedForCurrent) return
    setAddPending(true)
    try {
      const result = await window.api.trackerAddConnection(draftToAddConnectionInput(draft))
      if (result.ok) {
        setDraft(defaultDraftForProvider(provider))
        setTest({ phase: 'idle' })
        setAddedMessage(`Added ${result.connection.label}. It now appears in the list above.`)
        await refreshConnections()
      } else {
        setTest({ phase: 'done', testKey: currentKey, ok: false, message: presentTrackerError(result.error).title })
      }
    } finally {
      setAddPending(false)
    }
  }, [draft, provider, testPassedForCurrent, currentKey, refreshConnections])

  const removeConnection = useCallback(
    async (connectionId: string) => {
      setRowBusyId(connectionId)
      try {
        const result = await window.api.trackerRemoveConnection({ connectionId })
        if (!result.ok) setListError(result.error)
        await refreshConnections()
      } finally {
        setRowBusyId(null)
      }
    },
    [refreshConnections],
  )

  // Reconnect / Test on an existing row re-probes it and folds the fresh status
  // back into the list.
  const recoverConnection = useCallback(
    async (connectionId: string) => {
      setRowBusyId(connectionId)
      try {
        await window.api.trackerTestConnection({ connectionId })
        await refreshConnections()
      } finally {
        setRowBusyId(null)
      }
    },
    [refreshConnections],
  )

  const providerSegments = useMemo(
    () => TRACKER_PROVIDER_FORM_SPECS.map((entry) => ({ value: entry.id, label: entry.label })),
    [],
  )

  const authModeItems: SelectItem<TrackerAuthMode>[] = useMemo(
    () => spec.authModes.map((mode) => ({ value: mode.value, label: mode.choiceLabel })),
    [spec],
  )

  return (
    <div role="tabpanel" id="settings-panel-trackers" aria-labelledby="settings-tab-trackers" className="space-y-6">
      <section className="space-y-3">
        <SettingsSectionTitle count={connections?.length}>Connections</SettingsSectionTitle>
        <p className="max-w-[68ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
          A connection is a provider, a server address, and a credential — hold as many as you need, including
          self-hosted servers. Credentials are stored encrypted on this machine and never written to workspace files.
        </p>

        {listError ? (
          <InlineNotice
            tone="error"
            {...presentTrackerError(listError)}
            action={
              <GhostButton size="md" onClick={() => void refreshConnections()}>
                Try again
              </GhostButton>
            }
          />
        ) : null}

        {connections === null ? (
          <p className="py-3 text-[12px] text-[color:var(--text-subtle)]">Loading connections…</p>
        ) : connections.length === 0 ? (
          <p className="rounded-md border border-dashed border-[color:var(--border-subtle)] px-4 py-6 text-[12px] text-[color:var(--text-subtle)]">
            No trackers connected yet. Add one below to pull its issues into your backlog.
          </p>
        ) : (
          <div>
            {connections.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                busy={rowBusyId === connection.id}
                onRemove={() => void removeConnection(connection.id)}
                onRecover={() => void recoverConnection(connection.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="max-w-[560px] space-y-4 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-4">
        <SettingsSectionTitle>Add a tracker</SettingsSectionTitle>

        <SegmentedControl
          ariaLabel="Tracker provider"
          items={providerSegments}
          value={provider}
          onChange={selectProvider}
        />

        {spec.selfHostable && spec.server ? (
          <Field label={spec.server.label} htmlFor={hostInputId} help={spec.server.help}>
            <Input
              value={draft.baseUrl}
              onChange={(event) => patchDraft({ baseUrl: event.target.value })}
              placeholder={spec.server.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
        ) : spec.cloudOnlyNote ? (
          <p className="rounded-md bg-[color:var(--bg-hover)] px-3 py-2.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
            {spec.cloudOnlyNote}
          </p>
        ) : null}

        {providerHasAuthModeChoice(provider) ? (
          <div className="flex flex-col gap-1.5">
            <Field.Label>Where does this Jira run?</Field.Label>
            <Select
              ariaLabel="Where does this Jira run?"
              items={authModeItems}
              value={draft.authMode}
              onChange={(value) => patchDraft({ authMode: value })}
              triggerMinWidthClassName="min-w-0"
              className="w-full"
            />
          </div>
        ) : null}

        <Field label="Name" htmlFor={nameInputId}>
          <Input
            value={draft.label}
            onChange={(event) => patchDraft({ label: event.target.value })}
            placeholder={`${spec.label} — your team`}
            autoComplete="off"
            className="font-mono"
          />
        </Field>

        <Field label={authModeSpec.tokenLabel} htmlFor={tokenInputId} help={authModeSpec.tokenHelp}>
          <Input
            type="password"
            value={draft.secret}
            onChange={(event) => patchDraft({ secret: event.target.value })}
            placeholder={authModeSpec.tokenLabel}
            autoComplete="off"
            className="font-mono"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <OutlineButton
            size="md"
            onClick={() => void runTest()}
            disabled={test.phase === 'testing' || !canTestDraft(draft)}
          >
            {test.phase === 'testing' ? 'Testing…' : 'Test connection'}
          </OutlineButton>

          <span role="status" aria-live="polite" className="min-w-0 flex-1 text-[12px]">
            {test.phase === 'testing' ? (
              <span className="inline-flex items-center gap-1.5 text-[color:var(--text-muted)]">
                <StatusDot tone="neutral" />
                Checking…
              </span>
            ) : test.phase === 'done' ? (
              <span
                className={`inline-flex items-center gap-1.5 ${
                  test.ok ? 'text-[color:var(--tone-good)]' : 'text-[color:var(--tone-warn)]'
                }`}
              >
                <StatusDot tone={test.ok ? 'good' : 'warn'} />
                {test.message}
              </span>
            ) : blockedReason ? (
              <span className="text-[color:var(--text-subtle)]">{blockedReason}</span>
            ) : (
              <span className="text-[color:var(--text-subtle)]">Test the connection before adding it.</span>
            )}
          </span>

          <PrimaryButton size="md" onClick={() => void runAdd()} disabled={!testPassedForCurrent || addPending}>
            Add tracker
          </PrimaryButton>
        </div>

        {addedMessage ? (
          <p role="status" className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            {addedMessage}
          </p>
        ) : null}
      </section>

      {connections && connections.length > 0 ? (
        <section className="space-y-3">
          <SettingsSectionTitle>Posting back to trackers</SettingsSectionTitle>
          <p className="max-w-[68ch] text-[12px] leading-5 text-[color:var(--text-muted)]">
            Off by default per connection. Sprints always read from your trackers; turn a connection on here to let a
            running sprint post progress comments — and, where the tracker supports it, move an issue’s status.
          </p>
          <div className="space-y-3">
            {connections.map((connection) => (
              <TrackerWriteBackSettings key={connection.id} connection={connection} workspaceRoot={workspaceRoot} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
