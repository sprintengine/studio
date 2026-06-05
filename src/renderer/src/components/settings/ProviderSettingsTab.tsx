// ProviderSettingsTab — Settings -> Providers. Lists installed conversation
// provider plugins (model providers and agent harnesses), shows auth status,
// supports per-provider API key set/clear through the secret IPC, and runs a
// credential readiness check. This surface is deliberately separate from
// Settings -> Agents (the installed CLI override table backed by the plugin
// catalog) so raw model providers never read as launchable terminal CLIs.
//
// Secrets are write-only from the renderer: the saved raw value is never read
// back, and the password field is cleared after a successful save. Pure state
// derivation lives in `providerSettings.ts`.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ConversationProviderListResult,
  ConversationSecretStatusResult,
} from '../../../../shared/electron-api'
import { Field, GhostButton, PrimaryButton, StatusDot } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import {
  type ConversationProviderListEntry,
  type ProviderReadiness,
  type ProviderSecretView,
  canClearProviderSecret,
  deriveProviderReadiness,
  deriveProviderSecretView,
  deriveProviderTabState,
  formatProviderModels,
  formatProviderSource,
  formatProviderType,
  summarizeProviderAdapter,
  summarizeProviderSecret,
} from './providerSettings'

const INPUT_CLASS =
  'h-9 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 font-mono text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] disabled:opacity-45'

type NoteTone = 'neutral' | 'accent' | 'warn' | 'error'

const NOTE_BORDER: Record<NoteTone, string> = {
  neutral: 'border-[color:var(--border-strong)]',
  accent: 'border-[color:var(--accent-primary)]',
  warn: 'border-[color:var(--tone-warn)]',
  error: 'border-[color:var(--tone-error)]',
}

const NOTE_TEXT: Record<NoteTone, string> = {
  neutral: 'text-[color:var(--text-muted)]',
  accent: 'text-[color:var(--accent-primary)]',
  warn: 'text-[color:var(--tone-warn)]',
  error: 'text-[color:var(--tone-error)]',
}

function Note({ tone, children }: { tone: NoteTone; children: React.ReactNode }) {
  return (
    <div className={`border-l-2 pl-3 text-[12px] leading-5 ${NOTE_BORDER[tone]} ${NOTE_TEXT[tone]}`}>
      {children}
    </div>
  )
}

