import { useCallback, useEffect, useId, useState } from 'react'

import type { StudioScope } from '../../../../../packages/studio-protocol/src/public'
import type { CliPermissionPreset } from '../../../../shared/cli-permission-preset'
import type { StudioLocalAppOfferView, StudioLocalAppsStatus } from '../../../../shared/studio-local-apps'
import { formatRelativeMsAgo, relativeFromNow } from '../../utils/relativeTime'
import {
  CopyGlyphButton,
  DescribedCheckRow,
  DescribedCheckRowList,
  Field,
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  PrimaryButton,
  ScopePill,
  ScopePillSet,
  Select,
  useConfirmDialog,
} from '../ui'
import { AGENT_SPAWN_PERMISSION_OPTIONS, PRESET_CHIP_LABEL } from '../workspace/agentComposer/agentSpawnShared'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Agents, under the MCP gateway: the applications on this machine
// paired with Studio's owner socket (the Studio RPC that @sprintengine/agent-sdk
// speaks). Each row says what the app may do — its scopes, and the loosest
// preset its chats may run on — and whether it is connected, and revokes it.
// Pairing mints a one-time code the app presents once; the code is shown here
// that once and is never readable again.

const SCOPE_ROWS: Array<{ scope: StudioScope; title: string; description: string }> = [
  {
    scope: 'conversation:read',
    title: 'Read chats',
    description: 'List this machine’s chats and follow them as they run.',
  },
  {
    scope: 'conversation:operate',
    title: 'Drive chats',
    description: 'Send messages, answer approvals and questions, switch model or preset, interrupt and stop.',
  },
  {
    scope: 'conversation:create',
    title: 'Start chats',
    description: 'Start new chats in a workspace, with a prompt and skills.',
  },
]

const CEILING_ITEMS = AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => ({
  value: option.value as CliPermissionPreset,
  label: option.label,
  ...(option.value === 'bypass' ? { tone: 'warn' as const } : {}),
}))

type Draft = { name: string; scopes: StudioScope[]; ceiling: CliPermissionPreset }
const EMPTY_DRAFT: Draft = { name: '', scopes: ['conversation:read', 'conversation:operate'], ceiling: 'auto' }

