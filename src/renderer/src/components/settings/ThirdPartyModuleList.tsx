import { useCallback, useEffect, useState } from 'react'

import type { ModuleManifestIssue, ModuleTrustStatus, ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { describeCapabilityPermission } from '../../../../shared/modules/permissions'
import type { Tone } from '../ui/tokens'
import { GhostButton, StatusDot, Switch } from '../ui'

// Settings → Modules: the third-party (installed-from-disk) module group. It
// installs, validates, and trust-classifies modules; trusting one persists to
// the trust store. Third-party code is NOT executed yet — the isolated runtime
// (utilityProcess + brokered, permission-enforcing channel) is a later Phase 7
// increment — so this surface is the install + review + trust workflow.

type TrustPresentation = { tone: Tone; label: string }

const TRUST_PRESENTATION: Record<ModuleTrustStatus, TrustPresentation> = {
  trusted: { tone: 'good', label: 'Trusted' },
  // 'signed' is informational (valid signature, awaiting approval) — a neutral
  // status, not the accent (which is reserved for primary/selected chrome).
  signed: { tone: 'neutral', label: 'Signed' },
  unsigned: { tone: 'warn', label: 'Unsigned' },
  invalid: { tone: 'error', label: 'Invalid signature' },
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

export function ThirdPartyModuleList() {
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
            approve. Running third-party module code isn&rsquo;t enabled yet &mdash; trusting one records
            your approval for when it is.
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
          {modules.map((module) => {
            const presentation = TRUST_PRESENTATION[module.trust]
            const isInvalid = module.trust === 'invalid'
            return (
              <div key={module.manifest.id} className="flex flex-col gap-2 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[color:var(--text-strong)]">
                        {module.manifest.displayName}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
                        <StatusDot tone={presentation.tone} label={presentation.label} />
                        {presentation.label}
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
                      disabled={pendingId === module.manifest.id}
                      ariaLabel={`Trust ${module.manifest.displayName}`}
                      onChange={(next) => void setTrust(module.manifest.id, next)}
                    />
                  )}
                </div>
                <PermissionChips permissions={module.manifest.permissions ?? []} />
              </div>
            )
          })}
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
