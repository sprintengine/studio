import { useCallback, useEffect, useState } from 'react'
import { installAndActivateRendererModules } from '../../modules'

import { isClaudeCodePluginEntry, type MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import type { McpServerConfig, McpSettings } from '../../types/workspace'
import { ExtensionTrustReview } from '../extensions/ExtensionTrustReview'
import {
  Badge,
  FOCUS_RING_CLASS,
  GhostButton,
  InlineNotice,
  PrimaryButton,
  Spinner,
  StatusDot,
  TruncatedText,
} from '../ui'
import { Modal, ModalFooter, ModalHeader } from '../ui/Modal'
import { mcpMonogram } from '../ui/mcpMonogram'
import { iconHasOwnPlate } from '../ui/iconPlate'
import { componentKindLabels, externalSourceHref } from './storefrontView'
import {
  classifyVerification,
  deriveInstallView,
  installNeedsWorkspace,
  summarizeInstallResult,
  type InstallFlowState,
} from './installFlow'

// The registry plugin detail panel + trust-gate install flow, rendered by the
// Connectors surface next to its browse rows. The detail data comes from the
// T2.1 RegistryClient (the registry INDEX only, so it shows real
// components-carried + version). Clicking Install runs the T3.4
// verifyMarketplacePlugin IPC (main resolves the entry by id, downloads and
// ed25519-verifies it, installs nothing), then verified plugins install directly,
// signed community plugins show a trust prompt populated with what verify
// disclosed — permissions, every MCP command line, the pinned commit — and install
// with the one-time token verify issued; unsigned code and invalid bundles
// hard-block with no install affordance. No permission is ever
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
  const [flow, setFlow] = useState<InstallFlowState>({ status: 'idle' })

  // Escape, the scrim and the close button are the dialog's own (Modal); what
  // this keeps is the flow reset: a fresh selection starts a fresh install
  // flow — never inherit another plugin's verify/trust/blocked state.
  useEffect(() => {
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
  // fail downstream. The rule itself lives in `installFlow` so it can be
  // asserted without a renderer.
  const needsWorkspace = installNeedsWorkspace(plugin.provides)
  const workspaceBlocked = needsWorkspace && !workspaceRoot

  const runInstall = useCallback(
    async (trustToken?: string) => {
      setFlow({ status: 'installing' })
      try {
        const result = await installAndActivateRendererModules(() =>
          window.api.installMarketplacePluginFromRegistry({
            id: plugin.id,
            // The approval main issued at verify; it installs exactly what the
            // prompt disclosed, never whatever the source moved to since.
            ...(trustToken ? { trustToken } : {}),
            workspaceRoot: workspaceRoot ?? undefined,
            mcpSettings,
          }),
        )
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
    // Inline-MCP entries verify too: there is no bundle to download, but main
    // still resolves the entry itself, discloses each server exactly as it
    // would be written, and issues the token — they are executable config, so
    // they always route through the explicit trust prompt.
    if (typeof window.api.verifyMarketplacePlugin !== 'function') {
      setFlow({ status: 'error', message: 'Installing extensions needs a newer app build. Update and restart.' })
      return
    }
    setFlow({ status: 'verifying' })
    let verify
    try {
      verify = await window.api.verifyMarketplacePlugin({ id: plugin.id })
    } catch (error) {
      setFlow({ status: 'error', message: error instanceof Error ? error.message : 'Could not verify this extension.' })
      return
    }
    const outcome = classifyVerification(verify, plugin.provides)
    if (outcome.kind === 'blocked') {
      setFlow({
        status: 'blocked',
        classification: outcome.classification,
        message: outcome.message,
        issues: outcome.issues,
      })
      return
    }
    if (outcome.kind === 'needs-trust') {
      setFlow({ status: 'needs-trust', review: outcome.review, trustToken: outcome.trustToken })
      return
    }
    // Verified: install directly, no trust prompt.
    await runInstall(outcome.trustToken)
  }, [plugin, runInstall])

  const installView = deriveInstallView(flow)
  const titleId = 'registry-plugin-detail-title'

  return (
    <Modal open onClose={onClose} labelledBy={titleId} size="wide" layout="panel">
      <ModalHeader
        title={plugin.name}
        subtitle={[trust.label, plugin.publisher.name, `Version ${plugin.latest}`, plugin.category]
          .filter(Boolean)
          .join(' · ')}
        titleId={titleId}
        onClose={onClose}
        leading={<PluginIcon iconUrl={resolveIconUrl(registryUrl, plugin.icon)} name={plugin.name} size={40} />}
      />
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-[color:var(--border-subtle)] px-6 pb-4">
        <p className="mt-4 text-body leading-5 text-[color:var(--text-default)]">{plugin.summary}</p>

        {displayTags.length ? (
          <p className="mt-2 text-meta leading-4 text-[color:var(--text-subtle)]">{displayTags.join(' · ')}</p>
        ) : null}

        <div className="mt-3">
          <div className="text-meta font-semibold text-[color:var(--text-muted)]">Provides</div>
          <ul className="mt-1 space-y-1 text-body text-[color:var(--text-muted)]">
            {/* Inline-MCP entries name the actual servers the trust grant adds;
              bundle entries list their component kinds (their bundled skills,
              when the catalogue enumerated them, get the section below). */}
            {inlineServers.length > 0
              ? inlineServers.map((server) => (
                  <li key={server.id} className="flex min-w-0 items-center gap-1.5">
                    <TruncatedText as="span" text={server.name} className="min-w-0" />
                    {/* Not decorative: the transport is stated once, here. The
                      server's name says what it is, never how it is spoken to. */}
                    <Badge className="shrink-0">{server.transport}</Badge>
                  </li>
                ))
              : components.map((label) => (
                  <li key={label} className="flex gap-1.5">
                    <span aria-hidden className="text-[color:var(--text-subtle)]">
                      ·
                    </span>
                    <span>{label}</span>
                  </li>
                ))}
          </ul>
        </div>

        {plugin.skills?.length ? <PluginSkillsList skills={plugin.skills} /> : null}

        {/* Phase-3 trust-gate install flow. Everything the prompt shows came from
          main's verify (via verifyMarketplacePlugin) and is never fabricated;
          unsigned code and invalid bundles never reach an install affordance;
          no purchase/Buy affordance anywhere (D4). */}
        <div className="mt-4 space-y-2">
          {installView.trustPrompt && installView.review ? (
            <ExtensionTrustReview {...installView.review} publisher={plugin.publisher} />
          ) : null}

          {installView.notice ? (
            installView.notice.tone === 'good' ? (
              // Success has no InlineNotice tone; mirror the Installed tab's
              // StatusDot + text so the state is never colour-only.
              <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]" role="status">
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
            <p className="text-meta leading-4 text-[color:var(--text-subtle)]">
              Open a workspace to install this extension.
            </p>
          ) : null}

          {installView.busy ? (
            <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]" role="status">
              <Spinner size={14} />
              {installView.busyLabel}
            </div>
          ) : null}

          {claudePlugin && installView.action?.kind === 'install' ? (
            <p className="text-meta leading-4 text-[color:var(--text-subtle)]">
              Installing adds this plugin’s skills to this workspace for your installed agent CLIs. Its slash commands
              stay Claude-native.
            </p>
          ) : null}
        </div>
      </div>
      <div className="border-t border-[color:var(--border-subtle)]">
        <ModalFooter>
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noreferrer"
              className={`mr-auto inline-flex text-body font-medium text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] ${FOCUS_RING_CLASS}`}
            >
              View source
            </a>
          ) : null}
          {installView.trustPrompt ? (
            <GhostButton size="md" onClick={() => setFlow({ status: 'idle' })}>
              Cancel
            </GhostButton>
          ) : null}
          {installView.action ? (
            <PrimaryButton
              size="md"
              disabled={workspaceBlocked}
              onClick={() =>
                void (installView.action?.kind === 'trust-install'
                  ? runInstall(installView.trustToken ?? undefined)
                  : startInstall())
              }
            >
              {installView.action.label}
            </PrimaryButton>
          ) : null}
        </ModalFooter>
      </div>
    </Modal>
  )
}

