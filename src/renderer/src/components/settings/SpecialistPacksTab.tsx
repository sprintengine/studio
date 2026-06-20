import React from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  isSpecialistPackEnabled,
  listSpecialistPacks,
} from '../../specialists/specialistPacks'
import { SpecialistActionIcon } from '../AppIcons'
import { Switch } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'

const EMPTY_DISABLED: string[] = []

/**
 * Specialist packs settings: each pack is a toggleable group of specialist
 * agents offered in the spawn-agent dropdown. Disabling a pack removes its
 * agents from the dropdown; the menu keeps its Terminal / General / Conversation
 * quick rows, so the spawn menu is never empty.
 */
export default function SpecialistPacksTab() {
  const disabled = useWorkspaceStore((s) => s.appSettings.specialistPacks?.disabled ?? EMPTY_DISABLED)
  const setSpecialistPackEnabled = useWorkspaceStore((s) => s.setSpecialistPackEnabled)
  const sprintEngineRoleRegistry = useWorkspaceStore((s) => s.sprintEngineRoleRegistry)
  const packs = React.useMemo(() => listSpecialistPacks(sprintEngineRoleRegistry), [sprintEngineRoleRegistry])

  return (
    <div
      role="tabpanel"
      id="settings-panel-specialist-packs"
      aria-labelledby="settings-tab-specialist-packs"
      className="space-y-5"
    >
      <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        Specialist packs group the role-based agents offered in the spawn menu. Each agent is composed
        from a portable soul; Multicode and Sprint Engine layer their own skills on at spawn time.
        Turning a pack off hides its agents from the dropdown — the Terminal, General, and Conversation
        rows always stay available.
      </p>

      {packs.map((pack) => {
        const enabled = isSpecialistPackEnabled(disabled, pack.id)
        return (
          <section key={pack.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <SettingsSectionTitle count={pack.specialists.length}>{pack.name}</SettingsSectionTitle>
                  {pack.builtin ? (
                    <span className="rounded bg-[color:var(--bg-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--text-subtle)]">
                      Built-in
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">{pack.description}</p>
              </div>
              <Switch
                checked={enabled}
                onChange={(next) => setSpecialistPackEnabled(pack.id, next)}
                ariaLabel={`Enable ${pack.name}`}
              />
            </div>

            <div
              className={`divide-y divide-[color:var(--border-subtle)] rounded-md border border-[color:var(--border-subtle)] ${
                enabled ? '' : 'opacity-50'
              }`}
            >
              {pack.specialists.map((specialist) => (
                <div key={specialist.id} className="flex items-center gap-3 px-3 py-2.5">
                  <SpecialistActionIcon
                    icon={specialist.icon}
                    className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                      {specialist.shortLabel}
                    </div>
                    {specialist.description ? (
                      <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
                        {specialist.description}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
