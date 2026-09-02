// MCP catalog info panel + brand icon — pure presentation shared by the
// Connectors surface (browse rows, detail aside, installed rows). Takes data via
// props and emits intents (`onToggle`, `onClose`) that the host surface
// translates into IPC calls. The old aspect-square tile grid lived here too; the
// Connectors ConnectorRow replaced it.

import React, { useEffect, useState } from 'react'
import type { BuiltinSkill } from '../../../../shared/electron-api'
import type { McpCatalogServer } from '../../types/workspace'
import { Badge, CloseIconButton, FOCUS_RING_CLASS, GhostButton, PrimaryButton, TruncatedText } from '../ui'
import { ExtensionIcon } from '../ui/ExtensionIcon'
import { mcpMonogram } from '../ui/mcpMonogram'

// Re-exported from `src/shared/connector-launch.ts` (MC-2159): main builds the
// same config when it resolves a connector for a headless launch.
export { mcpServerFromCatalog } from '../../../../shared/connector-launch'

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

// The chip itself now lives in `ui/ExtensionIcon`, so the surfaces that cannot
// import the Settings component graph draw the same mark. This name stays for
// the call sites that have always used it.
export { ExtensionIcon as McpBrandIcon }

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
          <ExtensionIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={32} />
          <div className="min-w-0">
            <TruncatedText
              as="h5"
              text={server.name}
              className="text-body font-semibold leading-5 text-[color:var(--text-strong)]"
            />
            {server.category ? (
              <TruncatedText
                as="div"
                text={server.category}
                className="mt-0.5 text-meta text-[color:var(--text-subtle)]"
              />
            ) : null}
          </div>
        </div>
        <CloseIconButton onClick={onClose} aria-label="Close details" className="shrink-0" />
      </div>
      {server.description ? (
        <div className="mt-3">
          <div className="text-meta font-semibold text-[color:var(--text-muted)]">About</div>
          <p className="mt-1 text-body leading-5 text-[color:var(--text-muted)]">{server.description}</p>
        </div>
      ) : null}
      <div className="mt-3">
        <div className="text-meta font-semibold text-[color:var(--text-muted)]">Provides</div>
        <ul className="mt-1 space-y-1.5 text-body text-[color:var(--text-muted)]">
          <li className="flex items-center gap-1.5">
            <span>MCP server</span>
            {/* Not decorative: "stdio" / "http" appears nowhere else in the
                row, so hiding the chip hides the transport outright. */}
            <Badge>{server.transport}</Badge>
          </li>
          {server.skill ? (
            <li>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[color:var(--text-default)]">
                  {drivingSkill?.name ?? server.skill}
                </span>
                {/* Not decorative: the word "Skill" is the only thing
                    separating this line from the server named above it. */}
                <Badge>Skill</Badge>
              </div>
              {drivingSkill?.description ? (
                <div className="mt-0.5 text-meta leading-4 text-[color:var(--text-subtle)]">
                  {firstSentence(drivingSkill.description)}
                </div>
              ) : null}
            </li>
          ) : null}
        </ul>
      </div>
      {server.capabilities?.length ? (
        <div className="mt-3">
          <div className="text-meta font-semibold text-[color:var(--text-muted)]">Capabilities</div>
          <ul className="mt-1 space-y-0.5 text-body text-[color:var(--text-muted)]">
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
          <div className="text-meta font-semibold text-[color:var(--text-muted)]">Publisher &amp; source</div>
          <a
            href={server.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className={`mt-1 inline-flex text-body font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] ${FOCUS_RING_CLASS}`}
          >
            Source docs
          </a>
        </div>
      ) : null}
      {hasAuth ? (
        <div className="mt-3">
          <div className="text-meta font-semibold text-[color:var(--text-muted)]">Auth</div>
          <div className="mt-1 text-body text-[color:var(--text-subtle)]">
            {server.auth} — authenticates in chat on first use
          </div>
        </div>
      ) : null}
      {server.setupNotes ? (
        <p className="mt-3 border-l-2 border-[color:var(--border-strong)] pl-2 text-meta leading-4 text-[color:var(--text-subtle)]">
          {server.setupNotes}
        </p>
      ) : null}
      <div className="mt-4 space-y-2">
        {onNewChat ? (
          // A launchable connector leads with New chat (T1 runtime); Add/Remove
          // and Use in automation are the secondary actions.
          <>
            <PrimaryButton onClick={onNewChat} size="md" className="h-control-md w-full">
              New chat
            </PrimaryButton>
            {onUseInAutomation ? (
              <GhostButton
                onClick={onUseInAutomation}
                size="md"
                className="h-control-md w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Use in automation
              </GhostButton>
            ) : null}
            <GhostButton
              onClick={onToggle}
              size="md"
              className="h-control-md w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              {installed ? 'Remove from active' : 'Add to active'}
            </GhostButton>
          </>
        ) : installed ? (
          <GhostButton
            onClick={onToggle}
            size="md"
            className="h-control-md w-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Remove
          </GhostButton>
        ) : (
          <PrimaryButton onClick={onToggle} size="md" className="h-control-md w-full">
            Add to active
          </PrimaryButton>
        )}
      </div>
    </aside>
  )
}

export { mcpIconSlug, mcpMonogram }
