import React from 'react'

import type { CapabilityManifest } from '../../../../shared/modules/manifest'
import { selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  listSpecialistPacks,
  type SpecialistPack,
} from '../../specialists/specialistPacks'
import { SpecialistActionIcon, SpecialistPacksSettingsIcon } from '../AppIcons'
import { ConnectorRow } from '../panels/ConnectorsPanel/ConnectorRow'
import { EmptyState, GhostButton, InboxSearchInput, Switch } from '../ui'
import { mcpMonogram } from '../ui/mcpMonogram'
import { COMING_SOON_IDS, MODULE_CATEGORY_GROUPS, categoryLabel } from './ModuleControls'
import { ThirdPartyModuleList } from './ThirdPartyModuleList'
import { SettingCard, SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'

// Module manager: one surface for everything that plugs into the app — the
// bundled capability modules, the specialist packs that feed the spawn menu,
// and third-party modules installed from disk. The rows are the Connectors
// row (icon chip · name + chips · summary · right-aligned control) so the two
// marketplace-shaped surfaces read as one system; the groups are the settings
// list card under a settings section band (setting-row → The list card,
// 2026-09-15) so this tab reads as the rest of Settings does. Module enablement
// writes appSettings.modules. Discovered specialist packs are listed here
// with no per-pack off-switch: pickers show whatever discovery returned.

// The same neutral icon chip the Connectors surface uses, for entries that
// have no brand image: a glyph when the entry kind ships one, else a monogram.
function ModuleTileIcon({ name, glyph }: { name: string; glyph?: React.ReactNode }) {
  return (
    <span
      aria-hidden
      style={{ width: 36, height: 36 }}
      className="grid shrink-0 place-items-center rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)]"
    >
      {glyph ?? (
        <span style={{ fontSize: 15 }} className="font-mono font-semibold text-[color:var(--icon-chip-ink)]">
          {mcpMonogram(name)}
        </span>
      )}
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

function SpecialistPackCard({
  pack,
  expanded,
  onToggleExpanded,
}: {
  pack: SpecialistPack
  expanded: boolean
  onToggleExpanded: () => void
}) {
  return (
    // The row and its disclosure share one list item, so the roster opens
    // INSIDE the pack's own cell and the packs below only move down. The
    // roster used to be a second SettingCard under the row — a card in a card
    // once the packs themselves sat in one — so it is now an indented block
    // on the name's left edge, the way a provider row's detail opens.
    <li>
      <ConnectorRow
        surface="card"
        icon={
          <ModuleTileIcon
            name={pack.name}
            glyph={<SpecialistPacksSettingsIcon className="size-icon-md text-[color:var(--icon-chip-ink)]" />}
          />
        }
        name={pack.name}
        summary={pack.description}
        chips={[`${pack.specialists.length} agent${pack.specialists.length === 1 ? '' : 's'}`]}
        selected={expanded}
        onOpen={onToggleExpanded}
      />
      {expanded ? (
        // design-tokens-allow: alignment — the roster's left edge is the pack name's (16px inset + 36px chip + 8px gap), structure not rhythm
        <ul className="space-y-3 pb-3 pl-[60px] pr-4 pt-1" aria-label={`${pack.name} agents`}>
          {pack.specialists.map((specialist) => (
            <li key={specialist.id} className="flex items-start gap-3">
              <SpecialistActionIcon
                icon={specialist.icon}
                className="icon-md mt-0.5 shrink-0 text-[color:var(--text-muted)]"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium text-[color:var(--text-strong)]">
                  {specialist.shortLabel}
                </div>
                {specialist.description ? (
                  <div className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">
                    {specialist.description}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function ModulesSettingsTab() {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  const sprintEngineRoleRegistry = useWorkspaceStore((s) => s.sprintEngineRoleRegistry)
  const packs = React.useMemo(
    () => listSpecialistPacks(sprintEngineRoleRegistry),
    [sprintEngineRoleRegistry]
  )

  const [query, setQuery] = React.useState('')
  const [expandedPackId, setExpandedPackId] = React.useState<string | null>(null)

  const q = query.trim().toLowerCase()
  const matches = (...parts: Array<string | null | undefined>) =>
    !q || parts.some((part) => part?.toLowerCase().includes(q))

  const moduleGroups = MODULE_CATEGORY_GROUPS.map(({ category, manifests }) => ({
    category,
    manifests: manifests.filter((manifest) => matches(manifest.displayName, manifest.summary)),
  })).filter((group) => group.manifests.length > 0)

  const visiblePacks = packs.filter((pack) =>
    matches(pack.name, pack.description, ...pack.specialists.map((s) => s.label))
  )

  return (
    <div
      role="tabpanel"
      id="settings-panel-modules"
      aria-labelledby="settings-tab-modules"
      className="space-y-5"
    >
      <SettingsPageHeader
        title="Modules"
        actions={
          <div className="flex w-52 max-w-full">
            <InboxSearchInput
              value={query}
              onChange={setQuery}
              ariaLabel="Search modules and specialist packs"
              placeholder="Search"
            />
          </div>
        }
      />

      {moduleGroups.length === 0 && visiblePacks.length === 0 ? (
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

      {!q && packs.length === 0 ? (
        <section className="space-y-2">
          <SettingsSectionTitle count={0}>Specialist packs</SettingsSectionTitle>
          <EmptyState
            density="list"
            title="No specialist packs installed."
            action={
              <GhostButton
                size="md"
                onClick={() => openExtensionsSurface({ view: 'plugins' })}
                className="h-control-md"
              >
                Browse marketplace
              </GhostButton>
            }
          />
        </section>
      ) : visiblePacks.length > 0 ? (
        <section className="space-y-2">
          <SettingsSectionTitle count={visiblePacks.length}>Specialist packs</SettingsSectionTitle>
          <SettingCard as="ul" ariaLabel="Specialist packs">
            {visiblePacks.map((pack) => (
              <SpecialistPackCard
                key={pack.id}
                pack={pack}
                expanded={expandedPackId === pack.id}
                onToggleExpanded={() =>
                  setExpandedPackId((current) => (current === pack.id ? null : pack.id))
                }
              />
            ))}
          </SettingCard>
        </section>
      ) : null}

      <ThirdPartyModuleList overrides={overrides} onSetEnabled={setModuleEnabled} />
    </div>
  )
}
