import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  emptyExecutionHostSettings,
  LOCAL_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostSettings,
  type ExecutionHostSummary,
  type WslChatServerSummary,
} from '../../../../shared/execution-host'
import type { MeshConnection } from '../../../../shared/tailnet-mesh'
import { useExecutionHosts } from '../../hooks/useExecutionHosts'
import { useMachineIdentity } from '../../hooks/useMachineIdentity'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { GhostButton, InlineNotice, Input, OutlineButton, ProviderRow, ProviderStateId, Select, Textarea } from '../ui'
import { MachineMarkPicker, MachineRowMark, machineMarkWords } from './MachineMarkPicker'
import { SettingCard, SettingsPageHeader, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'
import { SshMachinesSection } from './SshMachinesSection'

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

const CHAT_SERVER_ITEMS: Array<{ value: 'off' | 'on'; label: string }> = [
  { value: 'off', label: 'One process per chat' },
  { value: 'on', label: 'A Studio server in the distribution (preview)' },
]

const SERVER_TRANSPORT_ITEMS: Array<{ value: 'auto' | 'stdio'; label: string }> = [
  { value: 'auto', label: 'Loopback, else the bridge' },
  { value: 'stdio', label: 'Always the bridge' },
]

/** How a distribution's Studio server stands, in words (phase 7). */
export function chatServerWords(server: WslChatServerSummary): string {
  if (!server.on) return 'Chats here run one process each, started from Windows.'
  const how = server.transport === 'stdio' ? 'through the stdio bridge' : 'over loopback'
  switch (server.state) {
    case 'ready':
      return `Running, reached ${how}.${server.transport === 'stdio' && server.reason ? ` (${server.reason})` : ''}`
    case 'starting':
      return server.reason ?? 'Starting…'
    case 'unavailable':
    case 'shut-down':
      return server.reason ?? 'Not running.'
    default:
      return 'Starts with the first chat here, and stops after ten minutes with nothing to do.'
  }
}

/** This computer's own row, by the platform it runs. */
function thisComputerLabel(platform: string | undefined): string {
  return platform === 'win32' ? 'This PC (Windows)' : platform === 'darwin' ? 'This Mac' : 'This computer'
}

/**
 * Settings ▸ Machines: the machines a workspace can run on. On every
 * platform, the SSH machines a person added (phase 8). On Windows, also the
 * machines on this computer This PC always is; each WSL distribution becomes one
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
            name={thisComputerLabel(window.api?.platform)}
            stateLine="Always available."
            actions={
              <AgentClisLink
                hostId={LOCAL_HOST_ID}
                label={thisComputerLabel(window.api?.platform)}
                onShow={onShowAgentClis}
              />
            }
          />
          {wslHosts.map((host) => {
            const own = settingsOf(host.id)
            const isOpen = expanded === host.id
            return (
              <ProviderRow
                key={host.id}
                as="li"
                surface="card"
                icon={<MachineRowMark machine={{ kind: 'wsl', hostId: host.id }} />}
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
                  <>
                    <MachineMarkPicker machine={{ kind: 'wsl', hostId: host.id }} name={host.label} />
                    {own.enabled ? (
                      <AgentClisLink hostId={host.id} label={host.label} onShow={onShowAgentClis} />
                    ) : null}
                  </>
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

      {window.api?.sshMachinesEnabled ? <SshMachinesSection /> : null}

      <PairedMachinesSection />
    </div>
  )
}

/**
 * The machines this one is paired with over the tailnet, for their kind and
 * colour (owner ruling 2026-10-04). Pairing itself — and forgetting a pairing —
 * stays in Settings › Remote; this list is here so every machine's mark is
 * changed in one place. Absent while nothing is paired.
 */
function PairedMachinesSection(): React.JSX.Element | null {
  const [machines, setMachines] = useState<MeshConnection[]>([])
  useEffect(() => {
    if (typeof window.api?.meshListConnections !== 'function') return
    let cancelled = false
    const load = (): void => {
      void window.api
        .meshListConnections()
        .then((connections) => {
          if (!cancelled) setMachines(Array.isArray(connections) ? connections : [])
        })
        .catch(() => undefined)
    }
    load()
    const off =
      typeof window.api.onMeshEvent === 'function'
        ? window.api.onMeshEvent((event) => {
            if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') load()
          })
        : null
    return () => {
      cancelled = true
      off?.()
    }
  }, [])
  if (machines.length === 0) return null
  return (
    <section className="space-y-2">
      <SettingsSectionTitle count={machines.length}>Paired machines</SettingsSectionTitle>
      <SettingCard as="ul" ariaLabel="Paired machines">
        {machines.map((machine) => (
          <PairedMachineRow key={machine.id} machine={machine} />
        ))}
      </SettingCard>
    </section>
  )
}

function PairedMachineRow({ machine }: { machine: MeshConnection }): React.JSX.Element {
  const ref = React.useMemo(() => ({ kind: 'paired' as const, name: machine.machineName }), [machine.machineName])
  const identity = useMachineIdentity(ref)
  return (
    <ProviderRow
      as="li"
      surface="card"
      icon={<MachineRowMark machine={ref} />}
      name={machine.machineName}
      stateLine={identity ? `Paired · ${machineMarkWords(identity)}` : 'Paired'}
      actions={<MachineMarkPicker machine={ref} name={machine.machineName} />}
    />
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
        {host.chatServer ? (
          <ChatServerRows host={host} server={host.chatServer} settings={settings} onChange={onChange} />
        ) : null}
      </div>
    </div>
  )
}

function ChatServerRows({
  host,
  server,
  settings,
  onChange,
}: {
  host: ExecutionHostSummary
  server: WslChatServerSummary
  settings: ExecutionHostSettings
  onChange: (patch: Partial<ExecutionHostSettings>) => void
}): React.JSX.Element {
  return (
    <>
      <SettingsRow
        label="Chats run in"
        help="A server inside the distribution runs its agents, git and files natively. A chat already running stays where it started."
      >
        <Select
          ariaLabel={`Where chats in ${host.label} run`}
          items={CHAT_SERVER_ITEMS}
          value={server.on ? 'on' : 'off'}
          disabled={host.wslVersion === 1}
          onChange={(value) => onChange({ chatServer: value })}
        />
      </SettingsRow>
      {server.on ? (
        <SettingsRow label="Studio server" help={chatServerWords(server)}>
          <Select
            ariaLabel={`How Windows reaches the Studio server in ${host.label}`}
            items={SERVER_TRANSPORT_ITEMS}
            value={settings.serverTransport ?? 'auto'}
            onChange={(value) => onChange({ serverTransport: value })}
          />
        </SettingsRow>
      ) : null}
    </>
  )
}
