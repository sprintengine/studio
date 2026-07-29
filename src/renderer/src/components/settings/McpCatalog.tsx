// MCP catalog info panel + brand icon — pure presentation shared by the
// Connectors surface (browse rows, detail aside, installed rows). Takes data via
// props and emits intents (`onToggle`, `onClose`) that the host surface
// translates into IPC calls. The old aspect-square tile grid lived here too; the
// Connectors ConnectorRow replaced it.

import React, { useEffect, useState } from 'react'
import type { BuiltinSkill } from '../../../../shared/electron-api'
import type { McpCatalogServer, McpServerConfig } from '../../types/workspace'
import { FOCUS_RING_CLASS, GhostButton, PrimaryButton, TruncatedText } from '../ui'
import { mcpMonogram } from './mcpMonogram'

export function mcpServerFromCatalog(server: McpCatalogServer): McpServerConfig {
  return {
    id: server.id,
    name: server.name,
    category: server.category,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    env: server.env,
    envVarNames: server.envVarNames ?? [],
    headers: server.headers,
    enabled: true,
    required: false,
    clients: server.defaultClients?.length ? server.defaultClients : server.clients,
    scope: server.recommendedScope ?? 'workspace',
    source: 'bundled',
    riskLevel: server.riskLevel,
    auth: server.auth,
    capabilities: server.capabilities,
    sourceUrl: server.sourceUrl,
  }
}

// The first sentence of a skill description — the Provides section shows what a
// skill does at a glance and leaves the full text to the skill's own docs.
function firstSentence(text: string): string {
  const match = text.trim().match(/^[^.!?]*[.!?]/)
  return match ? match[0].trim() : text.trim()
}

function mcpIconSlug(id: string): string | null {
  if (id === 'context7') return null
  if (id === 'openai-docs') return 'openai'
  if (id === 'brave-search') return 'brave'
  return id
}

export function McpBrandIcon({
  slug,
  name,
  icon,
  size = 36,
}: {
  slug: string | null
  name: string
  icon?: string
  size?: number
}) {
  const [failed, setFailed] = useState(false)
  // Per-entry icon (data URI or https URL) wins; else the brand-color Simple
  // Icons glyph (no tint segment — a baked tint is invisible on the opposite
  // theme); else the monogram. All three sit on the same neutral chip so brand
  // colors stay readable on every theme.
  const src = failed ? null : icon || (slug ? `https://cdn.simpleicons.org/${slug}` : null)
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-lg border border-[color:var(--icon-chip-border)] bg-[color:var(--icon-chip-bg)]"
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="pointer-events-none select-none"
        />
      ) : (
        <span
          style={{ fontSize: Math.round(size * 0.42) }}
          className="font-mono font-semibold text-[color:var(--icon-chip-ink)]"
        >
          {mcpMonogram(name)}
        </span>
      )}
    </span>
  )
}

