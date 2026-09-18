import React from 'react'

import type { CapabilityManifest } from '../../../../shared/modules/manifest'
import { selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ConnectorRow } from '../panels/ConnectorsPanel/ConnectorRow'
import { InboxSearchInput, Switch } from '../ui'
import { mcpMonogram } from '../ui/mcpMonogram'
import { COMING_SOON_IDS, MODULE_CATEGORY_GROUPS, categoryLabel } from './ModuleControls'
import { ThirdPartyModuleList } from './ThirdPartyModuleList'
import { SettingCard, SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'

// Module manager: one surface for everything that plugs into the app — the
// bundled capability modules and third-party modules installed from disk. The
// rows are the Connectors row (icon chip · name + chips · summary ·
// right-aligned control) so the two marketplace-shaped surfaces read as one
// system; the groups are the settings list card under a settings section band
// (setting-row → The list card, 2026-09-15) so this tab reads as the rest of
// Settings does. Module enablement writes appSettings.modules.

// The same neutral icon chip the Connectors surface uses, for entries that
// have no brand image: a monogram.
function ModuleTileIcon({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      style={{ width: 36, height: 36 }}
      className="grid shrink-0 place-items-center rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)]"
    >
      <span style={{ fontSize: 15 }} className="font-mono font-semibold text-[color:var(--icon-chip-ink)]">
        {mcpMonogram(name)}
      </span>
    </span>
  )
}

function ModuleCard({
  manifest,
  comingSoon,
  enabled,
  onToggle,
}: {
  manifest: CapabilityManifest
  comingSoon: boolean
  enabled: boolean
  onToggle: (enabled: boolean) => void
}) {
  const chips = comingSoon ? ['Coming soon'] : manifest.core ? ['Always on'] : []
  const card = (
    <ConnectorRow
      surface="card"
      icon={<ModuleTileIcon name={manifest.displayName} />}
      name={manifest.displayName}
      summary={manifest.summary}
      chips={chips}
      actions={
        comingSoon ? undefined : (
          <Switch
            checked={manifest.core ? true : enabled}
            disabled={manifest.core}
            onChange={onToggle}
            ariaLabel={`Enable ${manifest.displayName}`}
          />
        )
      }
    />
  )
  // A coming-soon module is absent from the enablement universe — the row is
  // purely informational, so it reads muted with no control.
  return <li className={comingSoon ? 'opacity-60' : undefined}>{card}</li>
}

export function ModulesSettingsTab() {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const [query, setQuery] = React.useState('')

  const q = query.trim().toLowerCase()
  const matches = (...parts: Array<string | null | undefined>) =>
    !q || parts.some((part) => part?.toLowerCase().includes(q))

  const moduleGroups = MODULE_CATEGORY_GROUPS.map(({ category, manifests }) => ({
    category,
    manifests: manifests.filter((manifest) => matches(manifest.displayName, manifest.summary)),
  })).filter((group) => group.manifests.length > 0)

  return (
    <div role="tabpanel" id="settings-panel-modules" aria-labelledby="settings-tab-modules" className="space-y-5">
      <SettingsPageHeader
        title="Modules"
        actions={
          <div className="flex w-52 max-w-full">
            <InboxSearchInput value={query} onChange={setQuery} ariaLabel="Search modules" placeholder="Search" />
          </div>
        }
      />

      {moduleGroups.length === 0 ? (
        <p className="text-body leading-5 text-[color:var(--text-muted)]">
          Nothing matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : null}

      {moduleGroups.map(({ category, manifests }) => (
        <section key={category} className="space-y-2">
          <SettingsSectionTitle count={manifests.length}>{categoryLabel(category)}</SettingsSectionTitle>
          {/* Two columns in ONE card: a category is one group with one edge;
              the rows are short, so one column would be twice the height. */}
          <SettingCard as="ul" ariaLabel={categoryLabel(category)} columns={2}>
            {manifests.map((manifest) => (
              <ModuleCard
                key={manifest.id}
                manifest={manifest}
                comingSoon={COMING_SOON_IDS.has(manifest.id)}
                enabled={selectModuleEnabled(overrides, manifest.id)}
                onToggle={(next) => setModuleEnabled(manifest.id, next)}
              />
            ))}
          </SettingCard>
        </section>
      ))}

      <ThirdPartyModuleList overrides={overrides} onSetEnabled={setModuleEnabled} />
    </div>
  )
}
