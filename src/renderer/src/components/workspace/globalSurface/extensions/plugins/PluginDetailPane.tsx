// One plugin, opened: a catalogue of the skills and MCP servers it ships.
//
// Installing the plugin as a unit copied every skill it declared — a
// marketplace plugin can ship a hundred-plus — into every agent CLI's
// skills directory. The pane is now the place you pick items from, and
// Remove on the plugin takes back everything this install wrote.

import React, { useMemo, useState } from 'react'

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import {
  SOURCE_SHAPE_LABEL,
  describeUnreadPlugin,
  skillDirName,
  type ScannedMcpServer,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillHarness,
  type SkillSource,
  type SourceShape,
} from '../../../../../../../shared/skills'
import {
  DefinitionList,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  OutlineButton,
  PrimaryButton,
  Section,
  Spinner,
} from '../../../../ui'
import { Modal, ModalFooter, ModalHeader } from '../../../../ui/Modal'
import { ExtensionIcon } from '../../../../ui/ExtensionIcon'
import { extensionIconProps, pluginArtwork } from '../catalogue/pluginArtwork'
import {
  describeInstallPlan,
  describePluginFilesPlan,
  pluginComponentMatchesQuery,
  pluginExternalUrl,
  type PluginInstallAvailability,
  type PluginInstallState,
} from './pluginsSurfaceModel'
import { shortCommit } from '../skills/skillsSurfaceModel'
import { UseSkillInAgentAction } from '../UseSkillInAgentAction'

export type PluginDetailPaneProps = {
  source: SkillSource
  shape: SourceShape
  marketplaceName: string
  plugin: ScannedPlugin
  /** Set while a linked plugin's own repository is being read. */
  reading: boolean
  readError: string | null
  onRetryRead: () => void
  harnesses: readonly SkillHarness[]
  /** The workspace its skills would be used in. Null when no folder is open. */
  workspaceRoot?: string | null
  install: PluginInstallState
  availability: PluginInstallAvailability
  /** Skill directory names this workspace already holds. */
  installedDirNames: ReadonlySet<string>
  /** MCP server ids configured on this machine. */
  installedMcpIds: ReadonlySet<string>
  /** The item currently installing or removing; null when the pane is idle. */
  busyItem: string | null
  onInstallSkill: (skillId: string) => void
  onRemoveSkill: (skillId: string) => void
  onInstallMcp: (serverId: string) => void
  onRemoveMcp: (serverId: string) => void
  onUpdateInstalled: () => void
  onUninstall: (record: InstalledPluginRecord) => void
  onClose: () => void
}

/** The header's icon slot, in one place: the artwork ladder asks for its size. */
const HEADER_ICON_SIZE = 40

const SKILLS_FILTER_LIST_ID = 'plugin-detail-skills'