type ProviderMessage = { tone: NoteTone; text: string } | undefined
type PendingKind = 'saving' | 'clearing' | 'checking'

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export function ProviderSettingsTab() {
  const dialog = useConfirmDialog()
  const ipcAvailable = typeof window.api.conversationProvidersList === 'function'

  const [listResult, setListResult] = useState<ConversationProviderListResult | null>(null)
  const [secretViews, setSecretViews] = useState<Record<string, ProviderSecretView | undefined>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Record<string, PendingKind | undefined>>({})
  const [messages, setMessages] = useState<Record<string, ProviderMessage>>({})
  const [readiness, setReadiness] = useState<Record<string, ProviderReadiness | undefined>>({})

  const tabState = useMemo(
    () => deriveProviderTabState(listResult, ipcAvailable),
    [listResult, ipcAvailable]
  )

  const setMessage = useCallback((providerId: string, message: ProviderMessage) => {
    setMessages((current) => ({ ...current, [providerId]: message }))
  }, [])

  const loadProviders = useCallback(async () => {
    if (!ipcAvailable) return
    setListResult(null)
    try {
      const result = await window.api.conversationProvidersList()
      setListResult(result)
      if (!result.ok) return
      const entries = await Promise.all(
        result.providers.map(async (entry) => {
          try {
            const statusResult = await window.api.conversationSecretStatus({ providerId: entry.id })
            return [entry.id, deriveProviderSecretView(statusResult)] as const
          } catch (err) {
            return [
              entry.id,
              { kind: 'error', message: errText(err, 'Key status unavailable.') } as ProviderSecretView,
            ] as const
          }
        })
      )
      setSecretViews(Object.fromEntries(entries))
    } catch (err) {
      setListResult({ ok: false, message: errText(err, 'Conversation providers are unavailable.') })
    }
  }, [ipcAvailable])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  const applyStatusResult = useCallback((providerId: string, result: ConversationSecretStatusResult) => {
    const view = deriveProviderSecretView(result)
    setSecretViews((current) => ({ ...current, [providerId]: view }))
    return view
  }, [])

  const saveKey = useCallback(
    async (provider: ConversationProviderListEntry) => {
      const draft = (drafts[provider.id] ?? '').trim()
      if (!draft) {
        setMessage(provider.id, { tone: 'warn', text: 'Enter an API key before saving.' })
        return
      }
      setPending((current) => ({ ...current, [provider.id]: 'saving' }))
      setMessage(provider.id, undefined)
      try {
        const result = await window.api.conversationSecretSet({ providerId: provider.id, value: draft })
        if (result.ok) {
          applyStatusResult(provider.id, result)
          setDrafts((current) => ({ ...current, [provider.id]: '' }))
          // Readiness reflected the old key; drop it so a stale verdict can't linger.
          setReadiness((current) => ({ ...current, [provider.id]: undefined }))
          setMessage(provider.id, { tone: 'accent', text: 'API key saved.' })
        } else {
          setMessage(provider.id, { tone: 'error', text: result.message })
        }
      } catch (err) {
        setMessage(provider.id, { tone: 'error', text: errText(err, 'Could not save the API key.') })
      } finally {
        setPending((current) => ({ ...current, [provider.id]: undefined }))
      }
    },
    [applyStatusResult, drafts, setMessage]
  )

  const clearKey = useCallback(
    async (provider: ConversationProviderListEntry) => {
      const confirmed = await dialog.confirm({
        title: `Clear ${provider.displayName} API key?`,
        body: 'The stored key is removed from this device. You can add it again at any time.',
        confirmLabel: 'Clear key',
      })
      if (!confirmed) return
      setPending((current) => ({ ...current, [provider.id]: 'clearing' }))
      setMessage(provider.id, undefined)
      try {
        const result = await window.api.conversationSecretClear({ providerId: provider.id })
        if (result.ok) {
          applyStatusResult(provider.id, result)
          setReadiness((current) => ({ ...current, [provider.id]: undefined }))
          setMessage(provider.id, { tone: 'neutral', text: 'API key cleared.' })
        } else {
          setMessage(provider.id, { tone: 'error', text: result.message })
        }
      } catch (err) {
        setMessage(provider.id, { tone: 'error', text: errText(err, 'Could not clear the API key.') })
      } finally {
        setPending((current) => ({ ...current, [provider.id]: undefined }))
      }
    },
    [applyStatusResult, dialog, setMessage]
  )

  const checkKeyStatus = useCallback(
    async (provider: ConversationProviderListEntry) => {
      setPending((current) => ({ ...current, [provider.id]: 'checking' }))
      setMessage(provider.id, undefined)
      try {
        const result = await window.api.conversationSecretStatus({ providerId: provider.id })
        const view = applyStatusResult(provider.id, result)
        setReadiness((current) => ({ ...current, [provider.id]: deriveProviderReadiness(view) }))
      } catch (err) {
        setReadiness((current) => ({
          ...current,
          [provider.id]: { tone: 'error', headline: 'Status unavailable', detail: errText(err, 'Provider status check failed.') },
        }))
      } finally {
        setPending((current) => ({ ...current, [provider.id]: undefined }))
      }
    },
    [applyStatusResult, setMessage]
  )

  return (
    <div
      role="tabpanel"
      id="settings-panel-providers"
      aria-labelledby="settings-tab-providers"
      className="space-y-4"
    >
      <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        Conversation providers are model APIs and agent harnesses used by standard workspace agents.
        API keys are stored by the app and never shown again after saving. This is separate from the
        Agents tab, which configures installed terminal CLIs.
      </p>

      {tabState.kind === 'unavailable' ? <Note tone="neutral">{tabState.message}</Note> : null}

      {tabState.kind === 'loading' ? <Note tone="neutral">Loading conversation providers…</Note> : null}

      {tabState.kind === 'error' ? (
        <div className="space-y-2">
          <Note tone="warn">{tabState.message}</Note>
          <GhostButton
            onClick={() => void loadProviders()}
            className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Retry
          </GhostButton>
        </div>
      ) : null}

      {tabState.kind === 'empty' ? (
        <Note tone="neutral">
          No conversation providers are installed. Provider plugins are added through the provider
          install flow, not this tab.
        </Note>
      ) : null}

      {tabState.kind === 'ready'
        ? tabState.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              secretView={secretViews[provider.id]}
              draft={drafts[provider.id] ?? ''}
              pending={pending[provider.id]}
              message={messages[provider.id]}
              readiness={readiness[provider.id]}
              onDraftChange={(value) =>
                setDrafts((current) => ({ ...current, [provider.id]: value }))
              }
              onSave={() => void saveKey(provider)}
              onClear={() => void clearKey(provider)}
              onCheckStatus={() => void checkKeyStatus(provider)}
            />
          ))
        : null}
    </div>
  )
}

