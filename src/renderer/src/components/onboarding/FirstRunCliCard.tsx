import { useCallback, useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { CliProviderStateLine, GhostButton, PrimaryButton, ProviderRow, Spinner, resolveCliProviderState } from '../ui'
import CliIcon from '../CliIcon'
import { CliInstallControl, type CliInstallProgress } from '../settings/CliInstallControl'
import { cliRuntimeForPlugin, orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'

// The one question that survived the onboarding wizard.
//
// Welcome, theme, modules and the activation payoff all went: the app already
// knows the answers (theme follows the OS, every bundled module ships on, the
// CLI probe runs at boot). What it cannot know is that this particular machine
// has no agent CLI installed at all — a real gap on a real machine, and the only
// thing worth a card.
//
// Built to prototype variant A's landed state (`?state=d`): a plain centred card
// in the workspace region, NOT a modal. There is no scrim, no focus trap and no
// forced path — the sidebar stays live and the user can ignore this entirely.
// The old flow trapped focus because there was nothing usable behind it; now
// there is.
//
// The row anatomy is deliberately identical to Settings → Agents: same
// ProviderRow, same health dot, same install flow. The first list a user ever
// sees is the list they come back to.
export default function FirstRunCliCard({ onDismiss }: { onDismiss: () => void }) {
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const cliAvailabilityError = useWorkspaceStore((s) => s.cliAvailabilityError)
  const rows = useMemo(() => orderInstalledPlugins(pluginCatalogEntries), [pluginCatalogEntries])
  // One CLI open at a time — the point is to install one, not to compare four
  // expanded forms at once.
  const [openCli, setOpenCli] = useState<string | null>(null)
  // The one install this card is running, if any. Install INSTALLS: pressing a
  // row's button runs the recommended method immediately, rather than opening a
  // picker carrying a second Install button that the first one only promised.
  // One at a time, because only one row is open at a time and an open row is what
  // an install streams into.
  const [rowInstall, setRowInstall] = useState<{
    cli: string
    // Still asking for an install to be started. Held until one actually ran, so
    // the first progress report (which arrives before the run begins) does not
    // cancel the request that caused it.
    requested: boolean
    started: boolean
    progress: CliInstallProgress | null
  } | null>(null)

  const noteInstallProgress = useCallback((cli: string, progress: CliInstallProgress) => {
    setRowInstall((previous) => {
      if (!previous || previous.cli !== cli) return previous
      const started = previous.started || progress.installing
      const requested = progress.installing || !started
      if (
        previous.started === started &&
        previous.requested === requested &&
        previous.progress?.installing === progress.installing &&
        previous.progress?.methodLabel === progress.methodLabel
      ) {
        return previous
      }
      return { cli, requested, started, progress }
    })
  }, [])

  return (
    <div className="pointer-events-none absolute inset-0 z-[var(--z-float)] grid place-items-center p-8">
      <div className="pointer-events-auto flex max-h-full w-full max-w-[480px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        {/* No rules between header, list and footer: inside an overlay, space separates. */}
        <div className="px-5 pb-2 pt-4">
          <h2 className="text-title font-semibold text-[color:var(--text-strong)]">Set up an agent CLI</h2>
          {/* Not helper copy: this states what the probe found on THIS machine,
              which is the only reason the card is on screen at all. */}
          <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">
            Agents run through a command-line tool. We couldn’t find one installed — install one to start.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-meta text-[color:var(--text-muted)]">
              No agent CLIs are available to install.
            </p>
          ) : (
            <div>
              {rows.map((plugin) => {
                const override = cliRuntimeForPlugin(plugin.id, cliRuntimes)
                const state = resolveCliProviderState(cliAvailability[plugin.id], cliAvailabilityStatus)
                const install = rowInstall?.cli === plugin.id ? rowInstall : null
                const rowInstalling = install?.progress?.installing === true
                return (
                  <ProviderRow
                    key={plugin.id}
                    icon={<CliIcon cli={plugin.id} className="size-icon-lg text-[color:var(--text-default)]" />}
                    health={state.tone}
                    name={plugin.displayName}
                    version={state.version}
                    // The state line reports the install while one runs: it is the
                    // same fact the row is already stating, in the same place,
                    // named by the method actually running.
                    stateLine={
                      rowInstalling ? (
                        `Installing${install?.progress?.methodLabel ? ` via ${install.progress.methodLabel}` : ''}…`
                      ) : (
                        <CliProviderStateLine state={state} binary={plugin.binary} probeError={cliAvailabilityError} />
                      )
                    }
                    // Only a CLI that still needs installing gets a disclosure —
                    // its expansion holds the install METHOD, and the running
                    // install's output. An installed one has nothing behind the
                    // chevron here (its command override and models live in
                    // Settings), and a chevron over an empty panel is a promise
                    // the row cannot keep.
                    expanded={openCli === plugin.id || rowInstalling}
                    onExpandedChange={
                      // Exactly the rows that can be installed from here get one.
                      // The panel holds the method the row's Install button will
                      // run, so a row with no Install button — installed, or a
                      // probe that never completed and may already be there —
                      // would open on a picker that starts nothing.
                      state.health === 'missing'
                        ? (next) => {
                            // A running install streams into this panel and the
                            // control that runs it is unmounted when the row
                            // closes, so the chevron cannot hide one.
                            if (rowInstalling) return
                            setOpenCli(next ? plugin.id : null)
                          }
                        : undefined
                    }
                    // Only a definitive negative probe earns an Install button; a
                    // CLI whose probe never completed may already be installed.
                    // One button, one place: it stays put while the install runs,
                    // going disabled and spinning where it already was.
                    actions={
                      state.health === 'missing' ? (
                        <PrimaryButton
                          size="xs"
                          disabled={rowInstalling}
                          onClick={() => {
                            setRowInstall({
                              cli: plugin.id,
                              requested: true,
                              started: false,
                              progress: null,
                            })
                            setOpenCli(plugin.id)
                          }}
                        >
                          {rowInstalling ? (
                            <>
                              <Spinner className="icon-sm" />
                              Installing
                            </>
                          ) : (
                            'Install'
                          )}
                        </PrimaryButton>
                      ) : null
                    }
                  >
                    <CliInstallControl
                      cli={plugin.id}
                      displayName={plugin.displayName}
                      binary={plugin.binary}
                      command={override.command}
                      showName={false}
                      showStatus={false}
                      hostDriven
                      installRequested={install?.requested === true}
                      onInstallStateChange={(progress) => noteInstallProgress(plugin.id, progress)}
                      onInstalled={(result) => {
                        if (result.resolvedPath && !override.command) {
                          setCliRuntime(plugin.id, { command: result.resolvedPath })
                        }
                        void refreshPluginCatalog()
                        // Forced: the install just changed the answer, and the
                        // card's own visibility is derived from it — a
                        // successful install is what makes this card go away.
                        void refreshCliAvailability({ force: true, cliRuntimes })
                      }}
                    />
                  </ProviderRow>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 pb-4 pt-2">
          <GhostButton size="sm" onClick={onDismiss} className="shrink-0 text-[color:var(--text-muted)]">
            Not now
          </GhostButton>
        </div>
      </div>
    </div>
  )
}
