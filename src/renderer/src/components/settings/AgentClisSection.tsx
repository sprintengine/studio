import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { DiscoveredCliModelCatalog } from '../../../../shared/cli-model-catalog'
import type { AgentCliAvailabilityMap } from '../../../../shared/electron-api'
import {
  emptyExecutionHostSettings,
  isWslHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from '../../../../shared/execution-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import CliIcon from '../CliIcon'
import {
  CliProviderStateLine,
  EmptyState,
  GhostButton,
  InlineNotice,
  Input,
  OutlineButton,
  PrimaryButton,
  ProviderRow,
  resolveCliProviderState,
  SegmentedControl,
  Spinner,
} from '../ui'
import { cliRuntimeForPlugin, orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'
import { orderInstalledFirst, type AgentsMachine, type MachineCliAvailability } from './agentsMachine'
import { CliInstallControl } from './CliInstallControl'
import { modelDiscoveryLine } from './modelDiscoveryLine'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Row inputs hold an identifier (a command, a model id, a key), so they are
// mono; sized to the standard 240px row measure rather than stretched to the
// panel. `fullWidth={false}` goes with it because Tailwind resolves two width
// utilities by stylesheet order, not string order.
const MONO_FIELD = 'font-mono'
const ROW_FIELD = 'w-60 max-w-full font-mono'
const EMPTY_USER_MODELS: string[] = []
const NO_AVAILABILITY: AgentCliAvailabilityMap = {}

const MACHINE_HELP_ID = 'settings-agents-machine-help'

/**
 * The machine switcher at the top of Settings ▸ Agents: the same segmented
 * control as General's update channel, because it is the same kind of choice —
 * one of a few named options, all worth seeing at once (owner ruling
 * 2026-09-24). Nothing at all with one machine, so macOS, Linux and a Windows
 * PC with no distribution turned on draw the tab exactly as before. Past two
 * machines the labels outgrow the row, so the control drops under its label
 * rather than squeezing it.
 */
export function AgentsMachineSwitcher({
  machines,
  value,
  onChange,
}: {
  machines: readonly AgentsMachine[]
  value: ExecutionHostId
  onChange: (id: ExecutionHostId) => void
}): React.JSX.Element | null {
  if (machines.length < 2) return null
  return (
    <SettingCard>
      <SettingsRow
        label="Machine"
        help="Whose agent CLIs are listed below."
        helpId={MACHINE_HELP_ID}
        stacked={machines.length > 2}
      >
        <SegmentedControl<ExecutionHostId>
          ariaLabel="Machine"
          ariaDescribedBy={MACHINE_HELP_ID}
          items={machines.map((machine) => ({ value: machine.id, label: machine.label }))}
          value={value}
          onChange={onChange}
        />
      </SettingsRow>
    </SettingCard>
  )
}

/**
 * Settings ▸ Agents' list of agent CLIs, for one machine.
 *
 * This machine's list is the one it always was: the store's availability, its
 * version advisories and Update, the command on `cliRuntimes`, and the
 * CLI-wide settings (model list, custom model ids, API key). A WSL machine's
 * list is that machine's own: its probe, its command overrides
 * (`hosts[id].cliCommands`), and install bound to it — the controls that sat
 * under each distribution on the Machines tab until 2026-09-24. The CLI-wide
 * settings are not repeated under it: they are not the machine's, and drawing
 * them there would say they were.
 */
export function AgentClisSection({
  machine,
  machineAvailability,
  onMachineRecheck,
  showMachine,
  now,
}: {
  machine: AgentsMachine
  /** The WSL machine's probe; null for this machine, whose answer is the store's. */
  machineAvailability: MachineCliAvailability | null
  onMachineRecheck: () => void
  /** A switcher is on screen, so a state line names the machine it found the CLI on. */
  showMachine: boolean
  now: number
}): React.JSX.Element {
  const wsl = isWslHostId(machine.id) ? machine.id : null
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const hostSettings = useWorkspaceStore((s) => (wsl ? s.appSettings.hosts?.[wsl] : undefined))
  const setHostSettings = useWorkspaceStore((s) => s.setHostSettings)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  // Detection map shared with the deployment pickers — drives the at-a-glance
  // status on every CLI row without a per-row probe.
  const localAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const localAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const localAvailabilityError = useWorkspaceStore((s) => s.cliAvailabilityError)
  // Installed version against the registry's newest, per CLI. Main computes it
  // hourly and on Re-check, for this machine.
  const cliVersionAdvisories = useWorkspaceStore((s) => s.cliVersionAdvisories)
  const refreshCliVersionAdvisories = useWorkspaceStore((s) => s.refreshCliVersionAdvisories)
  const checkCliVersions = useWorkspaceStore((s) => s.checkCliVersions)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const forgetCliModels = useWorkspaceStore((s) => s.forgetCliModels)
  const setCliModelCatalog = useWorkspaceStore((s) => s.setCliModelCatalog)
  const installedPluginRows = useMemo(() => orderInstalledPlugins(pluginCatalogEntries), [pluginCatalogEntries])

  const cliAvailability = wsl ? (machineAvailability?.map ?? NO_AVAILABILITY) : localAvailability
  const cliAvailabilityStatus = wsl ? (machineAvailability?.status ?? 'loading') : localAvailabilityStatus
  const cliAvailabilityError = wsl ? (machineAvailability?.error ?? null) : localAvailabilityError
  const ownSettings: ExecutionHostSettings = hostSettings ?? emptyExecutionHostSettings()
  const writeHostCommands = (cliCommands: Record<string, string>): void => {
    if (wsl) setHostSettings(wsl, { ...ownSettings, cliCommands })
  }

  // The last Refresh: whether one is running, and why each CLI's probe failed.
  // A failed probe keeps the last good list (the answer carries no catalog for
  // it), so only the line changes.
  const [modelRefresh, setModelRefresh] = useState<{ running: boolean; errors: Record<string, string> }>({
    running: false,
    errors: {},
  })
  const refreshCliModels = useCallback(async () => {
    const api = typeof window === 'undefined' ? null : window.api
    if (typeof api?.cliModelsDiscover !== 'function') return
    setModelRefresh((current) => ({ ...current, running: true }))
    try {
      const result = await api.cliModelsDiscover({
        force: true,
        cliRuntimes,
        previous: useWorkspaceStore.getState().appSettings.cliModelCatalog,
      })
      const errors: Record<string, string> = {}
      for (const entry of result.entries) {
        if (entry.catalog) setCliModelCatalog(entry.cli, entry.catalog)
        if (entry.error) errors[entry.cli] = entry.error
      }
      setModelRefresh({ running: false, errors })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const errors: Record<string, string> = {}
      for (const plugin of pluginCatalogEntries) errors[plugin.id] = message
      setModelRefresh({ running: false, errors })
    }
  }, [cliRuntimes, pluginCatalogEntries, setCliModelCatalog])

  // Per-CLI Update runs (the version advisory's button). `running` while the
  // command is in flight; afterwards the notice says what happened when the
  // version did not move or the command failed. A clean success needs no
  // notice: the row's version changes and the advisory goes away.
  const [cliUpdateRuns, setCliUpdateRuns] = useState<
    Record<string, { running: boolean; notice: { tone: 'warn' | 'error'; text: string } | null }>
  >({})
  const runCliUpdate = useCallback(
    async (cli: AgentCli) => {
      const api = window.api
      if (typeof api.cliUpdate !== 'function') return
      const runtime = cliRuntimeForPlugin(cli, cliRuntimes)
      const before = localAvailability[cli]?.version ?? null
      setCliUpdateRuns((prev) => ({ ...prev, [cli]: { running: true, notice: null } }))
      let notice: { tone: 'warn' | 'error'; text: string } | null = null
      try {
        const result = await api.cliUpdate(cli, runtime)
        if (!result.ok) {
          notice = { tone: 'error', text: result.error ?? 'The update did not finish.' }
        } else if (result.version && before && result.version.trim() === before.trim()) {
          notice = {
            tone: 'warn',
            text: `The update finished but the version is still ${before}. Run it in a terminal to see why.`,
          }
        }
      } catch (error) {
        notice = { tone: 'error', text: error instanceof Error ? error.message : String(error) }
      }
      setCliUpdateRuns((prev) => ({ ...prev, [cli]: { running: false, notice } }))
      await refreshCliAvailability({ force: true, cliRuntimes })
      void refreshCliVersionAdvisories({ force: true, cliRuntimes })
    },
    [localAvailability, cliRuntimes, refreshCliAvailability, refreshCliVersionAdvisories],
  )

  // The CLI row whose detail is open (null = none). `installIntentId` marks a
  // row whose Install button was pressed, so its detail opens straight into the
  // install flow. Both belong to the machine they were opened on: switching
  // machines closes them rather than opening the same CLI on another machine.
  const [selectedCliId, setSelectedCliId] = useState<string | null>(null)
  const [installIntentId, setInstallIntentId] = useState<string | null>(null)
  useEffect(() => {
    setSelectedCliId(null)
    setInstallIntentId(null)
  }, [machine.id])

  // Installed first, then what this machine does not have — dimmed below it.
  const rows = useMemo(
    () =>
      orderInstalledFirst(
        installedPluginRows.map((plugin) => ({
          plugin,
          state: resolveCliProviderState(cliAvailability[plugin.id], cliAvailabilityStatus),
        })),
        (row) => row.state.health === 'missing',
      ),
    [installedPluginRows, cliAvailability, cliAvailabilityStatus],
  )

  return (
    <>
      {/* The batch availability probe failing is a different fact from a
          plugin registry failure, and until now it was surfaced nowhere at
          all: every row simply read "Not found". */}
      {cliAvailabilityStatus === 'error' && cliAvailabilityError ? (
        <InlineNotice tone="warn">
          {`Agent CLIs could not be checked${showMachine ? ` on ${machine.label}` : ''}: ${cliAvailabilityError}`}
        </InlineNotice>
      ) : null}

      {pluginCatalogStatus === 'loading' && installedPluginRows.length === 0 ? (
        <p className="text-body leading-5 text-[color:var(--text-muted)]">Loading…</p>
      ) : pluginCatalogStatus === 'error' ? (
        // The failure carries its own recovery, per the notice contract —
        // a Retry parked below the message is a dead end with a button.
        <InlineNotice
          tone="error"
          title="The plugin registry could not be loaded."
          hint={pluginCatalogError ?? undefined}
          action={
            <OutlineButton size="md" onClick={() => void refreshPluginCatalog()}>
              Retry
            </OutlineButton>
          }
        />
      ) : installedPluginRows.length === 0 ? (
        <EmptyState
          density="list"
          title="No agent plugins are installed."
          action={
            <OutlineButton size="md" onClick={() => void refreshPluginCatalog()}>
              Refresh
            </OutlineButton>
          }
        />
      ) : (
        // The list card (setting-row → The list card, 2026-09-15): the
        // section band with the count outside, one bordered surface, the
        // rows full-bleed inside it — the shape the Remote tab's machines
        // drew first.
        <section className="space-y-2">
          <SettingsSectionTitle count={installedPluginRows.length}>Agent CLIs</SettingsSectionTitle>
          <SettingCard as="ul" ariaLabel={showMachine ? `Agent CLIs on ${machine.label}` : 'Agent CLIs'}>
            {rows.map(({ plugin, state }) => {
              const localCommand = cliRuntimeForPlugin(plugin.id, cliRuntimes).command
              const command = wsl ? (ownSettings.cliCommands[plugin.id] ?? '') : localCommand
              const declaredModels = plugin.modelSelection?.options ?? []
              // What the picker offers before the user's own ids: the CLI's
              // own list once it has answered, else the manifest seed
              // (cliRuntimeOptions.mergeModelCatalog).
              const discoveredCatalog = cliModelCatalog?.[plugin.id]
              const discoveredModels = discoveredCatalog?.models ?? []
              const listedModels =
                discoveredModels.length > 0
                  ? discoveredModels.map((model) => ({ id: model.id, label: model.displayName }))
                  : declaredModels
              const allowCustomModels = Boolean(plugin.modelSelection?.allowCustomId)
              const userModels = cliRuntimes?.[plugin.id]?.models ?? EMPTY_USER_MODELS
              // The registry advisory is this machine's: main compares the
              // version its own probe found, so a WSL machine's row has none.
              const advisory = checkCliVersions && !wsl ? cliVersionAdvisories[plugin.id] : undefined
              const behind = state.installed && advisory?.status === 'behind_latest' && !!advisory.latestVersion
              const updateRun = wsl ? undefined : cliUpdateRuns[plugin.id]
              const commandFieldId = wsl ? `machine-cli-${wsl}-${plugin.id}` : `cli-command-${plugin.id}`
              return (
                <ProviderRow
                  key={plugin.id}
                  as="li"
                  surface="card"
                  icon={<CliIcon cli={plugin.id} className="size-icon-lg text-[color:var(--text-default)]" />}
                  // No health dot here either, and for the same reason it
                  // left the Agent CLIs catalogue (owner, 2026-09-10): this
                  // is the same list of CLIs, and nine identical green dots
                  // down a column is a status idiom spent on a fact nobody
                  // is scanning for. What a person is scanning for is the
                  // one row that is behind — so that is what the mark says.
                  badge={
                    behind
                      ? {
                          count: 1,
                          label: `${plugin.displayName} — update available: ${advisory.latestVersion}`,
                        }
                      : null
                  }
                  // A CLI this machine does not have recedes, and sits below
                  // every one it does, so the list reads as what is here
                  // first. Only a DEFINITIVE absence: a probe that never
                  // answered is not absence, and must not push a
                  // likely-installed CLI into the background.
                  recessed={state.health === 'missing'}
                  name={plugin.displayName}
                  version={state.version}
                  stateLine={
                    <>
                      <CliProviderStateLine
                        state={state}
                        binary={plugin.binary}
                        machineLabel={showMachine && wsl ? machine.label : null}
                        // Deliberately not the reason: a failed batch probe
                        // wipes every entry, so the reason is one fact for the
                        // whole list and the section states it once above the
                        // list rather than nine times down the rows.
                        probeError={null}
                      />
                      {/* Provenance, only where it distinguishes: a plugin
                        the user installed from a folder is the one this list
                        cannot otherwise explain. */}
                      {plugin.source === 'bundled' ? null : ' · installed from a folder'}
                      {/* The version advisory: the newest the registry
                        publishes. Nothing here for a CLI that is current or
                        unknown. */}
                      {behind ? (
                        <>
                          {' · '}
                          <span className="font-mono text-[color:var(--text-default)]">{advisory.latestVersion}</span>
                          {updateRun?.running ? ' installing…' : ' available'}
                        </>
                      ) : null}
                    </>
                  }
                  expanded={selectedCliId === plugin.id}
                  onExpandedChange={(next) => {
                    setInstallIntentId(null)
                    setSelectedCliId(next ? plugin.id : null)
                  }}
                  // Install is offered only on a definitive negative probe. A
                  // CLI whose probe never completed may well be installed, so
                  // offering to install it would be a fake affordance — those
                  // rows say so on their state line and route to Re-check.
                  actions={
                    state.health === 'missing' ? (
                      <PrimaryButton
                        size="xs"
                        onClick={() => {
                          setInstallIntentId(plugin.id)
                          setSelectedCliId(plugin.id)
                        }}
                      >
                        Install
                      </PrimaryButton>
                    ) : behind ? (
                      <PrimaryButton
                        size="xs"
                        disabled={updateRun?.running === true}
                        onClick={() => void runCliUpdate(plugin.id)}
                      >
                        {updateRun?.running ? <Spinner className="icon-sm" /> : null}
                        Update
                      </PrimaryButton>
                    ) : null
                  }
                >
                  {/* The per-instance form, in place: the install/detect
                    control, then how this CLI runs. The row above already
                    carries name, version, and state, so the control drops
                    its own name and status line rather than saying it
                    twice. */}
                  {updateRun?.notice ? (
                    <InlineNotice
                      tone={updateRun.notice.tone}
                      title={`${plugin.displayName} did not update.`}
                      hint={updateRun.notice.text}
                    >
                      {advisory?.updateCommand ? (
                        <span className="font-mono text-[color:var(--text-default)]">
                          {advisory.updateCommand.command}
                        </span>
                      ) : null}
                    </InlineNotice>
                  ) : null}
                  <CliInstallControl
                    cli={plugin.id}
                    displayName={plugin.displayName}
                    binary={plugin.binary}
                    command={command}
                    {...(wsl ? { hostId: wsl } : {})}
                    showName={false}
                    showStatus={false}
                    autoOpenInstall={installIntentId === plugin.id}
                    onInstalled={(result) => {
                      if (wsl) {
                        if (result.resolvedPath && !command) {
                          writeHostCommands({ ...ownSettings.cliCommands, [plugin.id]: result.resolvedPath })
                        }
                        onMachineRecheck()
                        return
                      }
                      if (result.resolvedPath && !localCommand) {
                        setCliRuntime(plugin.id, { command: result.resolvedPath })
                      }
                      void refreshPluginCatalog()
                      // Force-refresh availability so the freshly installed CLI
                      // shows as detected on its row and in deployment pickers.
                      void refreshCliAvailability({ force: true, cliRuntimes })
                    }}
                  />

                  {!wsl && listedModels.length > 0 ? (
                    <div className="flex gap-2 text-body leading-5">
                      <span className="shrink-0 text-[color:var(--text-muted)]">Models</span>
                      <span className="min-w-0 font-mono text-[color:var(--text-default)]">
                        {listedModels.map((model) => model.label ?? model.id).join(' · ')}
                      </span>
                    </div>
                  ) : null}

                  <div className="mt-2 divide-y divide-[color:var(--border-subtle)]">
                    {!wsl && plugin.modelSelection ? (
                      <CliModelsRow
                        name={plugin.displayName}
                        catalog={discoveredCatalog}
                        error={modelRefresh.errors[plugin.id] ?? null}
                        now={now}
                        refreshing={modelRefresh.running}
                        onRefresh={() => void refreshCliModels()}
                      />
                    ) : null}
                    <SettingsRow
                      label="Command override"
                      help={
                        <>
                          Runs <span className="font-mono text-[color:var(--text-default)]">{plugin.binary}</span>
                          {wsl ? ` in ${machine.label}` : ''} when blank.
                        </>
                      }
                      htmlFor={commandFieldId}
                    >
                      <Input
                        id={commandFieldId}
                        // Per-plugin accessible name so screen readers don't announce an
                        // identical "Command override" for every CLI.
                        aria-label={
                          wsl
                            ? `${plugin.displayName} command override on ${machine.label}`
                            : `${plugin.displayName} command override`
                        }
                        value={command}
                        onChange={(event) => {
                          if (!wsl) {
                            setCliRuntime(plugin.id, { command: event.target.value })
                            return
                          }
                          const next = { ...ownSettings.cliCommands }
                          if (event.target.value) next[plugin.id] = event.target.value
                          else delete next[plugin.id]
                          writeHostCommands(next)
                        }}
                        placeholder={plugin.binary}
                        size="md"
                        variant="well"
                        fullWidth={false}
                        className={ROW_FIELD}
                      />
                    </SettingsRow>

                    {!wsl && allowCustomModels ? (
                      <PluginModelSettings
                        displayName={plugin.displayName}
                        userModels={userModels}
                        onUserModelsChange={(models) => {
                          setCliRuntime(plugin.id, { models })
                          // Retiring an id must also retire it as a remembered
                          // launch default, or every spawn surface that named
                          // it keeps passing `--model <deleted id>` and the
                          // agent dies on a model nothing offers. Only ids the
                          // picker no longer lists are forgotten: an id the
                          // CLI reported (or, before it has, the manifest
                          // seeds) is still a real model, and the user only
                          // removed their own copy.
                          const remaining = new Set(models)
                          const stillOffered = new Set(listedModels.map((option) => option.id))
                          const retired = userModels.filter((id) => !remaining.has(id) && !stillOffered.has(id))
                          if (retired.length > 0) forgetCliModels(plugin.id, retired)
                        }}
                      />
                    ) : null}

                    {!wsl && plugin.auth ? (
                      <CliCredentialRow
                        pluginId={plugin.id}
                        displayName={plugin.displayName}
                        label={plugin.auth.label}
                      />
                    ) : null}
                  </div>
                </ProviderRow>
              )
            })}
          </SettingCard>
        </section>
      )}
    </>
  )
}

// One CLI's model list: where the rows in its picker came from, with the one
// manual trigger. The words come from modelDiscoveryLine; the clock is the
// band's, so "checked 2m ago" ages with it. Refresh re-asks every installed CLI
// past the freshness window, and the answer replaces each CLI's list.
function CliModelsRow({
  name,
  catalog,
  error,
  now,
  refreshing,
  onRefresh,
}: {
  name: string
  catalog: DiscoveredCliModelCatalog | undefined
  error: string | null
  now: number
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <SettingsRow label="Model list" help={modelDiscoveryLine({ name, catalog, error, now })}>
      <OutlineButton size="xs" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? <Spinner className="icon-sm" /> : null}
        Refresh
      </OutlineButton>
    </SettingsRow>
  )
}

// API-key entry for a CLI whose manifest declares `auth` (e.g. Z.AI). Reads and
// writes through the shared credential store via the generic `credentialSecret*`
// IPC — the same store the chat Providers tab uses. Mirrors the Providers tab's
// masked/save/remove pattern; the value is write-only and never read back.
function CliCredentialRow({ pluginId, displayName, label }: { pluginId: string; displayName: string; label: string }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.api.credentialSecretStatus>> | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.credentialSecretStatus({ id: pluginId }).then((result) => {
      if (active) setStatus(result)
    })
    return () => {
      active = false
    }
  }, [pluginId])

  const configured = status?.ok === true && status.status.configured
  const source = status?.ok === true ? status.status.source : 'none'
  const persistence = status?.ok === true ? status.status.persistence : 'encrypted'
  // Environment-sourced keys are owned outside the app; don't offer Remove.
  const canClear = configured && source !== 'environment'
  const inputId = `cli-credential-${pluginId}`

  const save = async (): Promise<void> => {
    const value = draft.trim()
    if (!value || busy) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentialSecretSet({ id: pluginId, value })
    setBusy(false)
    if (result.ok) {
      setStatus(result)
      setDraft('')
      setMessage('API key saved.')
    } else {
      setMessage(result.message)
    }
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentialSecretClear({ id: pluginId })
    setBusy(false)
    if (result.ok) {
      setStatus(result)
      setMessage('API key removed.')
    } else {
      setMessage(result.message)
    }
  }

  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="text-body font-medium text-[color:var(--text-strong)]">{label}</div>
      <div className="mt-2 space-y-1.5">
        {configured ? (
          <div className="flex items-center gap-2">
            {/* The saved key is shown as the field it will be edited in, read-only
                — not as a div wearing a copy of the field's chrome. The value IS
                the mask, so the accessible name says what the dots mean. */}
            <Input
              readOnly
              value="••••••••••••"
              aria-label={`${displayName} API key is saved`}
              size="md"
              variant="well"
              fullWidth={false}
              className="min-w-0 flex-1 tracking-[0.3em] text-[color:var(--text-muted)]"
            />
            {canClear ? (
              <GhostButton size="md" onClick={() => void clear()} disabled={busy} className="shrink-0">
                {busy ? 'Removing…' : 'Remove'}
              </GhostButton>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              {displayName} API key
            </label>
            <Input
              id={inputId}
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void save()
                }
              }}
              placeholder="Paste API key"
              autoComplete="off"
              disabled={busy}
              size="md"
              variant="well"
              fullWidth={false}
              className={`min-w-0 flex-1 ${MONO_FIELD}`}
            />
            <PrimaryButton size="md" onClick={() => void save()} disabled={busy || !draft.trim()} className="shrink-0">
              {busy ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
        )}
        {configured && source === 'environment' ? (
          <p className="text-meta leading-5 text-[color:var(--text-subtle)]">
            Set from the environment. Remove it there to change it.
          </p>
        ) : configured && persistence === 'session' ? (
          <p className="text-meta leading-5 text-[color:var(--tone-warn)]">
            Stored for this session only — clears when the app quits.
          </p>
        ) : null}
        <div aria-live="polite" className="text-meta leading-5 text-[color:var(--text-muted)] empty:hidden">
          {message}
        </div>
      </div>
    </div>
  )
}

