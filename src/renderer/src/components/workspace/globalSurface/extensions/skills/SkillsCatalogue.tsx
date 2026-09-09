// Skills: Installed, then one tab per source, the repository's folders as the
// groups inside it.
//
// Source-tabs ruling (2026-09-05). What went with the nested Sources rail:
//
//   - The four `sourceLayout()` shapes. Solo / flat / grouped / search-first
//     existed to decide how much of a source to put on screen at once, which
//     is the pager's job now. The rule they encoded — group by the folders the
//     repository actually keeps its skills in — survives, in
//     `deriveSkillCatalogueGroups`.
//   - Batch selection. The row idiom the ruling names carries ONE control, so
//     a row installs itself; a checkbox column and a footer "Install 6" is a
//     second interaction model on the same rows.
//
// Reading a skill: the row opens `SkillPage` as a dialog over the list, which
// is where Install lives for the skill in hand.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { scanPlugins, skillDirName, type SkillSource } from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, Spinner, StatusDot, TruncatedText } from '../../../../ui'
import { ExtensionIcon } from '../../../../ui/ExtensionIcon'
import { ConnectorRow } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { InstalledExtensionsInventory } from '../../../../panels/ConnectorsPanel/InstalledExtensionsInventory'
import { useWorkspaceStore } from '../../../../../store/workspaceStore'
import type { WorkspaceSkill } from '../../../../../../../shared/electron-api'
import { CatalogueHead, CatalogueSurface, type CatalogueAddMenu, type CatalogueSection } from '../catalogue/CatalogueSurface'
import {
  catalogueMonogram,
  catalogueTabLabel,
  deriveCatalogueTabs,
  resolveCatalogueTab,
  INSTALLED_TAB_ID,
  type CatalogueCount,
} from '../catalogue/catalogueTabs'
import { RecommendedSources } from '../catalogue/RecommendedSources'
import { SourceAvatar } from '../catalogue/SourceAvatar'
import { extensionIconProps, pluginsByFolder, skillArtwork } from '../catalogue/pluginArtwork'
import { SourceTabActions } from '../catalogue/SourceTabActions'
import { SkillPage } from './SkillPage'
import type { SkillSourcesState } from './useSkillSources'
import {
  bundledScanLine,
  deriveInstallAvailability,
  deriveSkillCatalogueGroups,
  findSkill,
  sourceDisplayName,
  summarizeInstallRun,
  summarizeSyncRun,
  type SkillListItem,
} from './skillsSurfaceModel'

const MISSING_API_MESSAGE = 'Skills need an app restart before they are available.'

/** The row's icon slot, in one place: the artwork ladder asks for its size. */
const ROW_ICON_SIZE = 36