export function McpInfoPanel({
  server,
  installed,
  onToggle,
  onClose,
  onNewChat,
  onUseInAutomation,
}: {
  server: McpCatalogServer
  installed: boolean
  onToggle: () => void
  onClose: () => void
  // Connector actions, present only for a launchable connector (catalog entry
  // with a skill) on the Connectors surface. Omitted on the Settings MCPs tab, so
  // that surface's Add/Remove primary is unchanged.
  onNewChat?: () => void
  onUseInAutomation?: () => void
}) {
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

  // The driving skill's real name + description for the Provides section,
  // resolved from the same bundled-skill inventory the launch path installs
  // from. Best-effort: until (or unless) it resolves, the skill id stands in.
  const [drivingSkill, setDrivingSkill] = useState<BuiltinSkill | null>(null)
  useEffect(() => {
    setDrivingSkill(null)
    if (!server.skill || typeof window.api.builtinSkillsList !== 'function') return undefined
    let cancelled = false
    window.api
      .builtinSkillsList()
      .then((skills) => {
        if (!cancelled) setDrivingSkill(skills.find((skill) => skill.id === server.skill) ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [server.skill])

  const hasAuth = Boolean(server.auth && server.auth.trim().toLowerCase() !== 'none')

  return (
    <aside
      aria-label={`${server.name} details`}
      className="sticky top-2 w-72 shrink-0 self-start rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={32} />
          <div className="min-w-0">
            <TruncatedText
              as="h5"
              text={server.name}
              className="text-[14px] font-semibold leading-5 text-[color:var(--text-strong)]"
            />
            {server.category ? (
              <TruncatedText
                as="div"
                text={server.category}
                className="mt-0.5 text-[11px] text-[color:var(--text-subtle)]"
              />
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="interactive grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          <svg viewBox="0 0 12 12" className="icon-xs" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {server.description ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">About</div>
          <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">{server.description}</p>
        </div>
      ) : null}
      <div className="mt-3">
        <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Provides</div>
        <ul className="mt-1 space-y-1.5 text-[12px] text-[color:var(--text-muted)]">
          <li className="flex items-center gap-1.5">
            <span>MCP server</span>
            <span className="rounded-full bg-[color:var(--bg-active)] px-1.5 py-0.5 text-[10px] leading-3 text-[color:var(--text-subtle)]">
              {server.transport}
            </span>
          </li>
          {server.skill ? (
            <li>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[color:var(--text-default)]">
                  {drivingSkill?.name ?? server.skill}
                </span>
                <span className="rounded-full bg-[color:var(--bg-active)] px-1.5 py-0.5 text-[10px] leading-3 text-[color:var(--text-subtle)]">
                  Skill
                </span>
              </div>
              {drivingSkill?.description ? (
                <div className="mt-0.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
                  {firstSentence(drivingSkill.description)}
                </div>
              ) : null}
            </li>
          ) : null}
        </ul>
      </div>
      {server.capabilities?.length ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Capabilities</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-[color:var(--text-muted)]">
            {server.capabilities.map((capability) => (
              <li key={capability} className="flex gap-1.5">
                <span aria-hidden className="text-[color:var(--text-subtle)]">·</span>
                <span>{capability}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {server.sourceUrl ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Publisher &amp; source</div>
          <a
            href={server.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className={`mt-1 inline-flex text-[12px] font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] ${FOCUS_RING_CLASS}`}
          >
            Source docs
          </a>
        </div>
      ) : null}
      {hasAuth ? (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">Auth</div>
          <div className="mt-1 text-[12px] text-[color:var(--text-subtle)]">
            {server.auth} — authenticates in chat on first use
          </div>
        </div>
      ) : null}
      {server.setupNotes ? (
        <p className="mt-3 border-l-2 border-[color:var(--border-strong)] pl-2 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {server.setupNotes}
        </p>
      ) : null}
      <div className="mt-4 space-y-2">
        {onNewChat ? (
          // A launchable connector leads with New chat (T1 runtime); Add/Remove
          // and Use in automation are the secondary actions.
          <>
            <PrimaryButton onClick={onNewChat} size="md" className="h-9 w-full">
              New chat
            </PrimaryButton>
            {onUseInAutomation ? (
              <GhostButton
                onClick={onUseInAutomation}
                size="md"
                className="h-9 w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Use in automation
              </GhostButton>
            ) : null}
            <GhostButton
              onClick={onToggle}
              size="md"
              className="h-9 w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              {installed ? 'Remove from active' : 'Add to active'}
            </GhostButton>
          </>
        ) : installed ? (
          <GhostButton
            onClick={onToggle}
            size="md"
            className="h-9 w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Remove
          </GhostButton>
        ) : (
          <PrimaryButton onClick={onToggle} size="md" className="h-9 w-full">
            Add to active
          </PrimaryButton>
        )}
      </div>
    </aside>
  )
}

export { mcpIconSlug, mcpMonogram }
