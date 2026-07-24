// The skill-pack ecosystem catalog — state and list UI shared by the Extensions
// door's Skill packs canvas and ConnectorsManage's "Get more skill packs"
// disclosure (MC-1847 C2). Extracted from ConnectorsManage so the two mounts
// share one load, one install/remove path, and one row treatment instead of
// growing lookalikes. Every store action and window.api.* call is unchanged.

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SkillPackEntry } from '../../../../../shared/electron-api'
import type { SkillPackCatalogEntry, SkillPackSettings } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { GhostButton } from '../../ui'
import { SkillPackInfoPanel, SkillPackMonogram, groupSkillPackCatalog } from '../../settings/SkillPacksCatalog'
import { ConnectorRow, ConnectorSectionHeading } from './ConnectorRow'

const EMPTY_SKILL_PACK_SETTINGS: SkillPackSettings = { installed: {} }

export type SkillPackCatalogState = {
  catalog: SkillPackCatalogEntry[]
  /** The catalog read's own state, so hosts can distinguish "still loading"
   *  and "unavailable" from a genuinely empty catalog. */
  status: 'loading' | 'ready' | 'error'
  /** User-facing status line: install/remove confirmations or load failures. */
  message: string | null
  pendingId: string | null
  installed: SkillPackSettings['installed']
  /** Install-or-remove. Without `intent` the store's installed flag decides;
   *  a caller acting on its OWN listing (the inventory's Remove) passes an
   *  explicit intent so a stale store flag can never invert the action. */
  toggle: (pack: SkillPackCatalogEntry, intent?: 'install' | 'remove') => Promise<void>
  /** Remove by slug (the inventory's row shape); resolves through the catalog
   *  entry when present, else the store's installed record. */
  removeBySlug: (slug: string) => void
}

