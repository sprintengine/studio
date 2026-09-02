// Skills: a surface you enter, and it holds its own sources.
//
// The Extensions rail lists extension *kinds*. Sources are instances, and there
// is no bound on how many a user adds, so they live in a nested rail inside
// this surface — with Add a source and Discover, which were never global
// actions either. Selecting a source keeps that rail, because switching between
// sources should not cost a round trip through an index.
//
// Sources are app-level; installing is workspace-level (the door can be open
// with no workspace, and Install says so rather than doing nothing).

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { skillDirName, type SkillSource } from '../../../../../../../shared/skills'
import { PlusIcon } from '../../../../AppIcons'
import { GhostButton, InlineNotice, OutlineButton, Spinner } from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { SurfaceCanvasState, SurfaceRail, type SurfaceRailRow } from '../../surfaceSubstrate'
import { AddSkillSourceModal } from './AddSkillSourceModal'
import { addedRepoKeys } from './discoverModel'
import { SkillPage } from './SkillPage'
import { SkillSourceCanvas } from './SkillSourceCanvas'
import { SkillsDiscover } from './SkillsDiscover'
import { SourceMonogram } from './SourceMonogram'
import type { SkillSourcesState } from './useSkillSources'
import {
  deriveInstallAvailability,
  deriveSourceRailRows,
  findSkill,
  skillSourceCommitsUrl,
  sourceDisplayName,
  summarizeInstallRun,
  summarizeSyncRun,
  type SkillInstallFailure,
} from './skillsSurfaceModel'

const MISSING_API_MESSAGE = 'Skills need an app restart before they are available.'

type SkillsView =
  | { kind: 'source'; sourceId: string }
  | { kind: 'skill'; sourceId: string; skillId: string }
  | { kind: 'discover' }

