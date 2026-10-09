import React, { useCallback, useId, useMemo, useRef, useState, type JSX } from 'react'

import type { CapabilityManifest, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { selectModuleEnabled } from '../../modules'
import { showToast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ChevronDownIcon, FolderPlusIcon, GithubSettingsIcon } from '../AppIcons'
import { InstallFromGitHubDialog } from '../extensions/InstallFromGitHubDialog'
import { ExtensionTrustReview } from '../extensions/ExtensionTrustReview'
import {
  ActionResultMessage,
  GhostButton,
  InboxSearchInput,
  LinkButton,
  MENU_LIST_CLASS,
  MenuItem,
  OutlineButton,
  PluginsGlyph,
  Popover,
  SegmentedControl,
  SettingCard,
  Switch,
  roveMenuFocus,
} from '../ui'
import { ExtensionIcon } from '../ui/ExtensionIcon'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { EXTENSIONS_BROWSE_DEEPLINK } from './extensionsRoute'
import {
  accessItems,
  builtInMatchesFilter,
  matchesQuery,
  moduleMatchesFilter,
  moduleMatchesQuery,
  modulesAwaitingRestart,
  needsReview,
  publisherName,
  resolveModuleEnabled,
  restartBannerTitle,
  sourceLabel,
  type ExtensionFilter,
} from './extensionsModel'
import { ExtensionMark } from './ExtensionRow'
import { COMING_SOON_IDS, MODULE_CATEGORY_GROUPS } from './ModuleControls'
import { RestartBanner } from './RestartBanner'
import { SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'
import {
  ExtensionGroup,
  ExtensionListRow,
  ExtensionRows,
  NoExtensionsInstalled,
  RejectedFolders,
  type ExtensionActions,
} from './ThirdPartyModuleList'
import { TrustReviewDialog } from './TrustReviewDialog'
import { useThirdPartyExtensions } from './useThirdPartyExtensions'

// Settings → Extensions (route id `modules`, kept so every deep link still
// lands): everything that plugs into the app, on one page.
//
// The page title and two header actions; a restart line when an extension
// waits on the next launch; the search and the filter; then the extensions a
// person installed — the ones that need review before anything else, then the
// trusted ones with their one switch — and the built-in modules folded away
// below. Short, factual labels and nothing explaining the page to itself.

// "Later" holds for the rest of the session, for the extensions it was
// pressed on. One that starts waiting afterwards brings the line back.
let restartDismissedFor: string | null = null

// Built-in modules in category order, as one list: the category headings were
// structure for a page that showed only these.
const BUILT_IN_MANIFESTS: CapabilityManifest[] = MODULE_CATEGORY_GROUPS.flatMap((group) => group.manifests)

function InstallMenu({
  installing,
  onFromFolder,
  onFromGitHub,
  onBrowse,
}: {
  installing: boolean
  onFromFolder: () => void
  onFromGitHub: () => void
  onBrowse: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const pick = (run: () => void) => () => {
    setOpen(false)
    run()
  }
  const rove = (event: React.KeyboardEvent) => roveMenuFocus(event, surfaceRef.current)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Install"
      popupRole="menu"
      placement="bottom-end"
      surfaceClassName={`min-w-[200px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={(surface) => {
        surfaceRef.current = surface
        surface.querySelector<HTMLElement>('[data-menu-item="true"]')?.focus()
      }}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <OutlineButton ref={ref} {...triggerProps} busy={installing} onClick={togglePopover}>
          Install
          <ChevronDownIcon className="icon-xs shrink-0" />
        </OutlineButton>
      )}
    >
      <MenuItem icon={<FolderPlusIcon className="icon-sm" />} onClick={pick(onFromFolder)} onKeyDown={rove}>
        From a folder
      </MenuItem>
      <MenuItem icon={<GithubSettingsIcon className="icon-sm" />} onClick={pick(onFromGitHub)} onKeyDown={rove}>
        From GitHub
      </MenuItem>
      <MenuItem icon={<PluginsGlyph className="icon-sm" />} onClick={pick(onBrowse)} onKeyDown={rove}>
        Browse marketplace
      </MenuItem>
    </Popover>
  )
}

function BuiltInRow({
  manifest,
  enabled,
  onToggle,
}: {
  manifest: CapabilityManifest
  enabled: boolean
  onToggle: (next: boolean) => void
}): JSX.Element {
  const comingSoon = COMING_SOON_IDS.has(manifest.id)
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5">
      <ExtensionIcon name={manifest.displayName} size={28} />
      <div className="min-w-0">
        <div className="text-body font-medium text-[color:var(--text-strong)]">{manifest.displayName}</div>
        {manifest.summary ? (
          <div className="text-meta leading-4 text-[color:var(--text-muted)]">{manifest.summary}</div>
        ) : null}
      </div>
      {comingSoon ? (
        <span className="text-meta text-[color:var(--text-subtle)]">Coming soon</span>
      ) : manifest.core ? (
        <span className="text-meta text-[color:var(--text-subtle)]">Always on</span>
      ) : (
        <Switch checked={enabled} onChange={onToggle} ariaLabel={`Enable ${manifest.displayName}`} />
      )}
    </li>
  )
}

export function ModulesSettingsTab(): JSX.Element {
  const overrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setModuleEnabled = useWorkspaceStore((state) => state.setModuleEnabled)
  const openSettingsOverlay = useWorkspaceStore((state) => state.openSettingsOverlay)
  const mcpSettings = useWorkspaceStore((state) => state.appSettings.mcp)
  const workspaceRoot = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.folderPath ?? null,
  )
  const extensions = useThirdPartyExtensions(setModuleEnabled)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ExtensionFilter>('all')
  const [builtInExpanded, setBuiltInExpanded] = useState(false)
  const [installFromGitHub, setInstallFromGitHub] = useState(false)
  const [reviewing, setReviewing] = useState<ThirdPartyModuleView | null>(null)
  const [detailsFor, setDetailsFor] = useState<string | null>(null)
  const [restartDismissed, setRestartDismissed] = useState<string | null>(restartDismissedFor)
  const ids = { review: useId(), installed: useId(), builtIn: useId(), builtInList: useId() }

  const { modules } = extensions
  const enabledFor = useCallback((module: ThirdPartyModuleView) => resolveModuleEnabled(overrides, module), [overrides])

  // ── Restart ──
  const waiting = useMemo(() => modulesAwaitingRestart(modules, enabledFor), [modules, enabledFor])
  const waitingKey = waiting
    .map((module) => module.manifest.id)
    .sort()
    .join('\n')
  const restartTitle = waitingKey && waitingKey !== restartDismissed ? restartBannerTitle(waiting) : null
  const restartApp = window.api.restartApp

  // ── Filtering ──
  const reviewCount = modules.filter(needsReview).length
  const visibleReview = modules.filter(
    (module) => needsReview(module) && moduleMatchesQuery(module, query) && moduleMatchesFilter(module, filter, false),
  )
  const visibleInstalled = modules.filter(
    (module) =>
      !needsReview(module) &&
      moduleMatchesQuery(module, query) &&
      moduleMatchesFilter(module, filter, enabledFor(module)),
  )
  const builtInVisible = BUILT_IN_MANIFESTS.filter(
    (manifest) =>
      matchesQuery(query, manifest.displayName, manifest.summary, manifest.id) &&
      builtInMatchesFilter(filter, manifest.core === true || selectModuleEnabled(overrides, manifest.id)),
  )
  const searching = query.trim().length > 0
  const builtInOpen = builtInExpanded || (searching && builtInVisible.length > 0)
  const nothingInstalled = extensions.loaded && modules.length === 0
  const showInstalledGroup = filter !== 'review' && (visibleInstalled.length > 0 || (nothingInstalled && !searching))
  const showBuiltIn = filter !== 'review' && builtInVisible.length > 0
  const nothingMatches =
    extensions.loaded &&
    visibleReview.length === 0 &&
    !showInstalledGroup &&
    !showBuiltIn &&
    (searching || filter !== 'all')

  const actions: ExtensionActions = {
    pendingId: extensions.pendingId,
    onReview: (module) => {
      setDetailsFor(null)
      setReviewing(module)
    },
    onSetEnabled: setModuleEnabled,
    onRevokeTrust: (module) => {
      setDetailsFor(null)
      void extensions.revokeTrust(module)
    },
    onUninstall: extensions.uninstall
      ? (module) => {
          setDetailsFor(null)
          void extensions.uninstall?.(module)
        }
      : null,
    onReveal: extensions.reveal ? (module) => void extensions.reveal?.(module) : null,
    onUpdate: (module, update) => {
      setDetailsFor(null)
      void extensions.update(module, update)
    },
    onCopyId: (module) => {
      void window.api
        .clipboardWriteText(module.manifest.id)
        .then(() => showToast({ tone: 'neutral', title: `Copied ${module.manifest.id}` }))
    },
  }

  const row = (module: ThirdPartyModuleView) => (
    <ExtensionListRow
      key={module.manifest.id}
      module={module}
      overrides={overrides}
      updateStates={extensions.updateStates}
      actions={actions}
      detailsOpen={detailsFor === module.manifest.id}
      onDetailsOpenChange={(open) =>
        setDetailsFor((current) => (open ? module.manifest.id : current === module.manifest.id ? null : current))
      }
    />
  )

  const reviewAccess = reviewing ? accessItems(reviewing.manifest.permissions) : { care: [], standard: [] }
  const pause = extensions.updatePause

  return (
    <div role="tabpanel" id="settings-panel-modules" aria-labelledby="settings-tab-modules" className="space-y-5">
      <SettingsPageHeader
        title="Extensions"
        actions={
          <>
            <GhostButton onClick={() => openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })}>
              Browse marketplace
            </GhostButton>
            <InstallMenu
              installing={extensions.installing}
              onFromFolder={() => void extensions.installFromFolder()}
              onFromGitHub={() => setInstallFromGitHub(true)}
              onBrowse={() => openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })}
            />
          </>
        }
      />

      <RestartBanner
        title={restartTitle}
        onLater={() => {
          restartDismissedFor = waitingKey
          setRestartDismissed(waitingKey)
        }}
        onRestart={
          typeof restartApp === 'function'
            ? async () => {
                await restartApp()
              }
            : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <InboxSearchInput
          value={query}
          onChange={setQuery}
          ariaLabel="Search extensions"
          placeholder="Search extensions"
        />
        <SegmentedControl<ExtensionFilter>
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All' },
            {
              value: 'review',
              label: 'Needs review',
              badge:
                reviewCount > 0 ? { count: reviewCount, label: `${reviewCount} to review`, tone: 'neutral' } : null,
            },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </div>

      <ActionResultMessage message={extensions.message} />

      {nothingMatches ? (
        <p className="text-body leading-5 text-[color:var(--text-muted)]">
          {searching ? <>Nothing matches &ldquo;{query.trim()}&rdquo;.</> : 'Nothing here.'}
        </p>
      ) : null}

      {visibleReview.length > 0 ? (
        <ExtensionGroup id={ids.review} title="Needs review" count={visibleReview.length}>
          <ExtensionRows label="Needs review">{visibleReview.map(row)}</ExtensionRows>
        </ExtensionGroup>
      ) : null}

      {showInstalledGroup ? (
        <ExtensionGroup id={ids.installed} title="Installed" count={visibleInstalled.length}>
          {visibleInstalled.length > 0 ? (
            <ExtensionRows label="Installed">{visibleInstalled.map(row)}</ExtensionRows>
          ) : (
            <NoExtensionsInstalled />
          )}
        </ExtensionGroup>
      ) : null}

      <RejectedFolders rejected={extensions.rejected} />

      {showBuiltIn ? (
        <section aria-labelledby={ids.builtIn} className="space-y-2">
          <SettingsSectionTitle id={ids.builtIn} count={builtInVisible.length}>
            <LinkButton
              ink="name"
              size="inherit"
              underline="never"
              aria-expanded={builtInOpen}
              aria-controls={ids.builtInList}
              onClick={() => setBuiltInExpanded(!builtInOpen)}
            >
              <ChevronDownIcon
                className={`icon-sm mr-1 inline-block align-middle text-[color:var(--text-subtle)] ${builtInOpen ? '' : '-rotate-90'}`}
              />
              Built in
            </LinkButton>
          </SettingsSectionTitle>
          <div id={ids.builtInList} hidden={!builtInOpen}>
            <SettingCard as="ul" ariaLabel="Built in">
              {builtInVisible.map((manifest) => (
                <BuiltInRow
                  key={manifest.id}
                  manifest={manifest}
                  enabled={selectModuleEnabled(overrides, manifest.id)}
                  onToggle={(next) => setModuleEnabled(manifest.id, next)}
                />
              ))}
            </SettingCard>
          </div>
        </section>
      ) : null}

      <TrustReviewDialog
        module={reviewing}
        icon={reviewing ? <ExtensionMark module={reviewing} doorIcon={null} size={40} /> : null}
        meta={
          reviewing
            ? [publisherName(reviewing.manifest), sourceLabel(reviewing), `v${reviewing.manifest.version}`]
                .filter(Boolean)
                .join(' · ')
            : ''
        }
        care={reviewAccess.care}
        standard={reviewAccess.standard}
        busy={reviewing !== null && extensions.pendingId === reviewing.manifest.id}
        onCancel={() => setReviewing(null)}
        onTrust={() => {
          if (!reviewing) return
          void extensions.trustAndEnable(reviewing).then((ok) => {
            if (ok) setReviewing(null)
          })
        }}
      />

      {pause ? (
        <Modal open onClose={extensions.cancelUpdateTrust} label={`Update ${pause.module.manifest.displayName}`}>
          <ModalHeader
            title={`Update ${pause.module.manifest.displayName} to v${pause.update.latestVersion}?`}
            leading={<ExtensionMark module={pause.module} doorIcon={null} size={40} />}
          />
          <ModalBody>
            <ExtensionTrustReview {...pause.review} />
          </ModalBody>
          <ModalFooter>
            <ModalButton variant="ghost" onClick={extensions.cancelUpdateTrust}>
              Cancel
            </ModalButton>
            <ModalButton variant="primary" onClick={() => void extensions.confirmUpdateTrust()}>
              Trust and update
            </ModalButton>
          </ModalFooter>
        </Modal>
      ) : null}

      <InstallFromGitHubDialog
        open={installFromGitHub}
        onClose={() => setInstallFromGitHub(false)}
        workspaceRoot={workspaceRoot}
        mcpSettings={mcpSettings}
        onInstalled={() => void extensions.reload()}
      />
    </div>
  )
}