// Owns the catalog read, the per-workspace installed sync into the store, and
// the install/remove toggle. `onChanged` fires after a successful install or
// remove so hosts can refresh IPC-backed views (the inventory remount).
export function useSkillPackCatalog(
  workspaceRoot: string | null,
  onChanged?: () => void,
): SkillPackCatalogState {
  const skillPackSettings = useWorkspaceStore((s) => s.appSettings.skillPacks ?? EMPTY_SKILL_PACK_SETTINGS)
  const setSkillPacksInstalled = useWorkspaceStore((s) => s.setSkillPacksInstalled)
  const upsertSkillPack = useWorkspaceStore((s) => s.upsertSkillPack)
  const removeSkillPackFromStore = useWorkspaceStore((s) => s.removeSkillPack)

  const [catalog, setCatalog] = useState<SkillPackCatalogEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (typeof window.api.skillPackListCatalog !== 'function') {
      setStatus('error')
      setMessage('Skill packs need an app restart before they are available.')
      return () => {
        cancelled = true
      }
    }
    void window.api.skillPackListCatalog().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setCatalog(result.packs)
        setStatus('ready')
      } else {
        setStatus('error')
        setMessage(result.message)
      }
    }).catch((error) => {
      if (cancelled) return
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'Unable to load skill-pack catalog.')
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!workspaceRoot) {
      setSkillPacksInstalled([])
      return
    }
    if (typeof window.api.skillPackListInstalled !== 'function') return
    let cancelled = false
    void window.api
      .skillPackListInstalled({ workspaceRoot })
      .then((result) => {
        if (cancelled) return
        if (result.ok) setSkillPacksInstalled(result.installed)
        else setMessage(result.message)
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : 'Unable to read installed skill packs.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, setSkillPacksInstalled])

  const toggle = useCallback(
    async (pack: SkillPackCatalogEntry, intent?: 'install' | 'remove') => {
      if (!workspaceRoot) {
        setMessage('Open a workspace folder before installing skill packs.')
        return
      }
      const installed = skillPackSettings.installed[pack.id]
      const removing = intent ? intent === 'remove' : Boolean(installed)
      setPendingId(pack.id)
      setMessage(null)
      try {
        if (removing) {
          const result = await window.api.skillPackRemove({
            workspaceRoot,
            slug: pack.slug,
            installedDirName: pack.installedDirName,
          })
          if (result.ok) {
            removeSkillPackFromStore(pack.id)
            setMessage(`${pack.name} removed.`)
            onChanged?.()
          } else {
            setMessage(result.message)
          }
        } else {
          const result = await window.api.skillPackInstall({
            workspaceRoot,
            slug: pack.slug,
            harnesses: pack.harnesses,
            installedDirName: pack.installedDirName,
          })
          if (result.ok) {
            const entry: SkillPackEntry = {
              ...result.installed,
              id: pack.id,
              name: pack.name,
              category: pack.category,
              description: pack.description,
              version: pack.version,
              sourceUrl: pack.sourceUrl,
              installedDirName: pack.installedDirName ?? result.installed.installedDirName,
            }
            upsertSkillPack(entry)
            setMessage(
              pack.setupNotes ? `${pack.name} installed. ${pack.setupNotes}` : `${pack.name} installed.`,
            )
            onChanged?.()
          } else {
            setMessage(result.message)
          }
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Skill pack action failed.')
      } finally {
        setPendingId(null)
      }
    },
    [workspaceRoot, removeSkillPackFromStore, skillPackSettings.installed, upsertSkillPack, onChanged],
  )

  // Inventory rows key skill packs by slug; resolve back to the catalog entry
  // (or the store's installed record) and route through the toggle path.
  const removeBySlug = useCallback(
    (slug: string) => {
      // Explicit remove intent: the inventory row lists the pack from its own
      // IPC read, so a lagging store flag must not flip this into an install.
      const catalogEntry = catalog.find((entry) => entry.slug === slug)
      if (catalogEntry) {
        void toggle(catalogEntry, 'remove')
        return
      }
      const pack = Object.values(skillPackSettings.installed).find((entry) => entry.slug === slug)
      if (pack) {
        void toggle(
          {
            id: pack.id,
            slug: pack.slug,
            name: pack.name,
            installedDirName: pack.installedDirName,
            harnesses: pack.harnesses,
          },
          'remove',
        )
      }
    },
    [catalog, skillPackSettings.installed, toggle],
  )

  return {
    catalog,
    status,
    message,
    pendingId,
    installed: skillPackSettings.installed,
    toggle,
    removeBySlug,
  }
}

// The grouped catalog list: category sections of compact rows with
// install/remove, plus the info side panel for the opened pack. Presentation
// only — every action routes through the hook state.
export function SkillPackCatalogList({ state }: { state: SkillPackCatalogState }): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const grouped = useMemo(() => groupSkillPackCatalog(state.catalog), [state.catalog])
  const selected = selectedId ? state.catalog.find((pack) => pack.id === selectedId) ?? null : null
  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-4">
        {grouped.map(([category, packs]) => (
          <div key={category} className="space-y-2">
            <ConnectorSectionHeading label={category} count={packs.length} />
            <div className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
              {packs.map((pack) => {
                const installed = Boolean(state.installed[pack.id])
                const pending = state.pendingId === pack.id
                return (
                  <ConnectorRow
                    key={pack.id}
                    variant="compact"
                    icon={<SkillPackMonogram name={pack.name} size={24} />}
                    name={pack.name}
                    summary={pack.description}
                    selected={selectedId === pack.id}
                    onOpen={() => setSelectedId((current) => (current === pack.id ? null : pack.id))}
                    status={installed ? <span>Installed</span> : undefined}
                    actions={
                      <GhostButton
                        size="sm"
                        onClick={() => void state.toggle(pack)}
                        disabled={pending}
                        className="border border-[color:var(--border-default)]"
                      >
                        {pending ? (installed ? 'Removing…' : 'Installing…') : installed ? 'Remove' : 'Install'}
                      </GhostButton>
                    }
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {selected ? (
        <SkillPackInfoPanel
          pack={selected}
          installed={Boolean(state.installed[selected.id])}
          pending={state.pendingId === selected.id}
          onToggle={() => void state.toggle(selected)}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  )
}
