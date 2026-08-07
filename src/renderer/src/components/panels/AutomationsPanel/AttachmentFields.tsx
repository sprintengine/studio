// The automation editor's Attachments group (item 2042): what can ride along
// with a run — a built-in skill, and a connector to pin it to.
//
// A field group beside `TriggerFields` and `AgentFields`, on the same contract:
// the editor owns the form state and the one save path, and each picker hands
// its choice back through `onPatchConfig` / `onClearConfigKey`. The connector
// catalog read lives here because nothing outside this group consumes it.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { GhostButton, InlineNotice, Select, type SelectItem } from '../../ui'
import { SkillPickerPopover } from '../../ui/SkillPickerPopover'
import type { McpCatalogServer, WorkspaceSkill } from '../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { launchableConnectors } from '../ConnectorsPanel/connectorsFacets'

// Sentinel option value for "target no connector" — the Select emits a string, so
// the cleared choice is a real item rather than null, and it maps back to removing
// the connectorId key from the action config on submit.
const NO_CONNECTOR = ''

// A launchable connector follows connectorsFacets.connectorCanLaunch — a
// catalog entry carrying a `skill` link, or any server installed (enabled) in
// MCP settings; the picker population comes from the shared
// launchableConnectors so it cannot drift from the Connectors surface. The
// load carries the raw catalog so the installed merge happens reactively in
// the picker memo; it is undefined-free so a catalog failure renders an
// explicit notice (installed servers still list — they launch without the
// catalog) rather than a silently empty picker.
type ConnectorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; connectors: McpCatalogServer[] }

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
  // isolated worktree + MCP, plus the driving skill when the catalog pairs one).
  // The picker is populated from the real MCP catalog and the installed MCP
  // settings, never a placeholder list.
  const [connectorLoad, setConnectorLoad] = useState<ConnectorLoad>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    if (typeof window.api.mcpListCatalog !== 'function') {
      setConnectorLoad({ status: 'error', message: 'Connectors need an app restart before they are available.' })
      return () => { cancelled = true }
    }
    void window.api.mcpListCatalog().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setConnectorLoad({ status: 'ready', connectors: result.servers })
      } else {
        setConnectorLoad({ status: 'error', message: result.message })
      }
    }).catch((error) => {
      if (!cancelled) {
        setConnectorLoad({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the connector catalog.',
        })
      }
    })
    return () => { cancelled = true }
  }, [])

  const selectedConnectorId = connectorId ?? NO_CONNECTOR
  const installedMcpServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  const connectorItems: SelectItem[] = useMemo(() => {
    const items: SelectItem[] = [{ value: NO_CONNECTOR, label: 'No connector' }]
    if (connectorLoad.status !== 'loading') {
      // A failed catalog load still lists the installed servers — they launch
      // without the catalog.
      const catalog = connectorLoad.status === 'ready' ? connectorLoad.connectors : []
      for (const server of launchableConnectors(catalog, installedMcpServers)) {
        items.push({ value: server.id, label: server.name })
      }
    }
    // A stored connector no longer in the catalog still round-trips and is shown
    // as unavailable (once the catalog has resolved) rather than silently dropped.
    if (selectedConnectorId && !items.some((item) => item.value === selectedConnectorId)) {
      const resolved = connectorLoad.status === 'ready'
      items.push({
        value: selectedConnectorId,
        label: resolved ? `${selectedConnectorId} — unavailable` : selectedConnectorId,
        tone: resolved ? 'warn' : undefined,
      })
    }
    return items
  }, [connectorLoad, selectedConnectorId, installedMcpServers])

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
              <code className="min-w-0 flex-1 truncate rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 font-mono text-micro text-[color:var(--text-muted)]">
                {pickedSkillLabel ?? selectedSkillId}
              </code>
              <GhostButton type="button" onClick={onClearSkill} className="h-6 shrink-0 px-2 text-micro">
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
                <button
                  ref={ref}
                  type="button"
                  onClick={togglePopover}
                  className="flex h-7 w-full items-center justify-between rounded-[5px] border border-dashed border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2.5 text-meta text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)]"
                  {...triggerProps}
                >
                  Add a skill
                  <svg className="icon-xs shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
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
            disabled={connectorLoad.status === 'loading'}
            placeholder={connectorLoad.status === 'loading' ? 'Loading connectors…' : 'Add a connector'}
          />
          {connectorLoad.status === 'error' ? (
            <InlineNotice tone="warn">Connectors are unavailable: {connectorLoad.message}</InlineNotice>
          ) : connectorLoad.status === 'ready' && connectorItems.length === 1 ? (
            <span className="text-micro text-[color:var(--text-subtle)]">
              No connectors installed — the run uses the workspace defaults.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