export function SkillsCatalogue({
  sources,
  workspaceRoot,
  activeTabId,
  onSelectTab,
  query,
  onQueryChange,
  add,
  addNotice,
  onDismissAddNotice,
  onUseSkillInNewAgent,
}: {
  sources: SkillSourcesState
  workspaceRoot: string | null
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  query: string
  onQueryChange: (value: string) => void
  add: CatalogueAddMenu
  /** A source that could not be added — stated where the person is looking. */
  addNotice: string | null
  onDismissAddNotice: () => void
  onUseSkillInNewAgent: (skill: WorkspaceSkill) => void
}): JSX.Element {
  const [openSkillId, setOpenSkillId] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [report, setReport] = useState<{ sourceId: string; outcome: string | null; error: string | null } | null>(null)
  const [inventoryNonce, setInventoryNonce] = useState(0)
  const [skillMessage, setSkillMessage] = useState<string | null>(null)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)

  const counts = useMemo<Record<string, CatalogueCount>>(() => {
    const map: Record<string, CatalogueCount> = {}
    for (const source of sources.sources) {
      const load = sources.scans[source.id]
      map[source.id] =
        !load || load.status === 'loading'
          ? { status: 'loading' }
          : load.status === 'error'
            ? { status: 'error', message: load.message }
            : { status: 'ready', count: load.scan.skills.length }
    }
    return map
  }, [sources.scans, sources.sources])

  const tabs = deriveCatalogueTabs({
    kind: 'skills',
    sources: sources.sources,
    // Installed skills are workspace-scoped and read over IPC by the inventory
    // below; this is the count the same read already gave the door.
    installedCount: sources.installedRead.status === 'ready' ? sources.installedDirNames.size : null,
    counts,
  })
  const tabId = resolveCatalogueTab(tabs, activeTabId)
  const activeSource = tabs.find((tab) => tab.id === tabId)?.source ?? null
  const activeScan = activeSource ? sources.scans[activeSource.id] : undefined
  const scan = activeScan && activeScan.status === 'ready' ? activeScan.scan : null

  // The tab being looked at is the one whose source is read. A repository that
  // has never been scanned is a network read, so it waits for this rather than
  // firing on mount for every source in the list (useSkillSources).
  const ensureScan = sources.ensureScan
  useEffect(() => {
    if (activeSource) ensureScan(activeSource.id)
  }, [activeSource, ensureScan])

  const installSkill = useCallback(
    async (source: SkillSource, skillId: string): Promise<void> => {
      if (!workspaceRoot) return
      if (typeof window.api.skillsInstall !== 'function') {
        setReport({ sourceId: source.id, outcome: null, error: MISSING_API_MESSAGE })
        return
      }
      setInstalling(skillId)
      setReport(null)
      try {
        const result = await window.api.skillsInstall({ sourceId: source.id, skillId, workspaceRoot })
        setReport(
          result.ok
            ? { sourceId: source.id, outcome: summarizeInstallRun(1, []), error: null }
            : { sourceId: source.id, outcome: null, error: summarizeInstallRun(0, [{ skillId, message: result.message }]) },
        )
      } catch (error) {
        setReport({
          sourceId: source.id,
          outcome: null,
          error: summarizeInstallRun(0, [{ skillId, message: describe(error) }]),
        })
      } finally {
        setInstalling(null)
        sources.refreshInstalled()
      }
    },
    [sources, workspaceRoot],
  )

  // Removing an installed skill takes its directory back out of every harness
  // dir that holds a copy. The outcome is stated: a removal that failed must
  // never leave the row looking gone.
  const removeSkill = useCallback(
    async (dirName: string): Promise<void> => {
      if (!workspaceRoot) return
      setSkillMessage(null)
      try {
        const result = await window.api.skillsUninstall({ workspaceRoot, dirName })
        setSkillMessage(result.ok ? `${dirName} removed.` : result.message)
        if (result.ok) {
          setInventoryNonce((count) => count + 1)
          sources.refreshInstalled()
        }
      } catch (error) {
        setSkillMessage(describe(error))
      }
    },
    [sources, workspaceRoot],
  )

  const sections = useMemo<CatalogueSection<SkillListItem>[]>(
    () =>
      scan
        ? deriveSkillCatalogueGroups({ scan, installedDirNames: sources.installedDirNames, query })
        : [],
    [query, scan, sources.installedDirNames],
  )

  // A skill wears its plugin's mark when it ships inside one, so the plugins
  // are indexed by the folder name `skillPluginFolder()` reads off a skill's
  // id — once per scan, not once per row.
  const pluginsByName = useMemo(() => pluginsByFolder(scan ? scanPlugins(scan) : []), [scan])

  const renderRow = useCallback(
    (item: SkillListItem): React.ReactNode => (
      <ConnectorRow
        key={item.skillId}
        icon={
          <ExtensionIcon
            name={item.name}
            size={ROW_ICON_SIZE}
            {...extensionIconProps(
              skillArtwork(item, activeSource ?? undefined, ROW_ICON_SIZE, pluginsByName.get(item.plugin)),
            )}
          />
        }
        name={item.name}
        // The plugin it ships inside, when that is what tells it apart from
        // the row above it: "access · discord", "access · telegram".
        meta={item.plugin || undefined}
        summary={item.description || `${item.fileCount} file${item.fileCount === 1 ? '' : 's'}`}
        // Not "Skill": every row in the Skills door is one. What a chip is for
        // is a fact the name does not carry.
        chips={item.hasExecutables ? ['Runs scripts'] : []}
        // A name the Agent Skills specification would reject is stated on the
        // row: the skill still lists, and still installs. Truncated like the
        // summary above it, because a row is one line per fact — the detail
        // pane has the room to say it in full.
        status={
          item.nameWarning ? (
            <>
              <StatusDot tone="warn" />
              <TruncatedText as="span" text={item.nameWarning} className="min-w-0 flex-1" />
            </>
          ) : undefined
        }
        selected={openSkillId === item.skillId}
        onOpen={() => setOpenSkillId(item.skillId)}
        actions={
          item.installed ? (
            <span className="pr-1 text-meta font-medium text-[color:var(--accent-primary)]">Installed</span>
          ) : (
            <GhostButton
              size="sm"
              disabled={!workspaceRoot || installing !== null}
              onClick={() => activeSource && void installSkill(activeSource, item.skillId)}
              className="border border-[color:var(--border-default)]"
              aria-label={`Install ${item.name}`}
            >
              {installing === item.skillId ? 'Installing…' : 'Install'}
            </GhostButton>
          )
        }
      />
    ),
    [activeSource, installSkill, installing, openSkillId, pluginsByName, workspaceRoot],
  )

  const thisReport = report?.sourceId === activeSource?.id ? report : null

  const head =
    tabId === INSTALLED_TAB_ID ? (
      <CatalogueHead
        name="Installed"
        stateLine={
          workspaceRoot
            ? 'The skills installed in this workspace, grouped by where they came from.'
            : 'Open a workspace to see the skills installed in it — a skill installs into a workspace, not into the app.'
        }
      />
    ) : activeSource ? (
      <CatalogueHead
        monogram={<SourceAvatar source={activeSource} monogram={catalogueMonogram(activeSource)} />}
        name={catalogueTabLabel(activeSource)}
        // Where it comes from, and nothing else: the repository, or the folder
        // on this machine. What it holds is on the tab and the section heading;
        // what happened to it last is a notice below.
        stateLine={activeSource.path || sourceDisplayName(activeSource)}
        actions={
          <SourceTabActions
            source={activeSource}
            workspaceRoot={workspaceRoot}
            onSynced={(source, result) => {
              sources.applySync(source, result.scan)
              sources.refreshInstalled()
              setReport({ sourceId: source.id, outcome: summarizeSyncRun(result), error: null })
            }}
            // The manual update check reports into the same head line a sync
            // reports into: one place the source says what just happened to it.
            onCheckReport={(source, message) =>
              setReport({ sourceId: source.id, outcome: message, error: null })
            }
            onSyncFailed={(source, message) => setReport({ sourceId: source.id, outcome: null, error: message })}
            onRemoved={() => {
              sources.refreshSources()
              onSelectTab(INSTALLED_TAB_ID)
            }}
          />
        }
      />
    ) : null

  const bundled = bundledScanLine(scan)
  const notices = (
    <>
      {thisReport?.error ? <InlineNotice tone="error" title="That did not complete." hint={thisReport.error} /> : null}
      {/* What the last Sync or update check on this source reported, and
          whether this listing is the copy the build shipped rather than a
          read of the repository: each a fact about the listing, stated once
          under the head rather than folded into it. */}
      {thisReport?.outcome ? <InlineNotice tone="warn">{thisReport.outcome}</InlineNotice> : null}
      {bundled ? <InlineNotice tone="warn">{bundled}</InlineNotice> : null}
      {addNotice ? (
        <InlineNotice
          tone="error"
          title="That source was not added."
          hint={addNotice}
          action={<GhostButton onClick={onDismissAddNotice}>Dismiss</GhostButton>}
        />
      ) : null}
      {skillMessage ? <InlineNotice tone="warn">{skillMessage}</InlineNotice> : null}
    </>
  )

  const body = ((): React.ReactNode => {
    if (tabId === INSTALLED_TAB_ID) {
      return (
        <div className="space-y-6">
          <InstalledExtensionsInventory
            key={inventoryNonce}
            mcpServers={[]}
            moduleOverrides={moduleOverrides}
            workspaceRoot={workspaceRoot}
            kinds={['skill']}
            sourceGrouping={{ sources: sources.sources, records: sources.installedPlugins }}
            paging={{ noun: 'skill', query }}
            onRemoveSkill={(dirName) => void removeSkill(dirName)}
            onUseSkillInNewAgent={onUseSkillInNewAgent}
          />
          {/* Where somebody stands when they have run out of skills to install:
              under what they have, the places to get more (MC-2519). */}
          <RecommendedSources
            existingSources={sources.sources}
            onAdded={(sourceId) => {
              sources.refreshSources()
              onSelectTab(sourceId)
            }}
          />
        </div>
      )
    }
    if (sources.sourcesLoad.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          title="Your skill sources could not be read."
          hint="Nothing was changed. Try again, or add a source to start a fresh list."
          detail={sources.sourcesLoad.message}
          action={<GhostButton onClick={sources.refreshSources}>Try again</GhostButton>}
        />
      )
    }
    if (!activeSource) return <LoadingLine label="Loading skill sources…" />
    if (!activeScan || activeScan.status === 'loading') {
      return <LoadingLine label={`Reading ${catalogueTabLabel(activeSource)}…`} />
    }
    if (activeScan.status === 'error') {
      return (
        <InlineNotice
          tone="error"
          title={`${catalogueTabLabel(activeSource)} could not be read.`}
          hint="Its skills are not listed below — this is not an empty source."
          detail={activeScan.message}
          action={<GhostButton onClick={() => sources.refreshScan(activeSource.id)}>Try again</GhostButton>}
        />
      )
    }
    return null
  })()

  const openSkill = scan && openSkillId ? findSkill(scan, openSkillId) : null
  const detail =
    activeSource && openSkill ? (
      <SkillPage
        key={`${activeSource.id}::${openSkill.id}`}
        source={activeSource}
        skill={openSkill}
        installed={sources.installedDirNames.has(skillDirName(openSkill.id))}
        installing={installing !== null}
        availability={deriveInstallAvailability(workspaceRoot, 1)}
        onInstall={() => void installSkill(activeSource, openSkill.id)}
        onClose={() => setOpenSkillId(null)}
      />
    ) : null

  return (
    <CatalogueSurface<SkillListItem>
      title="Skills"
      tabs={tabs}
      activeTabId={tabId}
      onSelectTab={(next) => {
        setOpenSkillId(null)
        onSelectTab(next)
      }}
      search={{ query, onQueryChange, placeholder: 'Search this tab' }}
      add={add}
      head={head}
      notices={notices}
      body={body}
      sections={sections}
      renderRow={renderRow}
      noun="skill"
      detail={detail}
    />
  )
}

function LoadingLine({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
      <Spinner size={14} />
      {label}
    </div>
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
