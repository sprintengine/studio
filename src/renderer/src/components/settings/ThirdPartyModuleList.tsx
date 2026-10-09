import React, { type JSX } from 'react'

import type { MarketplaceUpdateStatesResult } from '../../../../shared/electron-api'
import type {
  ModuleEnablementOverrides,
  ModuleManifestIssue,
  ModuleTrustStatus,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import {
  describeCapabilityPermission,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
} from '../../../../shared/modules/permissions'
import { getRendererHost } from '../../modules'
import { getModuleContributionError } from '../../modules/ModuleContributionBoundary'
import { getThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import type { Tone } from '../ui/tokens'
import { Badge, EmptyState, GhostButton, InlineNotice, OutlineButton, SettingCard, type OverflowMenuItem } from '../ui'
import { deriveContributions, moduleDoorIcon } from './extensionContributions'
import {
  CannotTrustTrailing,
  ExtensionDetails,
  ExtensionMark,
  ExtensionRow,
  ExtensionStateLabel,
  InstalledTrailing,
  ReviewTrailing,
} from './ExtensionRow'
import {
  accessItems,
  isSigned,
  marketplaceUpdateFor,
  moduleMeta,
  moduleProblem,
  problemText,
  publisherName,
  resolveModuleEnabled,
  runState,
  sourceLabel,
  type ExtensionUpdate,
} from './extensionsModel'
import { SettingsSectionTitle } from './SettingsAtoms'

// Settings → Extensions: the two groups of extensions a person installed.
// "Needs review" first — the decision they owe is the first thing on the page —
// then "Installed", the trusted ones with their one switch. The rows and the
// details are in ExtensionRow; what talks to main is in useThirdPartyExtensions.

type TrustPresentation = { tone: Tone; label: string }

// The trust state in words, for the Plugins door's installed inventory.
export const TRUST_PRESENTATION: Record<ModuleTrustStatus, TrustPresentation> = {
  trusted: { tone: 'good', label: 'Trusted' },
  // 'signed' is informational (valid signature, awaiting approval) — a neutral
  // status, not the accent (which is reserved for primary/selected chrome).
  signed: { tone: 'neutral', label: 'Signed' },
  unsigned: { tone: 'warn', label: 'Unsigned' },
  invalid: { tone: 'error', label: 'Invalid signature' },
}

// Requested-access chips, in the full consent wording: the disclosure a trust
// prompt for a marketplace or GitHub install reads out. Disclosure only — the
// text is what the module says it does, never what the app prevents. The broad
// scopes and unrecognized ones wear the warn tone, and their wording says the
// same thing, so the flag is never colour alone.
export function PermissionChips({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return <span className="text-meta text-[color:var(--text-subtle)]">No special access.</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => {
        const flagged = isBroadCapabilityPermission(permission) || !isKnownCapabilityPermission(permission)
        return (
          <Badge
            key={permission}
            tone={flagged ? 'warn' : 'neutral'}
            ariaLabel={`${describeCapabilityPermission(permission)} (${permission})`}
          >
            {describeCapabilityPermission(permission)}
          </Badge>
        )
      })}
    </div>
  )
}

/** What a row can ask of the page. */
export type ExtensionActions = {
  pendingId: string | null
  onReview: (module: ThirdPartyModuleView) => void
  onSetEnabled: (moduleId: string, enabled: boolean) => void
  onRevokeTrust: (module: ThirdPartyModuleView) => void
  onUninstall: ((module: ThirdPartyModuleView) => void) | null
  onReveal: ((module: ThirdPartyModuleView) => void) | null
  onUpdate: (module: ThirdPartyModuleView, update: ExtensionUpdate) => void
  onCopyId: (module: ThirdPartyModuleView) => void
}

