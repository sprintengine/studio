// The automation editor's Attachments group (item 2042): what can ride along
// with a run — a built-in skill, and a connector to pin it to.
//
// A field group beside `TriggerFields` and `AgentFields`, on the same contract:
// the editor owns the form state and the one save path, and each picker hands
// its choice back through `onPatchConfig` / `onClearConfigKey`.

import { useCallback, useMemo, useState } from 'react'

import { GhostButton, Select, type SelectItem, TriggerButton } from '../../ui'
import { SkillPickerPopover } from '../../ui/SkillPickerPopover'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { launchableConnectors } from '../ConnectorsPanel/connectorsFacets'

// Sentinel option value for "target no connector" — the Select emits a string, so
// the cleared choice is a real item rather than null, and it maps back to removing
// the connectorId key from the action config on submit.
const NO_CONNECTOR = ''

export function AttachmentFields({
  showSkillPicker,
  showConnectorPicker,
  workspaceRoot,
  spawnSkillId,
  connectorId,
  onPatchConfig,
  onClearConfigKey,
}: {
  /** The action's schema consumes `spawnSkillId`, and the action is available. */
  showSkillPicker: boolean
  /** The action's schema consumes `connectorId`, and the action is available. */
  showConnectorPicker: boolean
  workspaceRoot: string
  spawnSkillId: string | undefined
  connectorId: string | undefined
  onPatchConfig: (patch: Record<string, string>) => void
  onClearConfigKey: (key: string) => void
}): JSX.Element | null {
  // Skill attachment — a spawn-agent run can attach a built-in skill (e.g.
  // `backlog`) that the terminal spawn installs into the run's worktree before
  // the CLI starts. Only built-in skills are offered: they are the ones that
  // install into the per-run worktree (a pack/custom skill would not follow the
  // agent there).
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  // The selected skill's human name for display; config only stores the id, so
  // this is seeded on pick and falls back to the id when editing a saved run.
  const [pickedSkillLabel, setPickedSkillLabel] = useState<string | null>(null)
  const selectedSkillId = spawnSkillId?.trim() || ''
  const onPickSkill = useCallback((skill: WorkspaceSkill) => {
    setPickedSkillLabel(skill.name)
    onPatchConfig({ spawnSkillId: skill.id })
  }, [onPatchConfig])
  const onClearSkill = useCallback(() => {
    setPickedSkillLabel(null)
    onClearConfigKey('spawnSkillId')
  }, [onClearConfigKey])
  const onlyBuiltinSkills = useCallback((skill: WorkspaceSkill) => skill.source === 'builtin', [])

  // Connector target — a spawn-agent run can be pinned to a connector (its
  // isolated worktree and MCP). The picker's population comes from the shared
  // `launchableConnectors`, so it cannot drift from the Connectors surface:
  // every MCP server installed and enabled in this workspace's settings, and
  // nothing else. It read the bundled MCP catalogue too until the third-party
  // retirement (MC-2519, 2026-09-08); with that file gone the settings are the
  // whole population, which is synchronous — so this picker no longer has a
  // loading or a failure state to render.
  const selectedConnectorId = connectorId ?? NO_CONNECTOR
  const installedMcpServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  const connectorItems: SelectItem[] = useMemo(() => {
    const items: SelectItem[] = [{ value: NO_CONNECTOR, label: 'No connector' }]
    for (const server of launchableConnectors(installedMcpServers)) {
      items.push({ value: server.id, label: server.name })
    }
    // A stored connector that is no longer installed still round-trips and is
    // shown as unavailable rather than silently dropped.
    if (selectedConnectorId && !items.some((item) => item.value === selectedConnectorId)) {
      items.push({ value: selectedConnectorId, label: `${selectedConnectorId} — unavailable`, tone: 'warn' })
    }
    return items
  }, [selectedConnectorId, installedMcpServers])

  const onSelectConnector = useCallback((value: string) => {
    if (value) onPatchConfig({ connectorId: value })
    else onClearConfigKey('connectorId')
  }, [onPatchConfig, onClearConfigKey])

  if (!showSkillPicker && !showConnectorPicker) return null

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-meta text-[color:var(--text-subtle)]">Attachments</h3>
      {showSkillPicker ? (
        <div className="flex flex-col gap-1.5">
          {selectedSkillId ? (
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 font-mono text-micro text-[color:var(--text-muted)]">
                {pickedSkillLabel ?? selectedSkillId}
              </code>
              <GhostButton size="xs" onClick={onClearSkill} className="shrink-0">
                Clear
              </GhostButton>
            </div>
          ) : (
            <SkillPickerPopover
              open={skillPickerOpen}
              onOpenChange={setSkillPickerOpen}
              workspaceRoot={workspaceRoot || null}
              onPick={onPickSkill}
              filterSkill={onlyBuiltinSkills}
              placement="bottom-start"
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <TriggerButton
                  ref={ref}
                  variant="dashed"
                  onClick={togglePopover}
                  {...triggerProps}
                >
                  Add a skill
                  <svg className="icon-xs shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </TriggerButton>
              )}
            />
          )}
        </div>
      ) : null}
      {showConnectorPicker ? (
        <div className="flex flex-col gap-1.5">
          <Select
            ariaLabel="Connector"
            value={selectedConnectorId}
            onChange={onSelectConnector}
            items={connectorItems}
            placeholder="Add a connector"
          />
          {connectorItems.length === 1 ? (
            <span className="text-micro text-[color:var(--text-subtle)]">
              No connectors installed — the run uses the workspace defaults.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
