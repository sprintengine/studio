import { useCallback, useEffect, useId, useState } from 'react'

import type {
  ModuleEnablementOverrides,
  ModuleManifestIssue,
  ModuleTrustStatus,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
  ThirdPartyRendererEntryView,
} from '../../../../shared/modules/manifest'
import {
  describeCapabilityPermission,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
} from '../../../../shared/modules/permissions'
import { getThirdPartyRendererLoadState, type ThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import { getRendererHost, onThirdPartyRendererModulesLoaded, refreshThirdPartyRendererModules } from '../../modules'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import type { Tone } from '../ui/tokens'
import {
  type ActionResult,
  ActionResultMessage,
  Badge,
  EmptyState,
  IconButton,
  InlineNotice,
  OutlineButton,
  Spinner,
  StatusDot,
  Switch,
  Tooltip,
} from '../ui'
import { FolderPlusIcon } from '../AppIcons'
import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'
import { SettingCard, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Modules: the third-party (installed-from-disk) module group. It
// installs, validates, trust-classifies modules, and reports startup readiness;
// trusting one persists to the trust store.

type TrustPresentation = { tone: Tone; label: string }

export const TRUST_PRESENTATION: Record<ModuleTrustStatus, TrustPresentation> = {
  trusted: { tone: 'good', label: 'Trusted' },
  // 'signed' is informational (valid signature, awaiting approval) — a neutral
  // status, not the accent (which is reserved for primary/selected chrome).
  signed: { tone: 'neutral', label: 'Signed' },
  unsigned: { tone: 'warn', label: 'Unsigned' },
  invalid: { tone: 'error', label: 'Invalid signature' },
}

// Launch readiness is the *consequence* axis (what happens at startup), distinct
// from the trust StatusDot. It is plain text, never a second status dot/badge,
// and never implies sandboxed or permission-brokered execution — trusted code
// runs in-process. Main-process module code only loads at app launch, so a
// newly trusted/enabled module's copy says "on the next app launch". The real
// startup error string (from the main launch snapshot) is surfaced verbatim.
// `enabled` is the live renderer enablement intent (appSettings.modules override
// else manifest default) — the single source of truth the row's enable control
// also writes to — so the copy never disagrees with the toggle next to it.
export function describeModuleLaunch(
  launch: ThirdPartyModuleLaunchView,
  enabled: boolean,
): {
  label: string
  detail: string
} {
  switch (launch.status) {
    case 'trusted_executable':
      return {
        label: 'Main entry ready',
        detail: enabled ? 'Loads on the next app launch.' : 'Disabled — enable it to load on the next app launch.',
      }
    case 'trusted_manifest_only':
      return { label: 'Manifest only', detail: 'Contributes metadata; it has no code to run.' }
    case 'blocked_unsigned':
      return { label: 'Blocked until trusted', detail: 'Unsigned — won’t load until you trust it.' }
    case 'blocked_signed':
      return { label: 'Awaiting trust', detail: 'Signed — won’t load until you trust it.' }
    case 'blocked_invalid':
      return {
        label: 'Blocked: invalid signature',
        detail: 'Can’t be trusted or loaded until it is reinstalled with a valid signature.',
      }
    case 'launch_error':
      return { label: 'Launch error', detail: launch.message ?? 'Failed to load at the last app launch.' }
  }
}

// The renderer-entry consequence line, shown only for trusted modules that
// declare one (status is earned: undeclared entries render nothing, and
// trust-blocked modules already carry one "blocked until trusted" line — a
// second would double the same signal). Two sources, clearly split: the main
// process reports whether the bundle is servable; the renderer loader reports
// what happened when this session evaluated it. A trusted-after-boot module
// has no load state yet, which honestly reads as next-launch.
export function describeRendererEntry(
  view: ThirdPartyRendererEntryView | undefined,
  loadState: ThirdPartyRendererLoadState | undefined,
  trust: ModuleTrustStatus,
): { label: string; detail: string } | null {
  if (trust !== 'trusted' || !view || view.availability === 'none' || view.availability === 'blocked') {
    return null
  }
  if (view.availability === 'error') {
    return {
      label: 'Renderer entry error',
      detail: view.message ?? 'entry.renderer bundle could not be served.',
    }
  }
  if (!loadState) {
    return { label: 'Renderer entry ready', detail: 'Loads on the next app launch.' }
  }
  if (loadState.status === 'error') {
    return { label: 'Renderer entry failed', detail: loadState.message }
  }
  return {
    label: 'Renderer entry loaded',
    detail: 'Contributions follow the enable toggle without a reload.',
  }
}

// The live enablement intent for one module: an explicit appSettings.modules
// override wins, otherwise the manifest default. Mirrors the main launch view's
// `enablementOverrides[id] ?? manifest.defaultEnabled` so the renderer toggle and
// the startup gate read the same value. A pure read — it never rewrites the map,
// so resolving one module cannot disturb another module's override.
export function resolveModuleEnabled(overrides: ModuleEnablementOverrides, module: ThirdPartyModuleView): boolean {
  return overrides[module.manifest.id] ?? module.manifest.defaultEnabled
}

// `MESSAGE_CLASS` was this file's copy of the left tone-bar; the
// install result is a kit notice when it failed and plain copy when it did not.
type Message = ActionResult | null

// Requested-access chips. Disclosure only: the chip text is what the module
// says it does (describeCapabilityPermission keeps every string free of
// enforcement language). The broad scope (ipc:invoke) and unrecognized scopes
// warn-tint the chip; the wording itself carries the same signal
// ("(broad scope)" / "Unrecognized capability"), so the flag is never
// color-only.
export function PermissionChips({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return <span className="text-meta text-[color:var(--text-subtle)]">No special access.</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => {
        const flagged = isBroadCapabilityPermission(permission) || !isKnownCapabilityPermission(permission)
        return (
          // The raw permission id rides the accessible name; the visible word
          // is the description. A broad or unknown permission is a degraded
          // grant, so it wears the warn tone rather than warn ink alone.
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

// One installed module: trust on the StatusDot, launch readiness as plain
// consequence text (one line per entry kind, each naming its half — "Main
// entry …" / "Renderer entry …" — so the two execution surfaces and their
// different toggle semantics stay distinguishable), the trust toggle (or a
// static "cannot be trusted" note for invalid signatures), an enable toggle
// once the module is trusted and has code to run, and the requested access.
// Presentational so row status and copy can be rendered and asserted in
// isolation; the renderer-side load state is injectable for the same reason.
export function ThirdPartyModuleRow({
  module,
  pending,
  enabled,
  rendererLoadState = getThirdPartyRendererLoadState(module.manifest.id),
  onTrustChange,
  onEnabledChange,
  onUninstall,
}: {
  module: ThirdPartyModuleView
  pending: boolean
  enabled: boolean
  rendererLoadState?: ThirdPartyRendererLoadState
  onTrustChange: (trusted: boolean) => void
  onEnabledChange: (enabled: boolean) => void
  // G3: the other end of a marketplace install. Absent on a build whose preload
  // predates the uninstall channel, and the row simply carries no control —
  // never a button that reports an error when pressed.
  onUninstall?: () => void
}) {
  const trust = TRUST_PRESENTATION[module.trust]
  const rendererEntry = describeRendererEntry(module.launch.rendererEntry, rendererLoadState, module.trust)
  // A trusted renderer-entry module without a main entry would otherwise read
  // "Manifest only — no code to run", which is false; the renderer line is the
  // whole story for that shape.
  const launch =
    module.launch.status === 'trusted_manifest_only' && rendererEntry
      ? null
      : describeModuleLaunch(module.launch, enabled)
  const isInvalid = module.trust === 'invalid'
  // The enable control is only meaningful once a module is trusted and actually
  // has code to run; without it the row would dead-end on a disabled trusted
  // module. Renderer-entry contributions gate by the same toggle, live.
  const hasRendererEntry = Boolean(module.launch.rendererEntry && module.launch.rendererEntry.availability !== 'none')
  const canEnable = module.trust === 'trusted' && (module.launch.hasMainEntry || hasRendererEntry)
  const enableLabel = module.launch.hasMainEntry
    ? hasRendererEntry
      ? 'Enable this module'
      : 'Load on the next app launch'
    : 'Enable contributions'
  const enableLabelId = useId()
  return (
    // A row inside the modules card: the card owns the hairline, so the row
    // pads its sides too — the card is full-bleed. Same 16/12px inset as every
    // other list-card row, so this card lines up with the bundled ones above.
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-title font-semibold text-[color:var(--text-strong)]">
              {module.manifest.displayName}
            </span>
            <span className="inline-flex items-center gap-1.5 text-body text-[color:var(--text-muted)]">
              {/* Decorative: the adjacent text already names the trust state, so
                  labelling the dot would double-announce it to screen readers. */}
              <StatusDot tone={trust.tone} />
              {trust.label}
            </span>
          </div>
          {module.manifest.summary ? (
            <div className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">{module.manifest.summary}</div>
          ) : null}
        </div>
        {isInvalid ? (
          <span className="shrink-0 text-meta text-[color:var(--tone-error)]">Cannot be trusted</span>
        ) : (
          <Switch
            checked={module.trust === 'trusted'}
            disabled={pending}
            ariaLabel={`Trust ${module.manifest.displayName}`}
            onChange={onTrustChange}
          />
        )}
      </div>
      {launch ? (
        <div className="text-body leading-5 text-[color:var(--text-muted)]">
          <span className="text-[color:var(--text-default)]">{launch.label}</span>
          {` — ${launch.detail}`}
        </div>
      ) : null}
      {rendererEntry ? (
        <div className="text-body leading-5 text-[color:var(--text-muted)]">
          <span className="text-[color:var(--text-default)]">{rendererEntry.label}</span>
          {` — ${rendererEntry.detail}`}
        </div>
      ) : null}
      {canEnable ? (
        <div className="flex items-center justify-between gap-3">
          <span id={enableLabelId} className="text-body leading-5 text-[color:var(--text-muted)]">
            {enableLabel}
          </span>
          <Switch checked={enabled} ariaLabelledBy={enableLabelId} onChange={onEnabledChange} />
        </div>
      ) : null}
      <PermissionChips permissions={module.manifest.permissions ?? []} />
      {onUninstall ? (
        <div className="flex justify-end">
          {/* Removing a module is a destructive, rarely-wanted action beside two
              switches that are neither, so it is a quiet outline button at the
              end of the row rather than a third control competing with them.
              The confirm dialog is where the consequence is stated. */}
          <OutlineButton
            size="sm"
            disabled={pending}
            onClick={onUninstall}
            aria-label={`Uninstall ${module.manifest.displayName}`}
          >
            Uninstall
          </OutlineButton>
        </div>
      ) : null}
    </div>
  )
}

export function ThirdPartyModuleList({
  overrides,
  onSetEnabled,
}: {
  overrides: ModuleEnablementOverrides
  onSetEnabled: (moduleId: string, enabled: boolean) => void
}) {
  const [modules, setModules] = useState<ThirdPartyModuleView[]>([])
  const [rejected, setRejected] = useState<Array<{ path: string; issues: ModuleManifestIssue[] }>>([])
  const [installing, setInstalling] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [message, setMessage] = useState<Message>(null)

  const load = useCallback(async () => {
    if (typeof window.api.listThirdPartyModules !== 'function') return
    try {
      const result = await window.api.listThirdPartyModules()
      setModules(result.modules)
      setRejected(result.rejected)
    } catch {
      // Best-effort: a discovery failure leaves the list empty.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(
    () =>
      onThirdPartyRendererModulesLoaded(() => {
        void load()
      }),
    [load],
  )

  const installFromFolder = useCallback(async () => {
    setInstalling(true)
    setMessage(null)
    try {
      const result = await addThirdPartyModuleFromFolder(window.api)
      if (result.status === 'failed') {
        setMessage({ tone: 'error', text: result.message })
      } else if (result.status === 'installed') {
        setMessage({
          tone: result.trust === 'invalid' ? 'error' : 'info',
          text: result.id
            ? `Installed "${result.id}". Review its access and trust it when you're ready.`
            : 'Installed the module. Review its access and trust it when you’re ready.',
        })
        await load()
      }
    } finally {
      setInstalling(false)
    }
  }, [load])

  const { confirm: confirmDialog } = useConfirmDialog()

  // G3. The uninstall the marketplace install never had a way back from: the
  // lifecycle removes the module folder, the CLI plugins and skill copies the
  // same bundle installed, its MCP servers out of the synced configs, and the
  // trust grant — then drops the receipt. The id passed is the MODULE's, which
  // the lifecycle resolves to the receipt that owns it (a bundle's id and its
  // module's id need not match).
  const uninstall = useCallback(
    async (module: ThirdPartyModuleView) => {
      if (typeof window.api.uninstallMarketplacePlugin !== 'function') return
      const name = module.manifest.displayName
      const confirmed = await confirmDialog({
        title: `Uninstall ${name}?`,
        // Says what leaves and what stays. Project data a module wrote is its
        // own and is never touched by an uninstall, and saying so is the
        // difference between a reversible action and one nobody dares press.
        body: `Its files are removed from this machine, along with anything else its plugin installed. Work it saved inside your projects stays on disk. Loaded module code is only unloaded when the app restarts.`,
        confirmLabel: 'Uninstall',
        tone: 'danger',
      })
      if (!confirmed) return
      setPendingId(module.manifest.id)
      try {
        const result = await window.api.uninstallMarketplacePlugin({ pluginId: module.manifest.id })
        setMessage(
          result.ok
            ? { tone: 'info', text: `Uninstalled "${name}". Restart SprintEngine Studio to finish removing it.` }
            : { tone: 'error', text: result.message ?? 'Could not uninstall this module.' },
        )
        await load()
      } catch (error) {
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Uninstall failed.' })
      } finally {
        setPendingId(null)
      }
    },
    [confirmDialog, load],
  )

  const setTrust = useCallback(
    async (id: string, trusted: boolean) => {
      if (typeof window.api.setThirdPartyModuleTrust !== 'function') return
      // Revoking trust unloads the module's workspace types on next launch —
      // warn with the workspaces that would lose their surface (nothing on
      // disk is touched; re-trusting brings them back).
      if (!trusted) {
        const state = useWorkspaceStore.getState()
        const kernel = getRendererHost()
        const affected = state.workspaces.filter((workspace) => kernel.getWorkspaceTypeModule(workspace.mode) === id)
        if (affected.length > 0) {
          const confirmed = await confirmDialog({
            title: 'Stop trusting this module?',
            body: `These workspaces use it and will show “module not installed” until you trust it again (their files stay on disk): ${affected
              .map((workspace) => workspace.name)
              .join(', ')}.`,
            confirmLabel: 'Stop trusting',
            tone: 'danger',
          })
          if (!confirmed) return
        }
      }
      setPendingId(id)
      try {
        const result = await window.api.setThirdPartyModuleTrust(id, trusted)
        if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'Could not update trust.' })
        if (result.ok && trusted) await refreshThirdPartyRendererModules()
        await load()
      } finally {
        setPendingId(null)
      }
    },
    [confirmDialog, load],
  )

  // A build whose preload predates the uninstall channel offers no control at
  // all, rather than one that fails when pressed.
  const canUninstall = typeof window.api.uninstallMarketplacePlugin === 'function'

  return (
    // No top rule: the modules card below draws its own edge, and a section
    // border right above it was two rules saying one boundary.
    <div className="flex flex-col gap-3 pt-2">
      <SettingsSectionTitle
        count={modules.length || undefined}
        action={
          <Tooltip content={installing ? 'Installing a module from a folder' : 'Install a module from a folder'}>
            <IconButton
              aria-label={installing ? 'Installing a module from a folder' : 'Install a module from a folder'}
              onClick={() => void installFromFolder()}
              disabled={installing}
            >
              {installing ? <Spinner className="icon-sm" /> : <FolderPlusIcon className="icon-sm" />}
            </IconButton>
          </Tooltip>
        }
      >
        Third-party modules
      </SettingsSectionTitle>

      <ActionResultMessage message={message} />

      {modules.length === 0 ? (
        <EmptyState density="list" title="No third-party modules installed." />
      ) : (
        <SettingCard>
          {modules.map((module) => (
            <ThirdPartyModuleRow
              key={module.manifest.id}
              module={module}
              pending={pendingId === module.manifest.id}
              enabled={resolveModuleEnabled(overrides, module)}
              onTrustChange={(next) => void setTrust(module.manifest.id, next)}
              onEnabledChange={(next) => onSetEnabled(module.manifest.id, next)}
              {...(canUninstall ? { onUninstall: () => void uninstall(module) } : {})}
            />
          ))}
        </SettingCard>
      )}

      {rejected.length > 0 ? (
        <InlineNotice tone="warn">
          {rejected.length} module folder{rejected.length === 1 ? '' : 's'} could not be loaded:{' '}
          {rejected.map((entry) => entry.issues[0]?.message ?? entry.path).join('; ')}
        </InlineNotice>
      ) : null}
    </div>
  )
}
