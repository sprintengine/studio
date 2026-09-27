import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  emptyExecutionHostSettings,
  LOCAL_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostSettings,
  type ExecutionHostSummary,
} from '../../../../shared/execution-host'
import { useExecutionHosts } from '../../hooks/useExecutionHosts'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WslMachineGlyph } from '../AppIcons'
import { GhostButton, InlineNotice, Input, OutlineButton, ProviderRow, ProviderStateId, Textarea } from '../ui'
import { SettingCard, SettingsPageHeader, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

const ROW_FIELD = 'w-60 max-w-full font-mono'

/** `NAME=value` per line, the way a person writes an environment; blank lines and `#` comments skipped. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const name = line.slice(0, equals).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) env[name] = line.slice(equals + 1)
  }
  return env
}

export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')
}

/** The state line for a WSL machine, in words. */
export function machineStateWords(host: ExecutionHostSummary): string {
  const lead =
    host.state === 'ready'
      ? 'Running'
      : host.state === 'stopped'
        ? 'Stopped — starts when a workspace on it needs it'
        : host.state === 'starting'
          ? (host.reason ?? 'Starting')
          : (host.reason ?? 'Unavailable')
  const version = host.wslVersion ? ` · WSL ${host.wslVersion}` : ''
  return `${lead}${version}`
}

/**
 * Settings ▸ Machines (Windows only): the machines on this computer a
 * workspace can run on. This PC always is; each WSL distribution becomes one
 * when it is turned on here, and then appears in the New chat machine
 * dropdown as "WSL: <name>". A workspace whose folder is inside a
 * distribution runs there whether or not it is turned on — the switch only
 * decides what new chats are offered.
 *
 * Each distribution keeps its own settings, because it is its own machine:
 * the environment every launch there exports and the shell a plain terminal
 * opens. Its agent CLIs — which are installed, the command each runs as, and
 * installing one — are on the Agents tab with this machine picked there, which
 * each row's "Agent CLIs on this machine" opens (owner ruling 2026-09-24): one
 * list of CLIs with a machine switcher, rather than a second list here that
 * never said how it differed from the first.
 */
export function MachinesSettingsTab({
  onShowAgentClis,
}: {
  /** Open Settings ▸ Agents with this machine picked. */
  onShowAgentClis?: (id: ExecutionHostId) => void
} = {}): React.JSX.Element {
  const { listing, refresh } = useExecutionHosts({ all: true, refreshOnMount: true })
  const [refreshing, setRefreshing] = useState(false)
  const hostSettings = useWorkspaceStore((s) => s.appSettings.hosts)
  const setHostSettings = useWorkspaceStore((s) => s.setHostSettings)
  const [expanded, setExpanded] = useState<ExecutionHostId | null>(null)

  const wslHosts = (listing?.hosts ?? []).filter((host) => host.kind === 'wsl')
  const settingsOf = (id: ExecutionHostId): ExecutionHostSettings => hostSettings?.[id] ?? emptyExecutionHostSettings()
  const write = (id: ExecutionHostId, patch: Partial<ExecutionHostSettings>): void => {
    setHostSettings(id, { ...settingsOf(id), ...patch })
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Machines"
        actions={
          <GhostButton
            size="md"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              void refresh().finally(() => setRefreshing(false))
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </GhostButton>
        }
      />

      {listing?.wsl && !listing.wsl.available ? (
        <InlineNotice tone="warn" title="WSL did not answer." hint={listing.wsl.reason} />
      ) : null}

      <section className="space-y-2">
        <SettingsSectionTitle count={listing ? wslHosts.length + 1 : undefined}>On this computer</SettingsSectionTitle>
        <SettingCard as="ul" ariaLabel="Machines on this computer">
          <ProviderRow
            as="li"
            surface="card"
            icon={<span aria-hidden="true" className="size-icon-lg" />}
            name="This PC (Windows)"
            stateLine="Always available."
            actions={<AgentClisLink hostId={LOCAL_HOST_ID} label="This PC (Windows)" onShow={onShowAgentClis} />}
          />
          {wslHosts.map((host) => {
            const own = settingsOf(host.id)
            const isOpen = expanded === host.id
            return (
              <ProviderRow
                key={host.id}
                as="li"
                surface="card"
                icon={<WslMachineGlyph className="size-icon-lg text-[color:var(--text-default)]" />}
                recessed={host.state === 'unavailable'}
                name={host.label}
                version={host.isDefaultDistro ? 'default' : null}
                stateLine={machineStateWords(host)}
                enabled={own.enabled}
                onEnabledChange={(enabled) => write(host.id, { enabled })}
                expanded={isOpen}
                onExpandedChange={(next) => setExpanded(next ? host.id : null)}
                // Only a machine that is on is one the Agents tab offers, so
                // only its row can open it there.
                actions={
                  own.enabled ? <AgentClisLink hostId={host.id} label={host.label} onShow={onShowAgentClis} /> : null
                }
              >
                <MachineDetail host={host} settings={own} onChange={(patch) => write(host.id, patch)} />
              </ProviderRow>
            )
          })}
        </SettingCard>
        {listing?.wsl?.available && wslHosts.length === 0 ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            No WSL distributions are installed. Install one with <ProviderStateId>wsl --install</ProviderStateId>.
          </p>
        ) : null}
      </section>
    </div>
  )
}

