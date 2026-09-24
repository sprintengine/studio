import React, { useMemo, useState } from 'react'

import {
  emptyExecutionHostSettings,
  type ExecutionHostId,
  type ExecutionHostSettings,
  type ExecutionHostSummary,
} from '../../../../shared/execution-host'
import { useExecutionHosts } from '../../hooks/useExecutionHosts'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WslMachineGlyph } from '../AppIcons'
import CliIcon from '../CliIcon'
import { GhostButton, InlineNotice, Input, ProviderRow, ProviderStateId, Textarea } from '../ui'
import { orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'
import { CliInstallControl } from './CliInstallControl'
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
 * the commands its CLIs run as, the environment every launch there exports,
 * and the shell a plain terminal opens. These replace the per-CLI "run through
 * WSL" switch the Agents tab used to carry.
 */
export function MachinesSettingsTab(): React.JSX.Element {
  const { listing, refresh } = useExecutionHosts({ all: true, refreshOnMount: true })
  const [refreshing, setRefreshing] = useState(false)
  const hostSettings = useWorkspaceStore((s) => s.appSettings.hosts)
  const setHostSettings = useWorkspaceStore((s) => s.setHostSettings)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const clis = useMemo(() => orderInstalledPlugins(pluginCatalogEntries), [pluginCatalogEntries])
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
            stateLine="Always available. Its CLI commands are set on the Agents tab."
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
              >
                <MachineDetail host={host} settings={own} clis={clis} onChange={(patch) => write(host.id, patch)} />
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

function MachineDetail({
  host,
  settings,
  clis,
  onChange,
}: {
  host: ExecutionHostSummary
  settings: ExecutionHostSettings
  clis: ReturnType<typeof orderInstalledPlugins>
  onChange: (patch: Partial<ExecutionHostSettings>) => void
}): React.JSX.Element {
  // The environment is edited as text and written on blur, so a half-typed
  // line is never parsed away under the cursor.
  const [envText, setEnvText] = useState(() => formatEnvLines(settings.env))
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
            onChange={(event) => setEnvText(event.target.value)}
            onBlur={() => onChange({ env: parseEnvLines(envText) })}
            placeholder="NAME=value"
            size="md"
            variant="well"
            rows={3}
            className="font-mono"
          />
        </SettingsRow>
      </div>

      <section className="space-y-2">
        <SettingsSectionTitle count={clis.length}>Agent CLIs on {host.label}</SettingsSectionTitle>
        <div className="divide-y divide-[color:var(--border-subtle)]">
          {clis.map((plugin) => {
            const command = settings.cliCommands[plugin.id] ?? ''
            return (
              <div key={plugin.id} className="space-y-2 py-3">
                <div className="flex items-center gap-2">
                  <CliIcon cli={plugin.id} className="size-icon-md text-[color:var(--text-default)]" />
                  <span className="text-body font-medium text-[color:var(--text-strong)]">{plugin.displayName}</span>
                </div>
                <CliInstallControl
                  cli={plugin.id}
                  displayName={plugin.displayName}
                  binary={plugin.binary}
                  command={command}
                  hostId={host.id}
                  showName={false}
                  onInstalled={(result) => {
                    if (result.resolvedPath && !command) {
                      onChange({ cliCommands: { ...settings.cliCommands, [plugin.id]: result.resolvedPath } })
                    }
                  }}
                />
                <SettingsRow
                  label="Command override"
                  help={
                    <>
                      Runs <span className="font-mono text-[color:var(--text-default)]">{plugin.binary}</span> in{' '}
                      {host.label} when blank.
                    </>
                  }
                  htmlFor={`machine-cli-${host.id}-${plugin.id}`}
                >
                  <Input
                    id={`machine-cli-${host.id}-${plugin.id}`}
                    aria-label={`${plugin.displayName} command override on ${host.label}`}
                    value={command}
                    onChange={(event) => {
                      const next = { ...settings.cliCommands }
                      if (event.target.value) next[plugin.id] = event.target.value
                      else delete next[plugin.id]
                      onChange({ cliCommands: next })
                    }}
                    placeholder={plugin.binary}
                    size="md"
                    variant="well"
                    fullWidth={false}
                    className={ROW_FIELD}
                  />
                </SettingsRow>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