function ProviderRow({
  provider,
  secretView,
  draft,
  pending,
  message,
  readiness,
  onDraftChange,
  onSave,
  onClear,
  onCheckStatus,
}: {
  provider: ConversationProviderListEntry
  secretView: ProviderSecretView | undefined
  draft: string
  pending: PendingKind | undefined
  message: ProviderMessage
  readiness: ProviderReadiness | undefined
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
  onCheckStatus: () => void
}) {
  const headingId = `provider-${provider.id}-heading`
  const summary = summarizeProviderSecret(secretView)
  const adapterSummary = summarizeProviderAdapter(provider)
  const needsKey = secretView?.kind !== 'none-required'
  const showInput = needsKey && secretView?.kind !== 'error'
  const canClear = canClearProviderSecret(secretView)
  const busy = pending !== undefined

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 border-t border-[color:var(--border-subtle)] pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span id={headingId} className="text-[13px] font-medium text-[color:var(--text-strong)]">
            {provider.displayName}
          </span>
          <span className="text-[11px] text-[color:var(--text-muted)]">
            {formatProviderType(provider.providerType)} · {formatProviderSource(provider.source)}
          </span>
        </div>
        {/* One status dot per row: the at-rest summary yields to a fresh
            readiness verdict (shown below) so the same credential fact is never
            expressed by two dots that could disagree in tone or wording. */}
        {readiness ? null : (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
            <StatusDot tone={summary.tone} />
            <span className="text-[color:var(--text-default)]">{summary.label}</span>
          </span>
        )}
      </div>

      <p className="text-[11px] leading-5 text-[color:var(--text-muted)]">
        Models: <span className="text-[color:var(--text-default)]">{formatProviderModels(provider.models)}</span>
      </p>

      <div className="flex items-start gap-1.5 text-[12px] leading-5">
        <StatusDot tone={adapterSummary.tone} className="mt-1" />
        <span className="text-[color:var(--text-muted)]">
          <span className="font-medium text-[color:var(--text-default)]">{adapterSummary.label}</span>
          {adapterSummary.detail ? `: ${adapterSummary.detail}` : null}
        </span>
      </div>

      {secretView?.kind === 'none-required' ? (
        <Note tone="neutral">This provider authenticates without a stored API key.</Note>
      ) : null}

      {secretView?.kind === 'error' ? <Note tone="error">{secretView.message}</Note> : null}

      {showInput ? (
        <Field label="API key" htmlFor={`provider-key-${provider.id}`}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`provider-key-${provider.id}`}
              type="password"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder={secretView?.kind === 'configured' ? 'Key saved' : 'Paste API key'}
              autoComplete="off"
              aria-label={`${provider.displayName} API key`}
              disabled={busy}
              className={`${INPUT_CLASS} min-w-0 flex-1`}
            />
            <div className="flex gap-2">
              <PrimaryButton size="md" onClick={onSave} disabled={busy || !draft.trim()} className="h-9">
                {pending === 'saving' ? 'Saving…' : 'Save'}
              </PrimaryButton>
              <GhostButton
                size="md"
                onClick={onClear}
                disabled={busy || !canClear}
                className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                {pending === 'clearing' ? 'Clearing…' : 'Clear'}
              </GhostButton>
            </div>
          </div>
        </Field>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <GhostButton
          size="md"
          onClick={onCheckStatus}
          disabled={busy}
          className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
        >
          {pending === 'checking' ? 'Checking…' : 'Check key status'}
        </GhostButton>
        <span className="text-[11px] leading-5 text-[color:var(--text-subtle)]">
          Re-checks stored credentials. Live endpoint testing ships with the provider runtime.
        </span>
      </div>

      <div aria-live="polite" className="space-y-2 empty:hidden">
        {message ? <Note tone={message.tone}>{message.text}</Note> : null}
        {readiness ? (
          <div className="flex items-start gap-1.5 text-[12px] leading-5">
            <StatusDot tone={readiness.tone} className="mt-1" />
            <span className="text-[color:var(--text-muted)]">
              <span className="font-medium text-[color:var(--text-default)]">{readiness.headline}</span>
              {' — '}
              {readiness.detail}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
