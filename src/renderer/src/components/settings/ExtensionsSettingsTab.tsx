import { useCallback, useEffect, useState } from 'react'

import type { ModuleEnablementOverrides, ThirdPartyModuleListResult } from '../../../../shared/modules/manifest'
import type { SkillPackEntry } from '../../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../../shared/plugin-manifest'
import type { McpServerConfig } from '../../types/workspace'
import { InlineNotice, Spinner, StatusDot } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'
import { TRUST_PRESENTATION } from './ThirdPartyModuleList'
import {
  deriveInstalledExtensions,
  type ExtensionsInstalledView,
  type InstalledExtension,
  type LoadedSource,
} from './extensionsInstalled'

// Settings → Extensions: the aggregated read-only inventory of everything
// installed across the four extension primitives (MCP servers, skill packs,
// agent CLIs, capability modules). This is the canonical inventory surface; the
// per-primitive tabs (MCPs / Skill packs / Modules) remain the place to install,
// trust, and toggle, so this view never duplicates those mutations and the two
// can never disagree. The Browse storefront is a later phase and is not wired
// here. The list-building lives in the DOM-free `extensionsInstalled` view-model
// for unit coverage; this component only owns IPC loading and rendering.

export function ExtensionsSettingsTab({
  mcpServers,
  moduleOverrides,
  workspaceRoot,
}: {
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

  return (
    <div
      role="tabpanel"
      id="settings-panel-extensions"
      aria-labelledby="settings-tab-extensions"
      className="space-y-4"
    >
      <InstalledView view={view} />
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

  return (
    <div className="space-y-5">
      <SettingsSectionTitle count={view.status === 'ready' ? view.total : 0}>Installed</SettingsSectionTitle>

      {view.notices.length > 0 ? (
        <div className="space-y-2">
          {view.notices.map((notice) => (
            <InlineNotice key={`${notice.kind}:${notice.message}`} tone={notice.tone}>
              {notice.message}
            </InlineNotice>
          ))}
        </div>
      ) : null}

      {view.status === 'empty' ? (
        <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
          Nothing installed yet. Add MCP servers, skill packs, agent CLIs, or modules from their settings tabs and they
          appear here.
        </div>
      ) : (
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
              <ul className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
                {group.items.map((item) => (
                  <InstalledRow key={item.key} item={item} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

// One inventory row. A single StatusDot encodes the row's decision-relevant
// status — trust for capability modules, active/inactive for MCP servers — and
// is always paired with its text label so status is never colour-only. Skill
// packs and CLIs have no such axis (presence is the only state), so they carry
// no dot. Module enablement is secondary and rides the meta line as plain text,
// never a second competing dot.
function InstalledRow({ item }: { item: InstalledExtension }) {
  const meta = [item.source, item.detail, moduleEnabledMeta(item)].filter(Boolean).join(' · ')
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{item.name}</span>
          <RowStatus item={item} />
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]">{meta}</div>
      </div>
    </li>
  )
}

function RowStatus({ item }: { item: InstalledExtension }) {
  if (item.kind === 'module' && item.trust) {
    const trust = TRUST_PRESENTATION[item.trust]
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
        {/* Decorative: the adjacent label already names the trust state. */}
        <StatusDot tone={trust.tone} />
        {trust.label}
      </span>
    )
  }
  if (item.kind === 'mcp') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
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
