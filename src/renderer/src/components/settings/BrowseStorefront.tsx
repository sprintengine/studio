import { useCallback, useEffect, useRef, useState } from 'react'

import { isClaudeCodePluginEntry, type MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import type { CapabilityPermission } from '../../../../shared/modules/permissions'
import type { McpServerConfig, McpSettings } from '../../types/workspace'
import { CloseIconButton, FOCUS_RING_CLASS, GhostButton, InlineNotice, PrimaryButton, Spinner, StatusDot, TruncatedText } from '../ui'
import { mcpMonogram } from './McpCatalog'
import { PermissionChips } from './ThirdPartyModuleList'
import { componentKindLabels, externalSourceHref } from './storefrontView'
import {
  classifyVerification,
  deriveInstallView,
  summarizeInstallResult,
  type InstallFlowState,
} from './installFlow'

// The registry plugin detail panel + trust-gate install flow, rendered by the
// Connectors surface next to its browse rows. The detail data comes from the
// T2.1 RegistryClient (the registry INDEX only, so it shows real
// components-carried + version). Clicking Install runs the T3.4
// verifyMarketplacePlugin IPC (real download + ed25519-verify, no install), then
// verified plugins install directly, signed community plugins show a trust prompt
// populated with the REAL verified permissions before install, and unsigned/
// invalid bundles hard-block with no install affordance. No permission is ever
// fabricated (the index omits them; they come only from the verified signed
// manifest), and there are no purchase/Buy affordances (D4). The install state
// machine lives in the DOM-free `installFlow` view-model. The old aspect-square
// browse grid lived here too; the Connectors ConnectorRow replaced it.

export function PluginDetailPanel({
  plugin,
  registryUrl,
  workspaceRoot,
  mcpSettings,
  onInstalled,
  onUpsertMcpServer,
  onClose,
}: {
  plugin: MarketplacePluginEntry
  registryUrl: string | null
  workspaceRoot: string | null
  mcpSettings: McpSettings
  onInstalled: () => void
  onUpsertMcpServer: (server: McpServerConfig) => void
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [flow, setFlow] = useState<InstallFlowState>({ status: 'idle' })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    headingRef.current?.focus()
    // A fresh selection starts a fresh install flow — never inherit another
    // plugin's verify/trust/blocked state.
    setFlow({ status: 'idle' })
  }, [plugin.id])

  const trust = pluginTrust(plugin)
  const components = componentKindLabels(plugin.provides)
  const inlineServers = plugin.mcp?.servers ?? []
  // Claude Code plugins (catalogue-generated, machine-tagged) install through
  // the claude-plugin adapter: their bundled skills copy into the workspace's
  // Claude skill dirs behind the unsigned trust prompt, which discloses the
  // real skill listing. The machine tag stays off the visible tag row.
  const claudePlugin = isClaudeCodePluginEntry(plugin)
  const displayTags = plugin.tags?.filter((tag) => tag !== 'claude-plugin') ?? []
  // Fail closed: only render an external "View source" link for an http(s)
  // source. A non-http(s) value (file://, smb://, protocol-handler URL) would
  // reach shell.openExternal via the window-open handler, so it gets no link.
  const sourceHref = externalSourceHref(plugin.source)
  // MCP servers and skill packs install into the open workspace; modules and
  // CLIs install to the user dirs. Block install with an honest hint when a
  // workspace-scoped component has no workspace, rather than letting the click
  // fail downstream.
  const needsWorkspace = plugin.provides.some((kind) => kind === 'mcp' || kind === 'skills')
  const workspaceBlocked = needsWorkspace && !workspaceRoot

  const runInstall = useCallback(
    async (trustGranted: boolean, claudePluginRef?: string) => {
      setFlow({ status: 'installing' })
      try {
        const result = await window.api.installMarketplacePluginFromRegistry({
          entry: plugin,
          trustGranted,
          workspaceRoot: workspaceRoot ?? undefined,
          mcpSettings,
          // Claude plugins: install exactly the commit the trust prompt
          // disclosed, never whatever the source ref moved to since.
          ...(claudePluginRef ? { claudePluginRef } : {}),
        })
        if (result.ok) {
          // Reflect installed MCP servers in the store so the Installed tab's
          // MCP rows update without a reload; re-list the other primitives.
          if (result.mcpSettings) {
            for (const server of Object.values(result.mcpSettings.servers)) onUpsertMcpServer(server)
          }
          onInstalled()
        }
        setFlow(summarizeInstallResult(result))
      } catch (error) {
        setFlow({
          status: 'error',
          message: error instanceof Error ? error.message : 'The install could not be completed.',
        })
      }
    },
    [plugin, workspaceRoot, mcpSettings, onInstalled, onUpsertMcpServer],
  )

  const startInstall = useCallback(async () => {
    // Inline-MCP entries ship their server config in the registry entry itself —
    // there is no bundle to download or verify. They are executable config, so they
    // always route through the explicit trust prompt — never a silent install — and
    // carry no capability permissions (those live only in signed module bundles).
    if (plugin.mcp) {
      setFlow({ status: 'needs-trust', permissions: [] })
      return
    }
    if (typeof window.api.verifyMarketplacePlugin !== 'function') {
      setFlow({ status: 'error', message: 'Installing extensions needs a newer app build. Update and restart.' })
      return
    }
    setFlow({ status: 'verifying' })
    let verify
    try {
      verify = await window.api.verifyMarketplacePlugin(plugin)
    } catch (error) {
      setFlow({ status: 'error', message: error instanceof Error ? error.message : 'Could not verify this extension.' })
      return
    }
    const outcome = classifyVerification(verify, plugin.provides)
    if (outcome.kind === 'blocked') {
      setFlow({ status: 'blocked', classification: outcome.classification, message: outcome.message, issues: outcome.issues })
      return
    }
    if (outcome.kind === 'needs-trust') {
      setFlow({
        status: 'needs-trust',
        permissions: outcome.permissions,
        ...(outcome.files ? { files: outcome.files } : {}),
        ...(outcome.pinnedRef ? { pinnedRef: outcome.pinnedRef } : {}),
      })
      return
    }
    // Verified: install directly, no trust prompt.
    await runInstall(false)
  }, [plugin, runInstall])

  const installView = deriveInstallView(flow)

  return (
    <aside
      aria-label={`${plugin.name} details`}
      className="sticky top-2 w-72 shrink-0 self-start rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginIcon iconUrl={resolveIconUrl(registryUrl, plugin.icon)} name={plugin.name} size={32} />
          <div className="min-w-0">
            {/* design-system-allow: heading is a programmatic focus target only (tabIndex -1, moved to on selection) — it never receives keyboard focus */}
            <h5 ref={headingRef} tabIndex={-1} className="truncate text-[14px] font-semibold leading-5 text-[color:var(--text-strong)] focus:outline-none">
              {plugin.name}
            </h5>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
              <StatusDot tone={trust.tone} />
              <TruncatedText as="span" text={`${trust.label} · ${plugin.publisher.name}`} />
            </div>
          </div>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close details" />
      </div>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
        <span className="tabular-nums">Version {plugin.latest}</span>
        <span aria-hidden>·</span>
        <TruncatedText as="span" text={plugin.category} />
      </div>

      <p className="mt-3 text-[12px] leading-5 text-[color:var(--text-muted)]">{plugin.summary}</p>

      {displayTags.length ? (
        <p className="mt-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">{displayTags.join(' · ')}</p>
      ) : null}

      <div className="mt-3">
        <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Provides</div>
        <ul className="mt-1 space-y-1 text-[12px] text-[color:var(--text-muted)]">
          {/* Inline-MCP entries name the actual servers the trust grant adds;
              bundle entries list their component kinds (their bundled skills,
              when the catalogue enumerated them, get the section below). */}
          {inlineServers.length > 0
            ? inlineServers.map((server) => (
                <li key={server.id} className="flex min-w-0 items-center gap-1.5">
                  <TruncatedText as="span" text={server.name} className="min-w-0" />
                  <span className="shrink-0 rounded-full bg-[color:var(--bg-active)] px-1.5 py-0.5 text-[10px] leading-3 text-[color:var(--text-subtle)]">
                    {server.transport}
                  </span>
                </li>
              ))
            : components.map((label) => (
                <li key={label} className="flex gap-1.5">
                  <span aria-hidden className="text-[color:var(--text-subtle)]">·</span>
                  <span>{label}</span>
                </li>
              ))}
        </ul>
      </div>

      {plugin.skills?.length ? <PluginSkillsList skills={plugin.skills} /> : null}

      {sourceHref ? (
        <a
          href={sourceHref}
          target="_blank"
          rel="noreferrer"
          className={`mt-3 inline-flex text-[12px] font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] ${FOCUS_RING_CLASS}`}
        >
          View source
        </a>
      ) : null}

      {/* Phase-3 trust-gate install flow. Permissions shown here come only from
          the ed25519-verified signed manifest (via verifyMarketplacePlugin) and
          are never fabricated; unsigned/invalid never reach an install affordance;
          no purchase/Buy affordance anywhere (D4). */}
      <div className="mt-4 space-y-2">
        {installView.trustPrompt ? (
          <TrustPrompt
            tier={trust.tier}
            permissions={installView.permissions ?? []}
            inlineServers={inlineServers}
            files={installView.files}
          />
        ) : null}

        {installView.notice ? (
          installView.notice.tone === 'good' ? (
            // Success has no InlineNotice tone; mirror the Installed tab's
            // StatusDot + text so the state is never colour-only.
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]" role="status">
              <StatusDot tone="good" />
              <span>{installView.notice.message}</span>
            </div>
          ) : (
            <InlineNotice tone={installView.notice.tone}>
              <div>{installView.notice.message}</div>
              {installView.notice.issues?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {installView.notice.issues.slice(0, 4).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </InlineNotice>
          )
        ) : null}

        {workspaceBlocked && !installView.busy ? (
          <p className="text-[11px] leading-4 text-[color:var(--text-subtle)]">
            Open a workspace to install this extension.
          </p>
        ) : null}

        {installView.busy ? (
          <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]" role="status">
            <Spinner size={14} />
            {installView.busyLabel}
          </div>
        ) : null}

        {claudePlugin && installView.action?.kind === 'install' ? (
          <p className="text-[11px] leading-4 text-[color:var(--text-subtle)]">
            Installing adds this plugin’s skills to this workspace for your
            installed agent CLIs. Its slash commands stay Claude-native.
          </p>
        ) : null}

        {installView.action ? (
          <div className={installView.trustPrompt ? 'flex gap-2' : ''}>
            <PrimaryButton
              size="md"
              className="h-9 w-full"
              disabled={workspaceBlocked}
              onClick={() =>
                void (installView.action?.kind === 'trust-install'
                  ? runInstall(true, installView.pinnedRef ?? undefined)
                  : startInstall())
              }
            >
              {installView.action.label}
            </PrimaryButton>
            {installView.trustPrompt ? (
              <GhostButton size="md" className="h-9" onClick={() => setFlow({ status: 'idle' })}>
                Cancel
              </GhostButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  )
}

// How many skills the detail panel shows before its "Show N more" toggle —
// the same collapse idiom as the browse sections; some vendor plugins bundle
// dozens (Hugging Face ships 25).
const SKILLS_COLLAPSE_LIMIT = 6

// The bundled skills a plugin carries: names + one-line descriptions
// enumerated from the plugin's source repo at catalogue-snapshot build time
// (display metadata, not install state — installing them is the plugin
// install's job). Rendered only when the entry actually carries skills; a
// plugin with none simply has no section, never a placeholder.
function PluginSkillsList({ skills }: { skills: NonNullable<MarketplacePluginEntry['skills']> }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? skills : skills.slice(0, SKILLS_COLLAPSE_LIMIT)
  const hiddenCount = skills.length - visible.length
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Skills · {skills.length}</div>
      <ul className="mt-1 space-y-1.5">
        {/* The validator does not guarantee name/path uniqueness, so the index
            rides the key; the list is display-only and never reorders. */}
        {visible.map((skill, index) => (
          <li key={`${skill.path ?? skill.name}-${index}`} className="min-w-0">
            <TruncatedText
              as="div"
              text={skill.name}
              className="text-[12px] font-medium leading-4 text-[color:var(--text-default)]"
            />
            {skill.description ? (
              <TruncatedText
                as="div"
                text={skill.description}
                className="mt-0.5 text-[11px] leading-4 text-[color:var(--text-subtle)]"
              />
            ) : null}
          </li>
        ))}
      </ul>
      {skills.length > SKILLS_COLLAPSE_LIMIT ? (
        <GhostButton size="sm" className="mt-1.5" onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show fewer' : `Show ${hiddenCount} more`}
        </GhostButton>
      ) : null}
    </div>
  )
}

// The pre-trust disclosure shown inside the trust prompt. Community/unsigned
// bundles disclose their real capability permissions (never fabricated); an
// inline-MCP entry has no capability permissions, so it discloses the executable
// server config the trust grant will run instead. Copy avoids any purchase/paywall
// framing (D4) and states plainly that trust is install-time, not a runtime sandbox.
function TrustPrompt({
  tier,
  permissions,
  inlineServers,
  files,
}: {
  tier: PluginTrustTier
  permissions: CapabilityPermission[]
  inlineServers: McpServerConfig[]
  // Real content listing for file-payload entries (Claude Code plugin skills):
  // shown in place of permission chips, never alongside fabricated ones.
  files?: string[] | null
}) {
  const copy =
    tier === 'inline'
      ? {
          heading: 'Inline MCP server — review it before trusting',
          body: 'This entry runs a local command or connects to a remote endpoint as an MCP server. Trusting it adds and starts the server below — review it before you continue.',
        }
      : files?.length
        ? {
            heading: 'Unsigned plugin skills — review before trusting',
            body: 'Skills are instruction files your agents read and follow. This plugin isn’t signed, so its contents can’t be verified — trusting it copies the skills below into this workspace for your installed agent CLIs.',
          }
        : tier === 'unsigned'
          ? {
              heading: 'Unsigned extension — review before trusting',
              body: "This extension isn’t signed, so its publisher and contents can’t be verified. Trusting it installs it with the app’s access — install-time disclosure, not a runtime sandbox.",
            }
          : {
              heading: 'Community extension — review the access it requests',
              body: 'This publisher isn’t verified. Trusting it lets its code run with the app’s access — requested access is install-time disclosure, not a runtime sandbox.',
            }
  return (
    <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3">
      <div className="text-[11px] font-semibold text-[color:var(--text-default)]">{copy.heading}</div>
      <p className="mt-1 text-[11px] leading-4 text-[color:var(--text-subtle)]">{copy.body}</p>
      <div className="mt-2">
        {tier === 'inline' ? (
          <ul className="space-y-1">
            {inlineServers.map((server) => (
              <li key={server.id} className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
                  <span className="font-mono text-[10px] text-[color:var(--text-subtle)]">{server.transport}</span>
                  <TruncatedText as="span" text={server.name} className="font-medium" />
                </div>
                <TruncatedText
                  as="div"
                  text={inlineServerCommand(server)}
                  className="mt-0.5 font-mono text-[10px] leading-4 text-[color:var(--text-subtle)]"
                />
              </li>
            ))}
          </ul>
        ) : files?.length ? (
          <TrustFileListing files={files} />
        ) : (
          <PermissionChips permissions={permissions} />
        )}
      </div>
    </div>
  )
}

// How many trust-prompt file rows show before the remainder collapses into a
// "+N more" line — the disclosure stays real without swallowing the panel.
const TRUST_FILES_LIMIT = 8

// The real file listing a trust grant installs (Claude Code plugin skill
// folders), fetched by the pre-trust verify — the file-payload counterpart of
// the permission chips.
function TrustFileListing({ files }: { files: string[] }) {
  const visible = files.slice(0, TRUST_FILES_LIMIT)
  const hiddenCount = files.length - visible.length
  return (
    <div>
      <div className="text-[10px] font-semibold text-[color:var(--text-subtle)]">
        Adds {files.length} skill{files.length === 1 ? '' : 's'} to the workspace
      </div>
      <ul className="mt-1 space-y-0.5">
        {visible.map((file) => (
          <li key={file} className="min-w-0">
            <TruncatedText as="div" text={file} className="font-mono text-[10px] leading-4 text-[color:var(--text-muted)]" />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <div className="mt-0.5 text-[10px] leading-4 text-[color:var(--text-subtle)]">+{hiddenCount} more</div>
      ) : null}
    </div>
  )
}

// The executable summary of an inline MCP server: the stdio command line, or the
// endpoint URL for http/sse transports. This is what the trust grant will run.
function inlineServerCommand(server: McpServerConfig): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || '(no command)'
  }
  return server.url || '(no endpoint)'
}

type PluginTrustTier = 'verified' | 'community' | 'unsigned' | 'inline'
type PluginTrust = { tier: PluginTrustTier; tone: 'good' | 'neutral'; label: string }

// The signing/trust tier disclosed on the card and detail header, read straight
// from the registry entry (no download needed). Inline-MCP entries ship raw server
// config; unsigned bundles carry no signature; signed bundles are Verified (matched
// first-party publisher) or Community (everyone else). All three lower tiers are
// untrusted until the user grants trust at install (D3). Verified is the quiet
// default (no dot); the rest surface the neutral dot to earn attention.
function pluginTrust(plugin: MarketplacePluginEntry): PluginTrust {
  if (plugin.mcp) return { tier: 'inline', tone: 'neutral', label: 'Inline MCP' }
  if (!plugin.signature) return { tier: 'unsigned', tone: 'neutral', label: 'Unsigned' }
  return plugin.publisher.verified
    ? { tier: 'verified', tone: 'good', label: 'Verified' }
    : { tier: 'community', tone: 'neutral', label: 'Community' }
}

export function resolveIconUrl(registryUrl: string | null, icon: string): string | null {
  if (!icon) return null
  // Absolute icons (https URLs, data: URIs from the generated catalogue) need
  // no registry base and must survive a missing registryUrl; only relative
  // registry paths resolve against the registry URL. Keep the two forks
  // explicit — collapsing them into one new URL(icon, base) call throws for
  // absolute icons whenever the base is missing or invalid.
  if (URL.canParse(icon)) return new URL(icon).toString()
  if (!registryUrl) return null
  try {
    return new URL(icon, registryUrl).toString()
  } catch {
    return null
  }
}

export function PluginIcon({ iconUrl, name, size = 36 }: { iconUrl: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  // Same neutral chip as McpBrandIcon so catalog and registry entries read as
  // one system, and low-contrast brand art stays visible on every theme.
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center overflow-hidden rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)]"
    >
      {!iconUrl || failed ? (
        <span
          style={{ fontSize: Math.round(size * 0.42) }}
          className="font-mono font-semibold text-[color:var(--icon-chip-ink)]"
        >
          {mcpMonogram(name)}
        </span>
      ) : (
        <img
          src={iconUrl}
          alt=""
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="pointer-events-none select-none rounded-[4px]"
        />
      )}
    </span>
  )
}