// Per-plugin custom model ids. The studio does not persist an app-level default
// model (the CLI's own default is used when no per-surface override is set), so
// this is purely the user-extended id list. Rendered only when the plugin
// declares modelSelection with `allowCustomId` — without declared launch args a
// model could not be passed, and terminal CLIs expose no live model catalog, so
// this list is how new models are adopted between plugin updates. Rendered
// inline inside the per-plugin configuration disclosure.
function PluginModelSettings({
  displayName,
  userModels,
  onUserModelsChange,
}: {
  displayName: string
  userModels: string[]
  onUserModelsChange: (models: string[]) => void
}) {
  const [draftModel, setDraftModel] = useState('')
  const addDraftModel = (): void => {
    const model = draftModel.trim()
    if (!model) return
    if (!userModels.includes(model)) onUserModelsChange([...userModels, model])
    setDraftModel('')
  }
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="text-body font-medium text-[color:var(--text-strong)]">Custom model ids</div>
      <div className="mt-2 space-y-1">
        {userModels.map((model) => (
          <div key={model} className="group -mx-1 flex h-control-md items-center gap-2 rounded-sm px-1">
            <span className="min-w-0 flex-1 truncate font-mono text-body text-[color:var(--text-default)]">
              {model}
            </span>
            <GhostButton
              size="xs"
              onClick={() => onUserModelsChange(userModels.filter((id) => id !== model))}
              className="invisible focus-visible:visible group-focus-within:visible group-hover:visible"
            >
              Remove
              <span className="sr-only">
                {' '}
                {model} from {displayName} models
              </span>
            </GhostButton>
          </div>
        ))}
        <Input
          value={draftModel}
          aria-label={`Add a model id for ${displayName}`}
          placeholder="Add model id and press Enter"
          onChange={(event) => setDraftModel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addDraftModel()
            }
          }}
          size="md"
          variant="well"
          className={MONO_FIELD}
        />
      </div>
    </div>
  )
}
