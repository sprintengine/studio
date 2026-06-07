// ProviderSettingsTab — Settings -> Providers. Lists installed conversation
// provider plugins and lets you set or remove each provider's API key. This
// surface is deliberately separate from Settings -> Agents (the installed CLI
// override table) so model providers never read as launchable terminal CLIs.
//
// Secrets are write-only from the renderer: the saved raw value is never read
// back. A configured provider shows a masked placeholder and a Remove control;
// an unconfigured one shows an input and Save. Pure state derivation lives in
// `providerSettings.ts`.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ConversationProviderListResult,
  ConversationSecretStatusResult,
} from '../../../../shared/electron-api'
import { GhostButton, PrimaryButton } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { SettingsSectionTitle } from './SettingsAtoms'
import {
  type ConversationProviderListEntry,
  type ProviderSecretView,
  canClearProviderSecret,
  deriveProviderSecretView,
  deriveProviderTabState,
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
type PendingKind = 'saving' | 'clearing'

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
    setSecretViews((current) => ({ ...current, [providerId]: deriveProviderSecretView(result) }))
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
        title: `Remove ${provider.displayName} API key?`,
        body: 'The stored key is removed from this device. You can add it again at any time.',
        confirmLabel: 'Remove key',
      })
      if (!confirmed) return
      setPending((current) => ({ ...current, [provider.id]: 'clearing' }))
      setMessage(provider.id, undefined)
      try {
        const result = await window.api.conversationSecretClear({ providerId: provider.id })
        if (result.ok) {
          applyStatusResult(provider.id, result)
          setMessage(provider.id, { tone: 'neutral', text: 'API key removed.' })
        } else {
          setMessage(provider.id, { tone: 'error', text: result.message })
        }
      } catch (err) {
        setMessage(provider.id, { tone: 'error', text: errText(err, 'Could not remove the API key.') })
      } finally {
        setPending((current) => ({ ...current, [provider.id]: undefined }))
      }
    },
    [applyStatusResult, dialog, setMessage]
  )

  return (
    <div
      role="tabpanel"
      id="settings-panel-providers"
      aria-labelledby="settings-tab-providers"
      className="space-y-5"
    >
      <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        Add an API key to use a model provider in standard workspace agents. Keys are stored on this
        device and never shown again after saving.
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
              onDraftChange={(value) =>
                setDrafts((current) => ({ ...current, [provider.id]: value }))
              }
              onSave={() => void saveKey(provider)}
              onClear={() => void clearKey(provider)}
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
  onDraftChange,
  onSave,
  onClear,
}: {
  provider: ConversationProviderListEntry
  secretView: ProviderSecretView | undefined
  draft: string
  pending: PendingKind | undefined
  message: ProviderMessage
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}) {
  const headingId = `provider-${provider.id}-heading`
  const inputId = `provider-key-${provider.id}`
  const busy = pending !== undefined
  const configured = secretView?.kind === 'configured'
  const canClear = canClearProviderSecret(secretView)

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2 border-t border-[color:var(--border-subtle)] pt-5 first:border-t-0 first:pt-0"
    >
      <SettingsSectionTitle id={headingId}>{provider.displayName}</SettingsSectionTitle>

      {secretView?.kind === 'error' ? (
        <Note tone="error">{secretView.message}</Note>
      ) : secretView?.kind === 'none-required' ? (
        <Note tone="neutral">This provider authenticates without a stored API key.</Note>
      ) : configured ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className={`${INPUT_CLASS} flex items-center tracking-[0.3em] text-[color:var(--text-muted)]`}>
              <span className="sr-only">{provider.displayName} API key is saved</span>
              <span aria-hidden="true">••••••••••••</span>
            </div>
            {canClear ? (
              <GhostButton
                size="md"
                onClick={onClear}
                disabled={busy}
                className="h-9 shrink-0 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                {pending === 'clearing' ? 'Removing…' : 'Remove'}
              </GhostButton>
            ) : null}
          </div>
          {!canClear ? (
            <p className="text-[11px] leading-5 text-[color:var(--text-subtle)]">
              Set from your environment. Remove it there to change it.
            </p>
          ) : secretView.persistence === 'session' ? (
            <p className="text-[11px] leading-5 text-[color:var(--tone-warn)]">
              Stored for this session only — clears when the app quits.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="sr-only">
            {provider.displayName} API key
          </label>
          <div className="flex items-center gap-2">
            <input
              id={inputId}
              type="password"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.trim() && !busy) onSave()
              }}
              placeholder="Paste API key"
              autoComplete="off"
              disabled={busy}
              className={`${INPUT_CLASS} min-w-0 flex-1`}
            />
            <PrimaryButton
              size="md"
              onClick={onSave}
              disabled={busy || !draft.trim()}
              className="h-9 shrink-0"
            >
              {pending === 'saving' ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
        </div>
      )}

      <div aria-live="polite" className="empty:hidden">
        {message ? <Note tone={message.tone}>{message.text}</Note> : null}
      </div>
    </section>
  )
}
