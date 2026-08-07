import React from 'react'

import type { CapabilityManifest } from '../../../../shared/modules/manifest'
import { selectModuleEnabled } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  isSpecialistPackEnabled,
  listSpecialistPacks,
  type SpecialistPack,
} from '../../specialists/specialistPacks'
import { SpecialistActionIcon, SpecialistPacksSettingsIcon } from '../AppIcons'
import { ConnectorRow, ConnectorSectionHeading } from '../panels/ConnectorsPanel/ConnectorRow'
import { EmptyState, GhostButton, InboxSearchInput, Switch } from '../ui'
import { mcpMonogram } from '../ui/mcpMonogram'
import { COMING_SOON_IDS, MODULE_CATEGORY_GROUPS, categoryLabel } from './ModuleControls'
import { ThirdPartyModuleList } from './ThirdPartyModuleList'

// Module manager: one surface for everything that plugs into the app — the
// bundled capability modules, the specialist packs that feed the spawn menu,
// and third-party modules installed from disk. Rendered in the Connectors
// idiom (icon chip · name + chips · summary · right-aligned control) so the
// two marketplace-shaped surfaces read as one system. Module enablement
// writes appSettings.modules; pack enablement writes
// appSettings.specialistPacks — same stores the old split tabs used.

const EMPTY_DISABLED: string[] = []

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
  // A coming-soon module is absent from the enablement universe — the card is
  // purely informational, so it reads muted with no control.
  return comingSoon ? <div className="opacity-60">{card}</div> : card
}

function SpecialistPackCard({
  pack,
  enabled,
  expanded,
  onToggleExpanded,
  onSetEnabled,
}: {
  pack: SpecialistPack
  enabled: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onSetEnabled: (enabled: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <ConnectorRow
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
        actions={
          <Switch checked={enabled} onChange={onSetEnabled} ariaLabel={`Enable ${pack.name}`} />
        }
      />
      {expanded ? (
        <div
          className={`divide-y divide-[color:var(--border-subtle)] rounded-md border border-[color:var(--border-subtle)] ${
            enabled ? '' : 'opacity-50'
          }`}
        >
          {pack.specialists.map((specialist) => (
            <div key={specialist.id} className="flex items-center gap-3 px-3 py-2.5">
              <SpecialistActionIcon
                icon={specialist.icon}
                className="icon-md shrink-0 text-[color:var(--text-muted)]"
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
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ModulesSettingsTab() {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const disabledPacks = useWorkspaceStore(
    (s) => s.appSettings.specialistPacks?.disabled ?? EMPTY_DISABLED
  )
  const setSpecialistPackEnabled = useWorkspaceStore((s) => s.setSpecialistPackEnabled)
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
      <p className="text-body leading-5 text-[color:var(--text-muted)]">
        Everything that plugs into the app, in one place. Turning a module off hides its surfaces —
        nothing is uninstalled, and you can turn it back on any time. Specialist packs group the
        agents offered in the spawn menu; turning a pack off hides its agents from the dropdown while
        the Terminal, General, and Conversation rows always stay available.
      </p>

      <div className="flex">
        <InboxSearchInput
          value={query}
          onChange={setQuery}
          ariaLabel="Search modules and specialist packs"
          placeholder="Search modules and packs"
        />
      </div>

      {moduleGroups.length === 0 && visiblePacks.length === 0 ? (
        <p className="text-body leading-5 text-[color:var(--text-muted)]">
          Nothing matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : null}

      {moduleGroups.map(({ category, manifests }) => (
        <section key={category} className="space-y-2">
          <ConnectorSectionHeading label={categoryLabel(category)} count={manifests.length} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {manifests.map((manifest) => (
              <ModuleCard
                key={manifest.id}
                manifest={manifest}
                comingSoon={COMING_SOON_IDS.has(manifest.id)}
                enabled={selectModuleEnabled(overrides, manifest.id)}
                onToggle={(next) => setModuleEnabled(manifest.id, next)}
              />
            ))}
          </div>
        </section>
      ))}

      {!q && packs.length === 0 ? (
        <section className="space-y-2">
          <ConnectorSectionHeading label="Specialist packs" count={0} />
          <EmptyState
            density="list"
            title="No specialist packs installed."
            body="Install one from the marketplace and its agents appear in the spawn menu, alongside the Terminal, General, and Conversation rows."
            action={
              <GhostButton
                size="md"
                onClick={() => openExtensionsSurface({ view: 'browse' })}
                className="h-control-md"
              >
                Browse marketplace
              </GhostButton>
            }
          />
        </section>
      ) : visiblePacks.length > 0 ? (
        <section className="space-y-2">
          <ConnectorSectionHeading label="Specialist packs" count={visiblePacks.length} />
          <div className="flex flex-col gap-2">
            {visiblePacks.map((pack) => (
              <SpecialistPackCard
                key={pack.id}
                pack={pack}
                enabled={isSpecialistPackEnabled(disabledPacks, pack.id)}
                expanded={expandedPackId === pack.id}
                onToggleExpanded={() =>
                  setExpandedPackId((current) => (current === pack.id ? null : pack.id))
                }
                onSetEnabled={(next) => setSpecialistPackEnabled(pack.id, next)}
              />
            ))}
          </div>
        </section>
      ) : null}

      <ThirdPartyModuleList overrides={overrides} onSetEnabled={setModuleEnabled} />
    </div>
  )
}