export function PluginDetailPane(props: PluginDetailPaneProps): JSX.Element {
  const { plugin } = props
  const titleId = 'plugin-detail-title'
  const external = pluginExternalUrl(plugin, props.source)
  const hooks = plugin.components.hooks
  const plan = describeInstallPlan({
    plugin,
    marketplaceName: props.marketplaceName,
    marketplaceRepo: props.source.kind === 'github' ? props.source.repo : '',
    harnesses: props.harnesses,
  })
  const filesPlan = describePluginFilesPlan(plugin)
  const origin = plugin.origin
  const installed = props.install.kind !== 'not-installed'
  const busy = props.busyItem !== null
  const [query, setQuery] = useState('')
  const skills = plugin.components.skills
  const servers = plugin.components.mcpServers
  const visibleSkills = useMemo(
    () => skills.filter((skill) => pluginComponentMatchesQuery(skill.name, skill.description, query)),
    [query, skills],
  )
  const visibleServers = useMemo(
    () => servers.filter((server) => pluginComponentMatchesQuery(server.name, server.description, query)),
    [query, servers],
  )
  const showFilter = skills.length + servers.length > 8
  // Who published it and what version, in one line under the name. The About
  // list below carries the rest — where it comes from and at what commit.
  const subtitle = [plugin.author, plugin.version ? `v${plugin.version}` : '', plugin.category]
    .filter(Boolean)
    .join(' · ')

  return (
    <Modal open onClose={props.onClose} labelledBy={titleId} size="wide" layout="panel">
      <ModalHeader
        title={plugin.name}
        subtitle={subtitle || undefined}
        titleId={titleId}
        onClose={props.onClose}
        leading={
          <ExtensionIcon
            name={plugin.name}
            size={HEADER_ICON_SIZE}
            {...extensionIconProps(pluginArtwork(plugin, props.source, HEADER_ICON_SIZE))}
          />
        }
      />
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-[color:var(--border-subtle)] px-3 pb-3">
        {plugin.description ? (
          <p className="px-3 pt-4 text-body leading-relaxed text-[color:var(--text-default)]">{plugin.description}</p>
        ) : null}

        {props.reading ? (
          <div className="flex items-center gap-2 px-3 pt-3 text-body text-[color:var(--text-muted)]">
            <Spinner size={14} />
            {origin.kind === 'linked' ? `Reading ${origin.repo || origin.url}…` : 'Reading…'}
          </div>
        ) : null}
        {props.readError ? (
          <div className="px-3 pt-3">
            <InlineNotice
              tone="error"
              title={`${plugin.name} could not be read.`}
              hint="Its components are not listed below — this is not an empty plugin."
              detail={props.readError}
              action={<GhostButton onClick={props.onRetryRead}>Try again</GhostButton>}
            />
          </div>
        ) : null}

        <Section level={4} title="About">
          <DefinitionList
            items={[
              { term: 'Source', description: describeOrigin(plugin, props.source, props.shape) },
              ...(commitLine(plugin, props.source).sha
                ? [
                    {
                      term: commitLine(plugin, props.source).term,
                      description: <span className="font-mono">{commitLine(plugin, props.source).sha}</span>,
                    },
                  ]
                : []),
            ]}
          />
        </Section>

        {plugin.componentsKnown && showFilter ? (
          <div className="px-3 pt-3">
            <InboxSearchInput
              value={query}
              onChange={setQuery}
              ariaLabel={`Filter ${plugin.name}`}
              placeholder="Filter skills and servers"
              controlsId={SKILLS_FILTER_LIST_ID}
            />
          </div>
        ) : null}

        {plugin.componentsKnown ? (
          <div id={SKILLS_FILTER_LIST_ID}>
            <Section level={4} title="Skills" count={skills.length}>
              {skills.length === 0 ? (
                <p className="text-meta text-[color:var(--text-subtle)]">None</p>
              ) : visibleSkills.length === 0 ? (
                <p className="text-meta text-[color:var(--text-subtle)]">No skills match.</p>
              ) : (
                <ul role="list" className="flex flex-col gap-1.5">
                  {visibleSkills.map((skill) => (
                    <SkillItemRow
                      key={skill.id}
                      skill={skill}
                      installed={props.installedDirNames.has(skillDirName(skill.id))}
                      availability={props.availability}
                      workspaceRoot={props.workspaceRoot ?? null}
                      busy={busy}
                      busyThis={props.busyItem === `skill:${skill.id}`}
                      onInstall={() => props.onInstallSkill(skill.id)}
                      onRemove={() => props.onRemoveSkill(skill.id)}
                    />
                  ))}
                </ul>
              )}
            </Section>

            <Section level={4} title="MCP servers" count={servers.length}>
              {servers.length === 0 ? (
                <p className="text-meta text-[color:var(--text-subtle)]">None</p>
              ) : visibleServers.length === 0 ? (
                <p className="text-meta text-[color:var(--text-subtle)]">No servers match.</p>
              ) : (
                <ul role="list" className="flex flex-col gap-1.5">
                  {visibleServers.map((server) => (
                    <McpItemRow
                      key={server.id}
                      server={server}
                      installed={props.installedMcpIds.has(server.id)}
                      availability={props.availability}
                      busy={busy}
                      busyThis={props.busyItem === `mcp:${server.id}`}
                      onInstall={() => props.onInstallMcp(server.id)}
                      onRemove={() => props.onRemoveMcp(server.id)}
                    />
                  ))}
                </ul>
              )}
            </Section>

            <Section level={4} title="Also ships">
              <dl className="flex flex-col gap-2 text-meta">
                {plugin.components.missingSkills.length > 0 ? (
                  <ComponentRow label="Listed, not found" values={plugin.components.missingSkills} muted />
                ) : null}
                <ComponentRow label="Commands" values={plugin.components.commands.map((name) => `/${name}`)} mono />
                <ComponentRow label="Agents" values={plugin.components.agents} />
                <ComponentRow
                  label="LSP servers"
                  values={plugin.components.lspServers.map((server) =>
                    [
                      server.id,
                      `${server.command} ${server.args.join(' ')}`.trim(),
                      Object.keys(server.extensionToLanguage).join(' '),
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  )}
                  mono
                />
                <ComponentRow
                  label="Hooks"
                  values={hooks.map((hook) => `${hook.event}${hook.matcher ? ` on ${hook.matcher}` : ''}: ${hook.command}`)}
                  mono
                />
              </dl>
            </Section>
          </div>
        ) : (
          <Section level={4} title="Components">
            <p className="text-meta text-[color:var(--text-muted)]">
              {props.reading ? 'Reading…' : describeUnreadPlugin(plugin)}
            </p>
          </Section>
        )}

        {props.harnesses.length > 0 ? (
          <Section level={4} title="What installs where">
            <dl className="flex flex-col gap-2 text-meta">
              {filesPlan ? (
                <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
                  <dt className="font-medium text-[color:var(--text-strong)]">Plugin files</dt>
                  <dd className="break-words leading-relaxed text-[color:var(--text-muted)]">{filesPlan}</dd>
                </div>
              ) : null}
              {plan.map((line) => (
                <div key={line.harness} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
                  <dt className="font-medium text-[color:var(--text-strong)]">{line.label}</dt>
                  <dd className="break-words leading-relaxed text-[color:var(--text-muted)]">{line.line}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}

        {plugin.componentsKnown && hooks.length > 0 ? (
          <div className="px-3 pb-3">
            <InlineNotice
              tone="warn"
              title={`This plugin declares ${hooks.length === 1 ? 'a hook command' : `${hooks.length} hook commands`}.`}
              hint="Hooks run on your machine when the agent works. Installing a skill or server here copies no hooks; the commands listed above are exactly what would run if you loaded this plugin in Claude Code yourself. Unsigned; not reviewed by SprintEngine Studio."
            />
          </div>
        ) : null}

        {!props.availability.enabled && props.availability.reason ? (
          <p className="px-3 pb-3 text-meta text-[color:var(--text-muted)]">{props.availability.reason}</p>
        ) : null}
        {props.install.kind === 'update-available' ? (
          <p className="px-3 pb-3 text-meta text-[color:var(--text-muted)]">
            {`Installed from this source at ${shortCommit(props.install.record.commitSha)}; the source now reads ${
              commitLine(plugin, props.source).sha || 'a newer commit'
            }. Update refreshes the items already installed.`}
          </p>
        ) : null}
      </div>
      <div className="border-t border-[color:var(--border-subtle)]">
        <ModalFooter>
          {external ? (
            <GhostButton size="md" className="mr-auto" onClick={() => void window.api.openExternal(external)}>
              Open on GitHub
            </GhostButton>
          ) : (
            <span className="mr-auto" />
          )}
          {installed && props.install.kind !== 'not-installed' ? (
            <OutlineButton
              size="md"
              disabled={busy || props.install.record.sourceId === ''}
              onClick={() => props.install.kind !== 'not-installed' && props.onUninstall(props.install.record)}
            >
              {props.busyItem === 'plugin' ? 'Removing…' : 'Remove plugin'}
            </OutlineButton>
          ) : null}
          {props.install.kind === 'update-available' ? (
            <PrimaryButton
              size="md"
              disabled={!props.availability.enabled || busy || props.reading}
              onClick={props.onUpdateInstalled}
            >
              {props.busyItem === 'update' ? 'Updating…' : 'Update installed'}
            </PrimaryButton>
          ) : null}
        </ModalFooter>
      </div>
    </Modal>
  )
}

function SkillItemRow({
  skill,
  installed,
  availability,
  workspaceRoot,
  busy,
  busyThis,
  onInstall,
  onRemove,
}: {
  skill: ScannedSkill
  installed: boolean
  availability: PluginInstallAvailability
  workspaceRoot: string | null
  busy: boolean
  busyThis: boolean
  onInstall: () => void
  onRemove: () => void
}): JSX.Element {
  const dirName = skillDirName(skill.id)
  return (
    <li className="flex items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] pb-1.5 last:border-b-0 last:pb-0">
      <span className="min-w-0">
        <span className="block truncate text-meta text-[color:var(--text-default)]">{skill.name}</span>
        {skill.description ? (
          <span className="block truncate text-micro text-[color:var(--text-subtle)]">{skill.description}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {installed ? (
          <>
            <GhostButton size="sm" disabled={busy} onClick={onRemove} aria-label={`Remove ${skill.name}`}>
              {busyThis ? 'Removing…' : 'Remove'}
            </GhostButton>
            <UseSkillInAgentAction
              skillId={dirName}
              skillName={skill.name}
              workspaceRoot={workspaceRoot}
              disabled={busy}
            />
          </>
        ) : (
          <OutlineButton
            size="sm"
            disabled={!availability.enabled || busy}
            onClick={onInstall}
            aria-label={`Install ${skill.name}`}
          >
            {busyThis ? 'Installing…' : 'Install'}
          </OutlineButton>
        )}
      </span>
    </li>
  )
}

function McpItemRow({
  server,
  installed,
  availability,
  busy,
  busyThis,
  onInstall,
  onRemove,
}: {
  server: ScannedMcpServer
  installed: boolean
  availability: PluginInstallAvailability
  busy: boolean
  busyThis: boolean
  onInstall: () => void
  onRemove: () => void
}): JSX.Element {
  const summary =
    server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url
  return (
    <li className="flex items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] pb-1.5 last:border-b-0 last:pb-0">
      <span className="min-w-0">
        <span className="block truncate text-meta text-[color:var(--text-default)]">{server.name || server.id}</span>
        {summary ? <span className="block truncate font-mono text-micro text-[color:var(--text-subtle)]">{summary}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {installed ? (
          <GhostButton size="sm" disabled={busy} onClick={onRemove} aria-label={`Remove ${server.name || server.id}`}>
            {busyThis ? 'Removing…' : 'Remove'}
          </GhostButton>
        ) : (
          <OutlineButton
            size="sm"
            disabled={!availability.enabled || busy}
            onClick={onInstall}
            aria-label={`Install ${server.name || server.id}`}
          >
            {busyThis ? 'Installing…' : 'Install'}
          </OutlineButton>
        )}
      </span>
    </li>
  )
}

function ComponentRow({
  label,
  values,
  mono,
  muted,
}: {
  label: string
  values: readonly string[]
  mono?: boolean
  muted?: boolean
}): JSX.Element {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
      <dt className="text-[color:var(--text-muted)]">{label}</dt>
      <dd className={`min-w-0 break-words ${muted ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-default)]'}`}>
        {values.length === 0 ? (
          <span className="text-[color:var(--text-subtle)]">None</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {values.map((value, index) => (
              <li key={`${index}-${value}`} className={mono ? 'font-mono text-micro' : ''}>
                {value}
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  )
}

function describeOrigin(plugin: ScannedPlugin, source: SkillSource, shape: SourceShape): React.ReactNode {
  const origin = plugin.origin
  if (origin.kind === 'linked') {
    return (
      <span>
        <span className="font-mono">{origin.repo || origin.url}</span>
        {origin.path ? <span className="font-mono">{` · ${origin.path}`}</span> : null}
        {origin.repo === '' ? ' · hosted outside GitHub' : ''}
      </span>
    )
  }
  if (origin.kind === 'registry') return 'Multicode marketplace'
  return (
    <span>
      {source.repo ? <span className="font-mono">{source.repo}</span> : source.name}
      {origin.path ? <span className="font-mono">{` · ${origin.path}`}</span> : null}
      {` · ${SOURCE_SHAPE_LABEL[shape]}`}
    </span>
  )
}

/**
 * The commit this plugin's bytes come from, and whether anybody PINNED it.
 *
 * "Pinned to" is a claim about the marketplace, not about the app: an entry
 * that names a ref and no sha is deliberately floating, and labelling the
 * commit a scan happened to resolve as a pin told a reader the publisher had
 * fixed it there (linked-plugins review, 2026-09-06).
 */
function commitLine(plugin: ScannedPlugin, source: SkillSource): { term: string; sha: string } {
  if (plugin.origin.kind !== 'linked') return { term: 'Pinned to', sha: shortCommit(source.commitSha) }
  if (plugin.origin.sha) return { term: 'Pinned to', sha: shortCommit(plugin.origin.sha) }
  return { term: 'Read at', sha: shortCommit(plugin.readCommit ?? '') }
}
