import { useCallback, useEffect, useId, useState } from 'react'

import type {
  ModuleEnablementOverrides,
  ModuleManifestIssue,
  ModuleTrustStatus,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import { describeCapabilityPermission } from '../../../../shared/modules/permissions'
import type { Tone } from '../ui/tokens'
import { GhostButton, StatusDot, Switch } from '../ui'

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
  enabled: boolean
): {
  label: string
  detail: string
} {
  switch (launch.status) {
    case 'trusted_executable':
      return {
        label: 'Main entry ready',
        detail: enabled
          ? 'Loads on the next app launch.'
          : 'Disabled — enable it to load on the next app launch.',
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

// The live enablement intent for one module: an explicit appSettings.modules
// override wins, otherwise the manifest default. Mirrors the main launch view's
// `enablementOverrides[id] ?? manifest.defaultEnabled` so the renderer toggle and
// the startup gate read the same value. A pure read — it never rewrites the map,
// so resolving one module cannot disturb another module's override.
export function resolveModuleEnabled(
  overrides: ModuleEnablementOverrides,
  module: ThirdPartyModuleView
): boolean {
  return overrides[module.manifest.id] ?? module.manifest.defaultEnabled
}

type Message = { tone: 'accent' | 'warn' | 'error'; text: string } | null

const MESSAGE_CLASS: Record<NonNullable<Message>['tone'], string> = {
  accent: 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]',
  warn: 'border-[color:var(--tone-warn)] text-[color:var(--tone-warn)]',
  error: 'border-[color:var(--tone-error)] text-[color:var(--tone-error)]',
}

function PermissionChips({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return <span className="text-[11px] text-[color:var(--text-subtle)]">No special access requested.</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => (
        <span
          key={permission}
          title={permission}
          className="inline-flex items-center rounded-md bg-[color:var(--bg-active)] px-2 py-0.5 text-[11px] text-[color:var(--text-default)]"
        >
          {describeCapabilityPermission(permission)}
        </span>
      ))}
    </div>
  )
}

// One installed module: trust on the StatusDot, launch readiness as plain
// consequence text, the trust toggle (or a static "cannot be trusted" note for
// invalid signatures), an enable toggle once the module is trusted and has a
// main entry, and the requested access. Presentational so row status and copy
// can be rendered and asserted in isolation.
export function ThirdPartyModuleRow({
  module,
  pending,
  enabled,
  onTrustChange,
  onEnabledChange,
}: {
  module: ThirdPartyModuleView
  pending: boolean
  enabled: boolean
  onTrustChange: (trusted: boolean) => void
  onEnabledChange: (enabled: boolean) => void
}) {
  const trust = TRUST_PRESENTATION[module.trust]
  const launch = describeModuleLaunch(module.launch, enabled)
  const isInvalid = module.trust === 'invalid'
  // The enable control is only meaningful once a module is trusted and actually
  // has code to run; without it the row would dead-end on a disabled trusted
  // module (the product follow-up this task fixes).
  const canEnable = module.trust === 'trusted' && module.launch.hasMainEntry
  const enableLabelId = useId()
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[color:var(--text-strong)]">
              {module.manifest.displayName}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
              {/* Decorative: the adjacent text already names the trust state, so
                  labelling the dot would double-announce it to screen readers. */}
              <StatusDot tone={trust.tone} />
              {trust.label}
            </span>
          </div>
          {module.manifest.summary ? (
            <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
              {module.manifest.summary}
            </div>
          ) : null}
        </div>
        {isInvalid ? (
          <span className="shrink-0 text-[11px] text-[color:var(--tone-error)]">Cannot be trusted</span>
        ) : (
          <Switch
            checked={module.trust === 'trusted'}
            disabled={pending}
            ariaLabel={`Trust ${module.manifest.displayName}`}
            onChange={onTrustChange}
          />
        )}
      </div>
      <div className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        <span className="text-[color:var(--text-default)]">{launch.label}</span>
        {` — ${launch.detail}`}
      </div>
      {canEnable ? (
        <div className="flex items-center justify-between gap-3">
          <span id={enableLabelId} className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Load on the next app launch
          </span>
          <Switch checked={enabled} ariaLabelledBy={enableLabelId} onChange={onEnabledChange} />
        </div>
      ) : null}
      <PermissionChips permissions={module.manifest.permissions ?? []} />
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

  const installFromFolder = useCallback(async () => {
    if (typeof window.api.installThirdPartyModuleFolder !== 'function') return
    setInstalling(true)
    setMessage(null)
    try {
      const folder = await window.api.openDir()
      if (!folder) return
      const result = await window.api.installThirdPartyModuleFolder(folder)
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message ?? 'Could not install the module.' })
      } else {
        setMessage({
          tone: result.trust === 'invalid' ? 'error' : 'accent',
          text: `Installed "${result.id}". Review its access and trust it when you're ready.`,
        })
      }
      await load()
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Install failed.' })
    } finally {
      setInstalling(false)
    }
  }, [load])

  const setTrust = useCallback(
    async (id: string, trusted: boolean) => {
      if (typeof window.api.setThirdPartyModuleTrust !== 'function') return
      setPendingId(id)
      try {
        const result = await window.api.setThirdPartyModuleTrust(id, trusted)
        if (!result.ok) setMessage({ tone: 'error', text: result.message ?? 'Could not update trust.' })
        await load()
      } finally {
        setPendingId(null)
      }
    },
    [load]
  )

  return (
    <div className="flex flex-col gap-3 border-t border-[color:var(--border-subtle)] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[color:var(--text-strong)]">Third-party modules</div>
          <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
            Modules you install from disk. Review the access each one requests and trust the ones you
            approve. A trusted module&rsquo;s main code runs in this app and loads at app launch;
            manifest-only modules contribute metadata without running code. Enabling, disabling, or
            untrusting a module takes effect on the next app launch.
          </p>
        </div>
        <GhostButton size="md" onClick={() => void installFromFolder()} disabled={installing} className="h-9">
          {installing ? 'Installing' : 'Install from folder'}
        </GhostButton>
      </div>

      {message ? (
        <div className={`border-l-2 pl-3 text-[12px] leading-5 ${MESSAGE_CLASS[message.tone]}`}>{message.text}</div>
      ) : null}

      {modules.length === 0 ? (
        <div className="border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
          No third-party modules installed. Install a module folder (a manifest.json plus its files) to
          review and trust it.
        </div>
      ) : (
        <div className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
          {modules.map((module) => (
            <ThirdPartyModuleRow
              key={module.manifest.id}
              module={module}
              pending={pendingId === module.manifest.id}
              enabled={resolveModuleEnabled(overrides, module)}
              onTrustChange={(next) => void setTrust(module.manifest.id, next)}
              onEnabledChange={(next) => onSetEnabled(module.manifest.id, next)}
            />
          ))}
        </div>
      )}

      {rejected.length > 0 ? (
        <div className="border-l-2 border-[color:var(--tone-warn)] pl-3 text-[12px] leading-5 text-[color:var(--tone-warn)]">
          {rejected.length} module folder{rejected.length === 1 ? '' : 's'} could not be loaded:{' '}
          {rejected.map((entry) => entry.issues[0]?.message ?? entry.path).join('; ')}
        </div>
      ) : null}
    </div>
  )
}