export function LocalAppsSettings() {
  const [status, setStatus] = useState<StudioLocalAppsStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [minted, setMinted] = useState<StudioLocalAppOfferView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const dialog = useConfirmDialog()
  const nameId = useId()

  const refresh = useCallback(async () => {
    if (typeof window.api.studioLocalAppsStatus !== 'function') return
    try {
      setStatus(await window.api.studioLocalAppsStatus())
    } catch {
      // Status stays unknown; the section does not render.
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (typeof window.api.onStudioLocalAppsChanged !== 'function') return undefined
    return window.api.onStudioLocalAppsChanged((next) => {
      setStatus(next)
      // A code redeemed or cancelled from anywhere is no longer one to show.
      setMinted((current) => (current && next.offers.some((offer) => offer.id === current.offer.id) ? current : null))
    })
  }, [refresh])

  // Ticks only while a code's expiry is on screen.
  useEffect(() => {
    if (!status?.offers.length) return undefined
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [status?.offers.length])

  if (!status) return null

  const pair = async () => {
    if (!draft) return
    setError(null)
    try {
      const view = await window.api.studioLocalAppsOffer(draft)
      setMinted(view)
      setStatus(view.status)
      setDraft(null)
      setNow(Date.now())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The pairing code could not be made.')
    }
  }

  const revoke = async (id: string, name: string) => {
    const confirmed = await dialog.confirm({
      title: `Revoke ${name}?`,
      body: 'Its token stops working at once, and any connection it has open is closed. Pair it again to let it back in.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!confirmed) return
    setStatus(await window.api.studioLocalAppsRevoke(id))
  }

  const toggleScope = (scope: StudioScope, on: boolean) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            scopes: on ? [...new Set([...current.scopes, scope])] : current.scopes.filter((held) => held !== scope),
          }
        : current,
    )

  const empty = status.apps.length === 0 && status.offers.length === 0
  // Pairing and revoking belong to the Studio serving the socket. Another one
  // on the same profile (a second dev build) would write the same store under
  // it, so here they are shown and not offered.
  const elsewhere = !status.running && status.lastError !== null

  return (
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>Local apps</SettingsSectionTitle>
      <SettingCard>
        {status.apps.map((app) => {
          const seen = app.connected
            ? 'Connected'
            : app.lastSeenAt
              ? `Last seen ${formatRelativeMsAgo(Date.parse(app.lastSeenAt), now)}`
              : 'Not connected yet'
          return (
            <SettingsRow
              key={app.id}
              label={app.name}
              help={`${seen} · chats up to ${PRESET_CHIP_LABEL[app.ceiling]}`}
              stacked
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ScopePillSet ariaLabel={`What ${app.name} may do`}>
                  {app.scopes.map((scope) => (
                    <ScopePill key={scope} scope={scope} />
                  ))}
                </ScopePillSet>
                <GhostButton tone="danger" disabled={!status.running} onClick={() => void revoke(app.id, app.name)}>
                  Revoke
                </GhostButton>
              </div>
            </SettingsRow>
          )
        })}
        {status.offers.map((offer) => (
          <SettingsRow
            key={offer.id}
            label={offer.name}
            help={`Waiting to pair · the code expires ${relativeFromNow(Date.parse(offer.expiresAt), now)}`}
          >
            <GhostButton onClick={() => void window.api.studioLocalAppsCancelOffer(offer.id).then(setStatus)}>
              Cancel
            </GhostButton>
          </SettingsRow>
        ))}
        {empty ? (
          <SettingsRow
            label="No apps are paired"
            help="Scripts and apps built with @sprintengine/agent-sdk can start and drive chats here once paired."
          >
            <span className="text-body text-[color:var(--text-muted)]">{status.running ? 'Ready' : 'Off'}</span>
          </SettingsRow>
        ) : null}
      </SettingCard>

      {minted ? (
        <SettingCard>
          <SettingsRow
            label={`Pairing code for ${minted.offer.name}`}
            help="Give it to the app as its pairing code. It works once, for ten minutes, and is not shown again."
            stacked
          >
            <div className="flex items-center gap-2">
              <span className="break-all font-mono text-meta">{minted.code}</span>
              <CopyGlyphButton text={minted.code} label="Copy the pairing code" />
            </div>
          </SettingsRow>
        </SettingCard>
      ) : null}

      {draft ? (
        <SettingCard>
          <SettingsRow label="Pair an app" help="Name it, and choose what it may do." stacked>
            <div className="space-y-3">
              <Field label="Name" htmlFor={nameId}>
                <Input
                  value={draft.name}
                  placeholder="release-bot"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <DescribedCheckRowList ariaLabel="What the app may do">
                {SCOPE_ROWS.map((row) => (
                  <DescribedCheckRow
                    key={row.scope}
                    id={`local-app-scope-${row.scope}`}
                    title={row.title}
                    code={row.scope}
                    description={row.description}
                    checked={draft.scopes.includes(row.scope)}
                    onChange={(next) => toggleScope(row.scope, next)}
                  />
                ))}
              </DescribedCheckRowList>
              <Field label="Loosest preset its chats may run on">
                <Select
                  ariaLabel="Loosest preset its chats may run on"
                  items={CEILING_ITEMS}
                  value={draft.ceiling}
                  onChange={(ceiling) => setDraft({ ...draft, ceiling })}
                />
              </Field>
              <div className="flex items-center gap-2">
                <PrimaryButton disabled={!draft.name.trim() || draft.scopes.length === 0} onClick={() => void pair()}>
                  Make pairing code
                </PrimaryButton>
                <GhostButton onClick={() => setDraft(null)}>Cancel</GhostButton>
              </div>
            </div>
          </SettingsRow>
        </SettingCard>
      ) : (
        <OutlineButton
          disabled={!status.running}
          onClick={() => {
            setMinted(null)
            setDraft(EMPTY_DRAFT)
          }}
        >
          Pair an app
        </OutlineButton>
      )}

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {status.lastError ? (
        <InlineNotice tone="error">
          {elsewhere
            ? `${status.lastError} Pair and revoke apps from the Studio that is serving it.`
            : status.lastError}
        </InlineNotice>
      ) : null}
    </section>
  )
}
