// The installed-extensions inventory, relocated from the (removed) Settings →
// Extensions tab into the Connectors surface (T3). It is the aggregated,
// read-only roll-up of everything installed across the four extension primitives
// — MCP servers, skill packs, agent CLIs, and capability modules — so the
// Connectors "Installed" view has one honest "what do I have" surface. Browsing
// and installing happen on the Connectors Browse grid; this view never mutates,
// so the two can never disagree. The list-building lives in the DOM-free
// `extensionsInstalled` view-model for unit coverage; this component owns only
// the IPC loading and rendering.

import { useCallback, useEffect, useState } from 'react'

import type { ModuleEnablementOverrides, ThirdPartyModuleListResult } from '../../../../../shared/modules/manifest'
import type { SkillPackEntry } from '../../../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../../../shared/plugin-manifest'
import type { McpServerConfig } from '../../../types/workspace'
import { InlineNotice, Spinner, StatusDot } from '../../ui'
import { SettingsRow } from '../../settings/SettingsAtoms'
import { TRUST_PRESENTATION } from '../../settings/ThirdPartyModuleList'
import {
  deriveInstalledExtensions,
  type ExtensionsInstalledView,
  type InstalledExtension,
  type LoadedSource,
  type SourceNotice,
} from '../../settings/extensionsInstalled'

export function InstalledExtensionsInventory({
  mcpServers,
  moduleOverrides,
  workspaceRoot,
}: {
  // MCP servers reflect the store live, so the inventory's MCP group updates
  // without a re-list when a server is added or removed elsewhere on the surface.
  mcpServers: McpServerConfig[]
  moduleOverrides: ModuleEnablementOverrides
  workspaceRoot: string | null
}) {
  const [modules, setModules] = useState<LoadedSource<ThirdPartyModuleListResult>>({ status: 'loading' })
  const [skillPacks, setSkillPacks] = useState<LoadedSource<SkillPackEntry[]>>({ status: 'loading' })
  const [clis, setClis] = useState<LoadedSource<PluginRegistryListEntry[]>>({ status: 'loading' })

  const loadModules = useCallback(async () => {
    if (typeof window.api.listThirdPartyModules !== 'function') {
      setModules({ status: 'unsupported' })
      return
    }
    try {
      setModules({ status: 'ok', value: await window.api.listThirdPartyModules() })
    } catch (error) {
      setModules({ status: 'error', message: errorMessage(error, 'Could not list installed modules.') })
    }
  }, [])

  const loadClis = useCallback(async () => {
    if (typeof window.api.pluginsList !== 'function') {
      setClis({ status: 'unsupported' })
      return
    }
    try {
      const result = await window.api.pluginsList()
      setClis(result.ok ? { status: 'ok', value: result.plugins } : { status: 'error', message: result.message })
    } catch (error) {
      setClis({ status: 'error', message: errorMessage(error, 'Could not list installed agent CLIs.') })
    }
  }, [])

  const loadSkillPacks = useCallback(async () => {
    if (typeof window.api.skillPackListInstalled !== 'function') {
      setSkillPacks({ status: 'unsupported' })
      return
    }
    if (!workspaceRoot) {
      setSkillPacks({ status: 'unavailable', reason: 'Open a workspace to see its installed skill packs.' })
      return
    }
    try {
      const result = await window.api.skillPackListInstalled({ workspaceRoot })
      setSkillPacks(
        result.ok ? { status: 'ok', value: result.installed } : { status: 'error', message: result.message },
      )
    } catch (error) {
      setSkillPacks({ status: 'error', message: errorMessage(error, 'Could not list installed skill packs.') })
    }
  }, [workspaceRoot])

  useEffect(() => {
    void loadModules()
    void loadClis()
  }, [loadModules, loadClis])

  // Skill packs are workspace-scoped, so re-list when the active workspace
  // changes (loadSkillPacks closes over workspaceRoot).
  useEffect(() => {
    setSkillPacks({ status: 'loading' })
    void loadSkillPacks()
  }, [loadSkillPacks])

  const view = deriveInstalledExtensions({
    mcpServers,
    modules,
    moduleOverrides,
    skillPacks,
    clis,
  })

  return <InstalledView view={view} />
}

function NoticeList({ notices }: { notices: SourceNotice[] }) {
  return (
    <div className="space-y-2">
      {notices.map((notice) => (
        <InlineNotice key={`${notice.kind}:${notice.message}`} tone={notice.tone}>
          {notice.message}
        </InlineNotice>
      ))}
    </div>
  )
}

function InstalledView({ view }: { view: ExtensionsInstalledView }) {
  if (view.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} />
        Loading installed extensions…
      </div>
    )
  }

  if (view.status === 'unsupported') {
    return (
      <InlineNotice tone="warn">
        Installed extensions need a newer app build. Update Multicode and restart to see them here.
      </InlineNotice>
    )
  }

  // Degraded: zero rows but a source failed/was unavailable. Show only the
  // notices that explain why — never the "nothing installed" copy beneath them.
  if (view.status === 'degraded') {
    return <NoticeList notices={view.notices} />
  }

  if (view.status === 'empty') {
    return (
      <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
        Nothing installed yet. Get MCP servers, skill packs, agent CLIs, or modules from the Browse grid and they appear
        here.
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {view.notices.length > 0 ? <NoticeList notices={view.notices} /> : null}
      <div className="space-y-5">
        {view.groups.map((group) => (
          <section key={group.kind} className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-[12px] font-medium text-[color:var(--text-muted)]">{group.label}</span>
              <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
              <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">
                {group.items.length}
              </span>
            </div>
            <div className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
              {group.items.map((item) => (
                <InstalledRow key={item.key} item={item} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

// One inventory row, composed from the canonical `SettingsRow` (label + help on
// the left, a compact status on the right) so the inventory shares the one
// settings-row grammar rather than forking a second. The right-side control slot
// carries the row's decision-relevant status — trust for capability modules,
// active/inactive for MCP servers — as a StatusDot always paired with its text
// label, so status is never colour-only. Skill packs and CLIs have no such axis
// (presence is the only state), so they carry no dot. Module enablement is
// secondary and rides the help meta line as plain text, never a second dot.
function InstalledRow({ item }: { item: InstalledExtension }) {
  const meta = [item.source, item.detail, moduleEnabledMeta(item)].filter(Boolean).join(' · ')
  return (
    <SettingsRow
      label={item.name}
      help={<span className="font-mono text-[11px] text-[color:var(--text-subtle)]">{meta}</span>}
    >
      <RowStatus item={item} />
    </SettingsRow>
  )
}

function RowStatus({ item }: { item: InstalledExtension }) {
  if (item.kind === 'module' && item.trust) {
    const trust = TRUST_PRESENTATION[item.trust]
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
        {/* Decorative: the adjacent label already names the trust state. */}
        <StatusDot tone={trust.tone} />
        {trust.label}
      </span>
    )
  }
  if (item.kind === 'mcp') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
        <StatusDot tone={item.enabled ? 'good' : 'neutral'} />
        {item.enabled ? 'Active' : 'Inactive'}
      </span>
    )
  }
  return null
}

// Module enablement as a plain meta word (only meaningful once trusted — a
// trust-blocked module never loads regardless of intent).
function moduleEnabledMeta(item: InstalledExtension): string | undefined {
  if (item.kind !== 'module' || item.trust !== 'trusted') return undefined
  return item.enabled ? 'Enabled' : 'Disabled'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