function signatureFact(module: ThirdPartyModuleView): string {
  if (module.trust === 'invalid') return 'Invalid'
  if (!isSigned(module)) return 'Unsigned'
  const signer = publisherName(module.manifest)
  if (signer) return `Signed by ${signer}`
  return module.fingerprint ? `Signed, key ${module.fingerprint.slice(0, 12)}` : 'Signed'
}

function trustFact(module: ThirdPartyModuleView): string {
  if (module.trust !== 'trusted') return 'Not yet'
  return module.trustedVia === 'publisher' ? 'By its publisher’s key' : 'By you'
}

export function ExtensionListRow({
  module,
  overrides,
  updateStates,
  actions,
  detailsOpen,
  onDetailsOpenChange,
}: {
  module: ThirdPartyModuleView
  overrides: ModuleEnablementOverrides
  updateStates: MarketplaceUpdateStatesResult | null
  actions: ExtensionActions
  detailsOpen: boolean
  onDetailsOpenChange: (open: boolean) => void
}): JSX.Element {
  const id = module.manifest.id
  const name = module.manifest.displayName
  const trusted = module.trust === 'trusted'
  const invalid = module.trust === 'invalid'
  const enabled = resolveModuleEnabled(overrides, module)
  const pending = actions.pendingId === id
  const rendererLoadState = getThirdPartyRendererLoadState(id)
  const contributionError = getModuleContributionError(id)
  const problem = moduleProblem(module, rendererLoadState, contributionError)
  const state = runState(module, enabled, rendererLoadState, contributionError)
  const update = marketplaceUpdateFor(module, updateStates)
  const registry = getRendererHost()
  const doorIcon = trusted ? moduleDoorIcon(id, registry) : null
  const { care, standard } = accessItems(module.manifest.permissions)

  const updateButton = update ? (
    <OutlineButton size="xs" disabled={pending} onClick={() => actions.onUpdate(module, update)}>
      Update to v{update.latestVersion}
    </OutlineButton>
  ) : null

  const trailing = invalid ? (
    <CannotTrustTrailing />
  ) : !trusted ? (
    <ReviewTrailing name={name} onReview={() => actions.onReview(module)} />
  ) : (
    <InstalledTrailing
      name={name}
      state={state}
      enabled={enabled}
      pending={pending}
      onToggle={(next) => actions.onSetEnabled(id, next)}
    />
  )

  const menuItems: OverflowMenuItem[] = [
    { id: 'details', label: 'Details', onSelect: () => onDetailsOpenChange(true) },
    ...(trusted
      ? [
          {
            id: 'toggle',
            label: enabled ? 'Turn off' : 'Turn on',
            disabled: pending,
            onSelect: () => actions.onSetEnabled(id, !enabled),
          },
        ]
      : invalid
        ? []
        : [{ id: 'review', label: 'Review and trust', onSelect: () => actions.onReview(module) }]),
    ...(update
      ? [
          {
            id: 'update',
            label: `Update to v${update.latestVersion}`,
            disabled: pending,
            onSelect: () => actions.onUpdate(module, update),
          },
        ]
      : []),
    ...(actions.onReveal ? [{ id: 'files', label: 'Show files', onSelect: () => actions.onReveal?.(module) }] : []),
    { id: 'copy', label: 'Copy id', onSelect: () => actions.onCopyId(module) },
    ...((trusted && module.trustedVia !== 'publisher') || actions.onUninstall
      ? [{ kind: 'separator' as const, id: 'sep' }]
      : []),
    ...(trusted && module.trustedVia !== 'publisher'
      ? [{ id: 'revoke', label: 'Revoke trust', disabled: pending, onSelect: () => actions.onRevokeTrust(module) }]
      : []),
    ...(actions.onUninstall
      ? [
          {
            id: 'uninstall',
            label: 'Uninstall',
            destructive: true,
            disabled: pending,
            onSelect: () => actions.onUninstall?.(module),
          },
        ]
      : []),
  ]

  // The row says a problem only where there is something to read: a failure,
  // a host this module was not built for, a signature that does not match.
  // Update rides the notice when the registry has a newer version — the one
  // case where the way out is on the row.
  const notice = problem ? { text: problemText(problem), ...(updateButton ? { action: updateButton } : {}) } : null

  const source = sourceLabel(module)
  const facts = [
    ...(source
      ? [
          {
            term: 'Source',
            description:
              module.origin?.kind === 'github' ? (
                <>
                  {source} · <span className="font-mono text-micro">{module.origin.repo}</span>
                </>
              ) : (
                source
              ),
          },
        ]
      : []),
    { term: 'Signature', description: signatureFact(module) },
    { term: 'Trusted', description: trustFact(module) },
  ]

  return (
    <ExtensionRow
      module={module}
      doorIcon={doorIcon}
      meta={moduleMeta(module)}
      care={care}
      trailing={trailing}
      menuItems={menuItems}
      notice={notice}
      dimmed={trusted && !enabled}
      detailsOpen={detailsOpen}
      onDetailsOpenChange={onDetailsOpenChange}
      renderDetails={({ titleId }) => (
        <ExtensionDetails
          module={module}
          titleId={titleId}
          icon={<ExtensionMark module={module} doorIcon={doorIcon} size={40} />}
          status={
            trusted ? (
              <ExtensionStateLabel state={state} />
            ) : (
              <span className="whitespace-nowrap text-meta text-[color:var(--tone-warn)]">Not trusted</span>
            )
          }
          adds={
            trusted
              ? deriveContributions(id, registry, {
                  rendererLoaded: rendererLoadState?.status === 'loaded',
                  mcpTools: module.launch.mainLoaded ? module.mcpTools : undefined,
                })
              : null
          }
          care={care}
          standard={standard}
          facts={facts}
          actions={
            <>
              {trusted && module.trustedVia !== 'publisher' ? (
                <GhostButton size="xs" disabled={pending} onClick={() => actions.onRevokeTrust(module)}>
                  Revoke trust
                </GhostButton>
              ) : !trusted && !invalid ? (
                <OutlineButton size="xs" onClick={() => actions.onReview(module)}>
                  Review and trust
                </OutlineButton>
              ) : null}
              <span className="flex-1" />
              {updateButton}
              {actions.onReveal ? (
                <GhostButton size="xs" onClick={() => actions.onReveal?.(module)}>
                  Show files
                </GhostButton>
              ) : null}
              {actions.onUninstall ? (
                <GhostButton size="xs" tone="danger" disabled={pending} onClick={() => actions.onUninstall?.(module)}>
                  Uninstall
                </GhostButton>
              ) : null}
            </>
          }
        />
      )}
    />
  )
}

/** One group of rows under its heading; nothing at all when the group is empty. */
export function ExtensionGroup({
  title,
  count,
  children,
  id,
}: {
  title: string
  count: number
  children: React.ReactNode
  id: string
}): JSX.Element {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <SettingsSectionTitle id={id} count={count}>
        {title}
      </SettingsSectionTitle>
      {children}
    </section>
  )
}

export function ExtensionRows({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <SettingCard as="ul" ariaLabel={label}>
      {children}
    </SettingCard>
  )
}

export function NoExtensionsInstalled(): JSX.Element {
  return (
    <SettingCard>
      <EmptyState density="list" title="No extensions installed" />
    </SettingCard>
  )
}

export function RejectedFolders({
  rejected,
}: {
  rejected: ReadonlyArray<{ path: string; issues: ModuleManifestIssue[] }>
}): JSX.Element | null {
  if (rejected.length === 0) return null
  return (
    <InlineNotice tone="warn">
      {rejected.length === 1
        ? 'A module folder couldn’t be loaded: '
        : `${rejected.length} module folders couldn’t be loaded: `}
      {rejected.map((entry) => entry.issues[0]?.message ?? entry.path).join('; ')}
    </InlineNotice>
  )
}
