import { useMemo, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  CliProviderStateLine,
  GhostButton,
  PrimaryButton,
  ProviderRow,
  resolveCliProviderState,
} from '../ui'
import CliIcon from '../CliIcon'
import { CliInstallControl } from '../settings/CliInstallControl'
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
  // Which row's Install button was pressed, so its install flow opens straight
  // away instead of making the user find the same button again inside the
  // expansion. Cleared whenever the disclosure is driven by the chevron.
  const [installIntentCli, setInstallIntentCli] = useState<string | null>(null)

  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center p-8">
      <div className="pointer-events-auto flex max-h-full w-full max-w-[480px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <div className="border-b border-[color:var(--border-subtle)] px-5 py-4">
          <h2 className="text-title font-semibold text-[color:var(--text-strong)]">Set up an agent CLI</h2>
          {/* Not helper copy: this states what the probe found on THIS machine,
              which is the only reason the card is on screen at all. */}
          <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">
            Agents run through a command-line tool. We couldn’t find one installed — install one to
            start.
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
                return (
                  <ProviderRow
                    key={plugin.id}
                    icon={
                      <CliIcon
                        cli={plugin.id}
                        className="size-icon-lg text-[color:var(--text-default)]"
                      />
                    }
                    health={state.tone}
                    name={plugin.displayName}
                    version={state.version}
                    stateLine={
                      <CliProviderStateLine
                        state={state}
                        binary={plugin.binary}
                        useWsl={override.useWsl}
                        probeError={cliAvailabilityError}
                      />
                    }
                    // Only a CLI that still needs installing gets a disclosure —
                    // its expansion is the real install flow. An installed one has
                    // nothing behind the chevron here (its command override and
                    // models live in Settings), and a chevron over an empty panel
                    // is a promise the row cannot keep.
                    expanded={openCli === plugin.id}
                    onExpandedChange={
                      state.installed
                        ? undefined
                        : (next) => {
                            setInstallIntentCli(null)
                            setOpenCli(next ? plugin.id : null)
                          }
                    }
                    // Only a definitive negative probe earns an Install button; a
                    // CLI whose probe never completed may already be installed.
                    actions={
                      state.health === 'missing' ? (
                        <PrimaryButton
                          size="xs"
                          onClick={() => {
                            setInstallIntentCli(plugin.id)
                            setOpenCli(plugin.id)
                          }}
                        >
                          Install
                        </PrimaryButton>
                      ) : null
                    }
                  >
                    <CliInstallControl
                      cli={plugin.id}
                      displayName={plugin.displayName}
                      binary={plugin.binary}
                      command={override.command}
                      useWsl={override.useWsl}
                      showName={false}
                      showStatus={false}
                      autoOpenInstall={installIntentCli === plugin.id}
                      onInstalled={(result) => {
                        if (result.resolvedPath && !override.command) {
                          setCliRuntime(plugin.id, { command: result.resolvedPath, useWsl: override.useWsl })
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

        <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] px-5 py-3">
          <span className="min-w-0 truncate text-micro text-[color:var(--text-subtle)]">
            Change this anytime in Settings → Agents.
          </span>
          <GhostButton size="sm" onClick={onDismiss} className="shrink-0 text-[color:var(--text-muted)]">
            Not now
          </GhostButton>
        </div>
      </div>
    </div>
  )
}
