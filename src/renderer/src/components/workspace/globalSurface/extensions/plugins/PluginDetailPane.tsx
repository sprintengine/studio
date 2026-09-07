// One plugin, opened beside its list: what it is, what it ships, what will
// land where, and — when it runs commands on this machine — exactly which.
//
// A right side pane, not a page: the person is comparing plugins from one
// source, and switching between them should not cost a round trip through an
// index. The pane is its own view, so its Install is the one accent fill on
// screen; the list behind it carries no primary action.

import React from 'react'

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import {
  SOURCE_SHAPE_LABEL,
  describeUnreadPlugin,
  type ScannedPlugin,
  type SkillHarness,
  type SkillSource,
  type SourceShape,
} from '../../../../../../../shared/skills'
import {
  Checkbox,
  DefinitionList,
  GhostButton,
  InlineNotice,
  OutlineButton,
  PrimaryButton,
  Section,
  SidePane,
  SidePaneHeader,
  Spinner,
} from '../../../../ui'
import {
  describeInstallPlan,
  describePluginFilesPlan,
  pluginExternalUrl,
  type PluginInstallAvailability,
  type PluginInstallState,
} from './pluginsSurfaceModel'
import { shortCommit } from '../skills/skillsSurfaceModel'

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
  install: PluginInstallState
  availability: PluginInstallAvailability
  installing: boolean
  hooksAcknowledged: boolean
  onHooksAcknowledgedChange: (next: boolean) => void
  onInstall: () => void
  onUninstall: (record: InstalledPluginRecord) => void
  onClose: () => void
}

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

  return (
    <SidePane side="right" width="md" ariaLabelledBy={titleId} className="min-h-0">
      <SidePaneHeader title={plugin.name} titleId={titleId} onClose={props.onClose} closeLabel={`Close ${plugin.name}`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {plugin.description ? (
          <p className="px-3 pt-3 text-body leading-relaxed text-[color:var(--text-default)]">{plugin.description}</p>
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
              ...(plugin.author ? [{ term: 'Publisher', description: plugin.author }] : []),
              ...(plugin.version ? [{ term: 'Version', description: <span className="font-mono">{plugin.version}</span> }] : []),
              ...(plugin.category ? [{ term: 'Category', description: plugin.category }] : []),
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

        <Section level={4} title="Components" count={plugin.componentsKnown ? componentCount(plugin) : undefined}>
          {plugin.componentsKnown ? (
            <dl className="flex flex-col gap-2 text-meta">
              <ComponentRow label="Skills" values={plugin.components.skills.map((skill) => skill.name)} />
              {plugin.components.missingSkills.length > 0 ? (
                <ComponentRow label="Listed, not found" values={plugin.components.missingSkills} muted />
              ) : null}
              <ComponentRow label="Commands" values={plugin.components.commands.map((name) => `/${name}`)} mono />
              <ComponentRow label="Agents" values={plugin.components.agents} />
              <ComponentRow
                label="MCP servers"
                values={plugin.components.mcpServers.map((server) =>
                  [
                    server.id,
                    server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url,
                    server.envVarNames.length > 0 ? `needs ${server.envVarNames.join(', ')}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )}
                mono
              />
              <ComponentRow
                label="LSP servers"
                // A language server is named by what it starts and what it
                // covers: the twelve `*-lsp` plugins in the official
                // marketplace are this declaration and nothing else, and
                // without the extensions the row would not say which language
                // the plugin is for.
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
          ) : (
            <p className="text-meta text-[color:var(--text-muted)]">
              {props.reading ? 'Reading…' : describeUnreadPlugin(plugin)}
            </p>
          )}
        </Section>

        {props.harnesses.length > 0 ? (
          <Section level={4} title="What installs where">
            <dl className="flex flex-col gap-2 text-meta">
              {/*
                Above the per-harness lines because it is not per-harness: one
                copy of the plugin's directory serves every CLI's MCP config
                (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
              */}
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

        {/*
          Not "this plugin runs a command on your machine": no harness this app
          writes for loads a plugin's hooks, so an install here runs nothing.
          The disclosure stays — and the acknowledgement gate with it — because
          the workspace's .claude/settings.json names the plugin, and a
          `claude plugin install` would make exactly these commands run
          (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
        */}
        {plugin.componentsKnown && hooks.length > 0 ? (
          <div className="px-3 pb-3">
            <InlineNotice
              tone="warn"
              title={`This plugin declares ${hooks.length === 1 ? 'a hook command' : `${hooks.length} hook commands`}.`}
              hint="Hooks run on your machine when the agent works. Installing here copies no hooks; the commands listed above are exactly what would run, at the commit shown, if you loaded this plugin in Claude Code yourself. Unsigned; not reviewed by Multicode."
            >
              <div className="mt-2">
                <Checkbox
                  checked={props.hooksAcknowledged}
                  onChange={props.onHooksAcknowledgedChange}
                  label="I have read the commands and they may run"
                  size="body"
                />
              </div>
            </InlineNotice>
          </div>
        ) : null}

        {!props.availability.enabled && props.availability.reason && !installed ? (
          <p className="px-3 pb-3 text-meta text-[color:var(--text-muted)]">{props.availability.reason}</p>
        ) : null}
        {props.install.kind === 'update-available' ? (
          <p className="px-3 pb-3 text-meta text-[color:var(--text-muted)]">
            {`Installed from this source at ${shortCommit(props.install.record.commitSha)}; the source now reads ${
              commitLine(plugin, props.source).sha || 'a newer commit'
            }. Install again to refresh.`}
          </p>
        ) : null}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[color:var(--border-default)] px-3 py-2">
        {external ? (
          <GhostButton onClick={() => void window.api.openExternal(external)}>Open on GitHub</GhostButton>
        ) : null}
        {installed && props.install.kind !== 'not-installed' ? (
          <OutlineButton
            disabled={props.installing || props.install.record.sourceId === ''}
            onClick={() => props.install.kind !== 'not-installed' && props.onUninstall(props.install.record)}
          >
            Remove
          </OutlineButton>
        ) : null}
        <PrimaryButton
          disabled={!props.availability.enabled || props.installing || props.reading}
          onClick={props.onInstall}
        >
          {props.installing
            ? 'Installing…'
            : props.install.kind === 'update-available'
              ? 'Update in this workspace'
              : installed
                ? 'Install again'
                : 'Install to this workspace'}
        </PrimaryButton>
      </footer>
    </SidePane>
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

function componentCount(plugin: ScannedPlugin): number {
  const c = plugin.components
  return (
    c.skills.length
    + c.commands.length
    + c.agents.length
    + c.mcpServers.length
    + c.lspServers.length
    + c.hooks.length
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