export function SkillsSurface({
  sources,
  workspaceRoot,
  onBrowseMcpServers,
  onConfigureGitHubToken,
}: {
  /** Owned by the door, so its rail row can state the same counts this does. */
  sources: SkillSourcesState
  workspaceRoot: string | null
  /** The connector-skills deflection: those skills are browsed with their servers. */
  onBrowseMcpServers: () => void
  /** Opens where the GitHub token is set — Discover's code search requires one. */
  onConfigureGitHubToken: () => void
}): JSX.Element {
  const [view, setView] = useState<SkillsView | null>(null)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // The repository the Add-a-source modal opens on. A Discover candidate lands
  // in the same field a pasted one does, and takes the same path from there.
  const [addRepo, setAddRepo] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  // Failures only. A successful install already reports itself as state — the
  // row and the skill page flip to Installed — so a success line above the
  // canvas would restate what the screen shows while shifting it down.
  const [installError, setInstallError] = useState<string | null>(null)
  // A set, not one id: syncing one source and opening another must not leave
  // the second one's button saying it is idle while it is still running.
  const [syncingSourceIds, setSyncingSourceIds] = useState<ReadonlySet<string>>(new Set())
  // Kept per source, so opening another one does not show it that source's line.
  const [syncReport, setSyncReport] = useState<{
    sourceId: string
    outcome: string | null
    error: string | null
  } | null>(null)

  // Land on the first source rather than an index the rail already replaces.
  useEffect(() => {
    if (view !== null || sources.sources.length === 0) return
    setView({ kind: 'source', sourceId: sources.sources[0].id })
  }, [sources.sources, view])

  const openSource = useCallback((sourceId: string) => {
    setView({ kind: 'source', sourceId })
    setActiveGroup(null)
    setQuery('')
    setSelected(new Set())
    setInstallError(null)
  }, [])

  const activeSourceId = view && view.kind !== 'discover' ? view.sourceId : null
  const activeSource = useMemo(
    () => sources.sources.find((source) => source.id === activeSourceId) ?? null,
    [sources.sources, activeSourceId],
  )
  const activeScan = activeSourceId ? sources.scans[activeSourceId] : undefined
  const commitsUrl = activeSource ? skillSourceCommitsUrl(activeSource) : null

  // What Discover reads to say "Added" instead of offering a scan for a
  // repository the list already holds.
  const addedRepos = useMemo(
    () => addedRepoKeys(sources.sources.map((source) => source.repo)),
    [sources.sources],
  )

  const toggleSelect = useCallback((skillId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }, [])

  const selectAll = useCallback((skillIds: string[]) => {
    setSelected((current) => new Set([...current, ...skillIds]))
  }, [])

  const installSkills = useCallback(
    async (sourceId: string, skillIds: string[]): Promise<void> => {
      if (!workspaceRoot || skillIds.length === 0) return
      if (typeof window.api.skillsInstall !== 'function') {
        setInstallError(MISSING_API_MESSAGE)
        return
      }
      setInstallError(null)
      let installed = 0
      const failures: SkillInstallFailure[] = []
      const done = new Set<string>()
      // One at a time: each install fetches every file of its skill, and a
      // fan-out of those reads is what a rate limit is for.
      for (let index = 0; index < skillIds.length; index += 1) {
        const skillId = skillIds[index]
        setInstalling(
          skillIds.length === 1 ? 'Installing…' : `Installing ${index + 1} of ${skillIds.length}…`,
        )
        try {
          const result = await window.api.skillsInstall({ sourceId, skillId, workspaceRoot })
          if (result.ok) {
            installed += 1
            done.add(skillId)
          } else {
            failures.push({ skillId, message: result.message })
          }
        } catch (error) {
          failures.push({ skillId, message: error instanceof Error ? error.message : String(error) })
        }
      }
      setInstalling(null)
      // Only what actually installed leaves the selection, so a failed skill
      // stays selected and can be retried without hunting for it again.
      setSelected((current) => new Set([...current].filter((skillId) => !done.has(skillId))))
      setInstallError(failures.length === 0 ? null : summarizeInstallRun(installed, failures))
      sources.refreshInstalled()
    },
    [sources, workspaceRoot],
  )

  /**
   * Sync: re-read the source at its current head, take the scan it returns, and
   * let it report what came in. A failure leaves the list on screen alone and
   * says so — a stale list wearing a fresh timestamp is the one outcome a sync
   * must never produce.
   */
  const syncSource = useCallback(
    async (source: SkillSource): Promise<void> => {
      if (typeof window.api.skillsSyncSource !== 'function') {
        setSyncReport({ sourceId: source.id, outcome: null, error: MISSING_API_MESSAGE })
        return
      }
      if (syncingSourceIds.has(source.id)) return
      setSyncingSourceIds((current) => new Set(current).add(source.id))
      setSyncReport(null)
      try {
        const result = await window.api.skillsSyncSource({ sourceId: source.id, workspaceRoot })
        if (!result.ok) {
          setSyncReport({ sourceId: source.id, outcome: null, error: result.message })
          return
        }
        sources.applySync(result.source, result.scan)
        sources.refreshInstalled()
        // A selection made before the sync can name a skill the source has
        // stopped carrying; installing it would fail with "not in this source".
        setSelected((current) => {
          const present = new Set(result.scan.skills.map((skill) => skill.id))
          return new Set([...current].filter((skillId) => present.has(skillId)))
        })
        setSyncReport({
          sourceId: source.id,
          outcome: summarizeSyncRun({
            added: result.added,
            removed: result.removed,
            refreshed: result.refreshed,
            failures: result.failures,
          }),
          error: null,
        })
      } catch (error) {
        setSyncReport({
          sourceId: source.id,
          outcome: null,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setSyncingSourceIds((current) => {
          const next = new Set(current)
          next.delete(source.id)
          return next
        })
      }
    },
    [sources, syncingSourceIds, workspaceRoot],
  )

  // The skill page, wired once: the source's own page renders it for a solo
  // source, and opening a row renders it on its own.
  const renderSkillPage = (skillId: string, options?: { embedded?: boolean }): React.ReactNode => {
    if (!activeSource || !activeScan || activeScan.status !== 'ready') return null
    const skill = findSkill(activeScan.scan, skillId)
    if (!skill) {
      return (
        <InlineNotice tone="warn">
          {`That skill is no longer in ${sourceDisplayName(activeSource)}. Sync the source to see what it holds now.`}
        </InlineNotice>
      )
    }
    return (
      <SkillPage
        source={activeSource}
        skill={skill}
        installed={sources.installedDirNames.has(skillDirName(skill.id))}
        installing={installing !== null}
        availability={deriveInstallAvailability(workspaceRoot, 1)}
        onInstall={() => void installSkills(activeSource.id, [skill.id])}
        embedded={options?.embedded}
        // A source of one skill IS this page; there is nothing to go back to.
        onBack={activeScan.scan.skills.length === 1 ? undefined : () => openSource(activeSource.id)}
      />
    )
  }

  const railRows: SurfaceRailRow[] = deriveSourceRailRows(sources.sources, sources.scans).map((row) => ({
    id: row.id,
    title: row.name,
    stateLine: row.stateLine,
    tooltip: row.tooltip,
    icon: <SourceMonogram monogram={row.monogram} />,
  }))

  const rail = (
    <nav
      aria-label="Skill sources"
      className="flex w-[216px] shrink-0 flex-col overflow-y-auto border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-2.5"
    >
      <SurfaceRail
        label="Sources"
        rows={railRows}
        selectedId={view?.kind === 'discover' ? null : (activeSourceId ?? null)}
        onSelect={openSource}
        newAffordance={{ label: 'Add a source', onActivate: () => setAddRepo('') }}
      />
      <div className="mt-auto border-t border-[color:var(--border-subtle)] pt-2">
        <button
          type="button"
          aria-current={view?.kind === 'discover' ? 'true' : undefined}
          onClick={() => setView({ kind: 'discover' })}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
            view?.kind === 'discover'
              ? 'bg-[color:var(--bg-selected)]'
              : 'hover:bg-[color:var(--bg-hover)]'
          }`}
        >
          <CompassGlyph />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-medium text-[color:var(--text-strong)]">Discover</span>
            <span className="truncate text-meta text-[color:var(--text-subtle)]">Skills on GitHub</span>
          </span>
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-full min-h-0">
      {rail}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {sources.sourcesLoad.status === 'loading' ? (
          <SurfaceCanvasState kind="loading" label="Loading skill sources…" />
        ) : sources.sourcesLoad.status === 'error' ? (
          <SurfaceCanvasState
            kind="error"
            title="Your skill sources could not be read."
            hint="Nothing was changed. Try again, or add a source to start a fresh list."
            detail={sources.sourcesLoad.message}
            onRetry={sources.refreshSources}
          />
        ) : view?.kind === 'discover' ? (
          <SkillsDiscover
            addedRepos={addedRepos}
            onScanRepo={(repo) => setAddRepo(repo)}
            onConfigureToken={onConfigureGitHubToken}
          />
        ) : !activeSource ? (
          // First run: the door has never held a source, so this is the one
          // canvas that keeps the richer treatment. An svg glyph, never a
          // character (the glyph spec), and the kit's outline button rather
          // than a ghost wearing a border.
          <SurfaceCanvasState
            kind="empty"
            firstRun
            glyph={<PlusIcon className="icon-md" />}
            title="No skill sources"
            body="Add a public GitHub repository of skills to browse what it holds."
            action={<OutlineButton onClick={() => setAddRepo('')}>Add a source</OutlineButton>}
          />
        ) : !activeScan || activeScan.status === 'loading' ? (
          <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
            <Spinner size={14} />
            {`Reading ${sourceDisplayName(activeSource)}…`}
          </div>
        ) : activeScan.status === 'error' ? (
          <div className="py-4">
            <InlineNotice
              tone="error"
              title={`${sourceDisplayName(activeSource)} could not be read.`}
              hint="Its skills are not listed below — this is not an empty source."
              detail={activeScan.message}
              action={
                <GhostButton onClick={() => sources.refreshScan(activeSource.id)}>Try again</GhostButton>
              }
            />
          </div>
        ) : (
          <>
            {installError ? (
              <div className="mb-3">
                <InlineNotice tone="error" title="Some skills did not install." hint={installError} />
              </div>
            ) : null}
            {view?.kind === 'skill' ? (
              renderSkillPage(view.skillId)
            ) : (
              <SkillSourceCanvas
                source={activeSource}
                scan={activeScan.scan}
                scanLoad={activeScan}
                installedDirNames={sources.installedDirNames}
                installedError={
                  sources.installedRead.status === 'error' ? sources.installedRead.message : null
                }
                activeGroup={activeGroup}
                onActiveGroupChange={setActiveGroup}
                query={query}
                onQueryChange={setQuery}
                selected={selected}
                onToggleSelect={toggleSelect}
                onSelectAll={selectAll}
                onClearSelection={() => setSelected(new Set())}
                onOpenSkill={(skillId) =>
                  setView({ kind: 'skill', sourceId: activeSource.id, skillId })
                }
                availability={deriveInstallAvailability(workspaceRoot, selected.size)}
                installing={installing}
                onInstallSelected={() => void installSkills(activeSource.id, [...selected])}
                sync={{
                  onSync: activeSource.kind === 'github' ? () => void syncSource(activeSource) : null,
                  syncing: syncingSourceIds.has(activeSource.id),
                  outcome: syncReport?.sourceId === activeSource.id ? syncReport.outcome : null,
                  error: syncReport?.sourceId === activeSource.id ? syncReport.error : null,
                  onOpenHistory: commitsUrl ? () => void window.api.openExternal(commitsUrl) : null,
                }}
                onBrowseMcpServers={onBrowseMcpServers}
                renderSkillPage={renderSkillPage}
              />
            )}
          </>
        )}
      </div>
      <AddSkillSourceModal
        open={addRepo !== null}
        initialRepo={addRepo ?? ''}
        onClose={() => setAddRepo(null)}
        onAdded={(source: SkillSource) => {
          sources.refreshSources()
          openSource(source.id)
        }}
        onRemoved={() => {
          sources.refreshSources()
          setView(null)
        }}
      />
    </div>
  )
}

function CompassGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-md shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.2 5.8-1.3 3.1-3.1 1.3 1.3-3.1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