// How many skills the detail panel shows before its "Show N more" toggle —
// the same collapse idiom as the browse sections; some vendor plugins bundle
// dozens (Hugging Face ships 25).
const SKILLS_COLLAPSE_LIMIT = 6

// The bundled skills a plugin carries: names + one-line descriptions
// enumerated from the plugin's source repo when the entry was published
// (display metadata, not install state — installing them is the plugin
// install's job). Rendered only when the entry actually carries skills; a
// plugin with none simply has no section, never a placeholder.
function PluginSkillsList({ skills }: { skills: NonNullable<MarketplacePluginEntry['skills']> }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? skills : skills.slice(0, SKILLS_COLLAPSE_LIMIT)
  const hiddenCount = skills.length - visible.length
  return (
    <div className="mt-3">
      <div className="text-meta font-semibold text-[color:var(--text-muted)]">Skills · {skills.length}</div>
      <ul className="mt-1 space-y-1.5">
        {/* The validator does not guarantee name/path uniqueness, so the index
            rides the key; the list is display-only and never reorders. */}
        {visible.map((skill, index) => (
          <li key={`${skill.path ?? skill.name}-${index}`} className="min-w-0">
            <TruncatedText
              as="div"
              text={skill.name}
              className="text-body font-medium leading-4 text-[color:var(--text-default)]"
            />
            {skill.description ? (
              <TruncatedText
                as="div"
                text={skill.description}
                className="mt-0.5 text-meta leading-4 text-[color:var(--text-subtle)]"
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

type PluginTrustTier = 'verified' | 'community' | 'unsigned' | 'inline'
export type PluginTrust = { tier: PluginTrustTier; tone: 'good' | 'neutral'; label: string }

// The signing/trust tier disclosed on the card and detail header, read straight
// from the registry entry (no download needed). Inline-MCP entries ship raw server
// config; unsigned bundles carry no signature; signed bundles are Verified (matched
// first-party publisher) or Community (everyone else). All three lower tiers are
// untrusted until the user grants trust at install (D3). Verified is the quiet
// default (no dot); the rest surface the neutral dot to earn attention.
export function pluginTrust(plugin: MarketplacePluginEntry): PluginTrust {
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
  // Artwork that brings its own plate — every app icon in the marketplace —
  // wears it bare, filling the slot. It used to sit shrunk inside the light
  // chip, which put a white frame behind every CLI, automation and module in
  // the door, the installed inventory and the automations shelf (owner ruling
  // 2026-09-01). A flat brand mark keeps the chip because it needs the ground;
  // `iconHasOwnPlate` is what tells the two apart. Same rule as `ExtensionIcon`.
  if (iconUrl && !failed && iconHasOwnPlate(iconUrl)) {
    return (
      <img
        src={iconUrl}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="pointer-events-none shrink-0 select-none rounded-lg object-contain"
      />
    )
  }
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
          className="pointer-events-none select-none rounded-xs"
        />
      )}
    </span>
  )
}