// How long the environment field waits after the last keystroke before it
// writes: long enough not to send main a patch per character.
const ENV_COMMIT_DELAY_MS = 600

function AgentClisLink({
  hostId,
  label,
  onShow,
}: {
  hostId: ExecutionHostId
  label: string
  onShow?: (id: ExecutionHostId) => void
}): React.JSX.Element | null {
  if (!onShow) return null
  // The visible words lead the accessible name, so a person who says what they
  // see reaches it by voice; the machine follows, so a list of these is not a
  // list of identical buttons.
  return (
    <OutlineButton size="xs" aria-label={`Agent CLIs on this machine, ${label}`} onClick={() => onShow(hostId)}>
      Agent CLIs on this machine
    </OutlineButton>
  )
}

function MachineDetail({
  host,
  settings,
  onChange,
}: {
  host: ExecutionHostSummary
  settings: ExecutionHostSettings
  onChange: (patch: Partial<ExecutionHostSettings>) => void
}): React.JSX.Element {
  // The environment is edited as text and parsed only when it is written, so
  // a half-typed line is never parsed away under the cursor. It is written a
  // moment after typing stops, on blur, and when the panel goes away: closing
  // Settings with Escape unmounts the field without a blur, and the edit used
  // to go with it.
  const [envText, setEnvText] = useState(() => formatEnvLines(settings.env))
  const latest = useRef({ envText, env: settings.env, onChange })
  latest.current = { envText, env: settings.env, onChange }
  const envTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitEnv = useCallback(() => {
    if (envTimer.current !== null) {
      clearTimeout(envTimer.current)
      envTimer.current = null
    }
    const current = latest.current
    const env = parseEnvLines(current.envText)
    // Unchanged is not a write: an unmount after no edit leaves main alone.
    if (formatEnvLines(env) === formatEnvLines(current.env)) return
    current.onChange({ env })
  }, [])
  useEffect(() => commitEnv, [commitEnv])
  return (
    <div className="space-y-4">
      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingsRow
          label="Shell"
          help="The shell a plain terminal opens, and the one an agent's tab ends in."
          htmlFor={`machine-shell-${host.id}`}
        >
          <Input
            id={`machine-shell-${host.id}`}
            aria-label={`${host.label} shell`}
            value={settings.shell ?? ''}
            onChange={(event) => onChange({ shell: event.target.value.trim() ? event.target.value : undefined })}
            placeholder="bash -li"
            size="md"
            variant="well"
            fullWidth={false}
            className={ROW_FIELD}
          />
        </SettingsRow>
        <SettingsRow
          label="Environment"
          help="Exported into every terminal and agent on this machine. One NAME=value per line."
          htmlFor={`machine-env-${host.id}`}
          stacked
        >
          <Textarea
            id={`machine-env-${host.id}`}
            aria-label={`${host.label} environment`}
            value={envText}
            onChange={(event) => {
              const text = event.target.value
              latest.current.envText = text
              setEnvText(text)
              if (envTimer.current !== null) clearTimeout(envTimer.current)
              envTimer.current = setTimeout(commitEnv, ENV_COMMIT_DELAY_MS)
            }}
            onBlur={commitEnv}
            placeholder="NAME=value"
            size="md"
            variant="well"
            rows={3}
            className="font-mono"
          />
        </SettingsRow>
      </div>
    </div>
  )
}
