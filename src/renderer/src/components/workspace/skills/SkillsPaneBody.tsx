import React from 'react'

// Imported per module rather than through the `ui` barrel: the barrel re-exports
// the skill picker, which reaches the workspace store, and this file is a pure
// render of a view model that its test renders without one.
import { SprintEngineFrond } from '../../brand/SprintEngineFrond'
import { GhostButton, IconButton, PrimaryButton } from '../../ui/Buttons'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { InlineNotice } from '../../ui/InlineNotice'
import { Spinner } from '../../ui/Spinner'
import { Tooltip } from '../../ui/Tooltip'
import {
  isSprintEngineExtension,
  type PaneNotice,
  type PaneServerRow,
  type PaneSkillRow,
  type SkillsPaneView,
} from './skillsPaneModel'

// Everything the Skills pane draws, as a pure function of the view model. The
// container owns the store, the resolver query and the installer; this file
// owns the markup, and that split is what lets every one of the pane's states
// be asserted from rendered output.
//
// Rows follow the design system's list-row *host* pattern — an expand button
// with the actions as its sibling — rather than `ui/InboxRow`, for two reasons
// the bundle is explicit about: the row here is single-line (title and
// supporting clause share the line, and the supporting clause is what
// truncates), and selection is the neutral `--bg-selected`, where InboxRow
// draws the accent + left bar that `design-system/patterns/selection.html`
// labels as its anti-pattern. Conforming InboxRow itself belongs to the
// design-system-conformance item, not here.

export type SkillsPaneActions = {
  onExpand: (key: string | null) => void
  onAdd: (skillId: string) => void
  onRemove: (skillId: string) => void
  /** Park this skill's invocation at the focused agent's prompt. */
  onUse: (skillId: string) => void
  /** Load the drag with the skill, for the terminal that receives the drop. */
  onDragStart: (skillId: string, dataTransfer: DataTransfer) => void
  onRetry: () => void
  onOpenExtensions: () => void
  onDismissWriteReport: () => void
  onDismissUseError: () => void
}

type BodyProps = SkillsPaneActions & {
  view: SkillsPaneView
  expandedKey: string | null
  /** Skill id with an add/remove in flight; its row shows the spinner. */
  pendingSkillId: string | null
  /** False for a CLI that cannot be written to, which disables Add. */
  canWrite: boolean
  /**
   * False for a CLI with no invocation to park — it reads no skills, or there is
   * no workspace to resolve one against. Those rows offer neither the drag nor
   * the Send action, rather than a control that cannot do anything.
   */
  canUse: boolean
  agentLabel: string
  /** True only for CLIs whose manifest declares `implicitInvocation`. */
  implicitInvocation: boolean
}

// `--icon-lg`, as a number: the chip is sized in pixels (it carries artwork, not
// a stroke), and this is the one place the two have to agree — the row's icon
// slot is `size-icon-lg`.
const ROW_ICON_SIZE = 22

/** SprintEngine's own extensions wear our mark; everything else answers for itself. */
function ownMark(id: string): React.ReactNode {
  return isSprintEngineExtension(id) ? <SprintEngineFrond /> : undefined
}

const CHEVRON_RIGHT = 'M6.5 4 10 8l-3.5 4'
const CHEVRON_DOWN = 'M4 6.5 8 10l4-3.5'

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm shrink-0" aria-hidden="true">
      <path
        d={open ? CHEVRON_DOWN : CHEVRON_RIGHT}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function MinusGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// Use: the invocation travels from the pane to the prompt on its right.
function ArrowRightGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path
        d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 px-3 pb-1 pt-4 text-micro text-[color:var(--text-subtle)]">
      <span>{label}</span>
      <span className="ml-auto tabular-nums">{count}</span>
    </div>
  )
}

// Selection has two tiers. The pane the user is driving reads at full strength;
// every other pane keeps its choice visible without competing for the eye. The
// tier is pure CSS off the scroll container's focus, so nothing has to track
// which pane "has the drive" in state.
// The resting tier is `--bg-selected-resting`, the token that exists for it, not
// the `--bg-active` press fill it used to borrow (MC-2108): a selection at rest
// is still a selection, and spending the pressed-control token on it left the
// two states saying the same thing in different words.
const SELECTED_TIERS =
  'bg-[color:var(--bg-selected-resting)] group-focus-within/pane:bg-[color:var(--bg-selected)]'

function Row({
  title,
  supporting,
  trailing,
  glyph,
  tooltip,
  open,
  actions,
  onToggle,
  ariaLabel,
  onDragStart,
}: {
  title: string
  supporting: string
  trailing?: React.ReactNode
  glyph: React.ReactNode
  tooltip: string
  open: boolean
  actions: React.ReactNode[]
  onToggle: () => void
  ariaLabel: string
  /** Set only for a row that can be dragged; its absence is what removes the handle. */
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
}) {
  const expandButton = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-current={open ? 'true' : undefined}
      aria-label={ariaLabel}
      className="interactive flex min-w-0 flex-1 items-baseline gap-2 px-3 py-1.5 text-left focus-visible:focus-ring"
    >
      {/* Same one-slot disclosure used by project folders in WorkspaceSidebar:
          identity at rest, direction only while the row is being driven. The
          slot is the icon chip's own size (`--icon-lg`), so the mark sits in it
          at the size the Extensions door draws it rather than shrunk to fit. */}
      <span className="relative flex size-icon-lg shrink-0 self-center items-center justify-center text-[color:var(--text-subtle)]">
        <span className="inline-flex transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0">
          {glyph}
        </span>
        <span className="absolute inset-0 m-auto inline-flex items-center justify-center opacity-0 transition-[opacity,transform] group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <Chevron open={open} />
        </span>
      </span>
      {/* The title claims the width it needs and the supporting clause takes
          what is left, so a long description truncates long before the skill's
          own name does. */}
      <span className="min-w-0 shrink-0 truncate text-meta font-medium text-[color:var(--text-strong)]">
        {title}
      </span>
      {supporting ? (
        <span className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]">
          {supporting}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {trailing}
    </button>
  )

  return (
    <div
      // The whole row is the handle. Dragging is the mouse path only — the Use
      // action beside it is the same operation for the keyboard, so nothing here
      // is reachable one way and not the other.
      draggable={onDragStart ? true : undefined}
      onDragStart={onDragStart}
      className={`group/row flex items-stretch ${open ? SELECTED_TIERS : 'hover:bg-[color:var(--bg-hover)]'}`}
    >
      {tooltip ? (
        <Tooltip
          content={<span className="block max-w-[260px] whitespace-normal">{tooltip}</span>}
          placement="left"
          wrapperClassName="flex min-w-0 flex-1"
        >
          {expandButton}
        </Tooltip>
      ) : (
        expandButton
      )}
      {/* The slot is always laid out and only its opacity changes, so revealing
          the actions never reflows the row under the pointer. Keyboard focus
          reveals them too — hover-only would hide them from anyone not using a
          mouse. */}
      {actions.length > 0 ? (
        <span className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          {actions}
        </span>
      ) : null}
    </div>
  )
}

function DetailShell({ children }: { children: React.ReactNode }) {
  // Continues the selected row's fill rather than drawing a card, so the row and
  // its disclosure read as one opened thing.
  // design-tokens-allow: alignment — the detail sits on the row title's text edge, past the chevron and glyph slots
  // design-tokens-allow: alignment — the detail text starts under the row's title, past the row's `px-3` inset and its 22px `size-icon-lg` glyph slot
  return <div className={`px-3 pb-3 pl-9 text-meta ${SELECTED_TIERS}`}>{children}</div>
}

function SkillRow({
  row,
  open,
  pending,
  canWrite,
  canUse,
  agentLabel,
  implicitInvocation,
  onExpand,
  onAdd,
  onRemove,
  onUse,
  onDragStart,
  onOpenExtensions,
}: {
  row: PaneSkillRow
  open: boolean
  pending: boolean
  canWrite: boolean
  canUse: boolean
  agentLabel: string
  implicitInvocation: boolean
} & Pick<
  SkillsPaneActions,
  'onExpand' | 'onAdd' | 'onRemove' | 'onUse' | 'onDragStart' | 'onOpenExtensions'
>) {
  // A skill this agent cannot reach has no invocation to park, so a row still
  // under "Not installed" is Add-only — Use would be offering to name something
  // that is not there.
  const usable = row.installed && canUse

  // Ceiling of two revealed actions. Anything more belongs in the disclosure.
  const actions = row.installed
    ? [
      ...(usable
        ? [
          <Tooltip
            key="use"
            content={`Send to ${agentLabel}`}
            placement="bottom"
          >
            <IconButton
              aria-label={`Send ${row.skillId} to ${agentLabel}`}
              onClick={() => onUse(row.skillId)}
              // A remove in flight is about to take the skill away; naming it at
              // the prompt in that window would park an invocation for something
              // that is on its way out.
              disabled={pending}
            >
              <ArrowRightGlyph />
            </IconButton>
          </Tooltip>,
        ]
        : []),
      <Tooltip
        key="remove"
        content={`Remove ${row.skillId}`}
        placement="bottom"
      >
        <IconButton
          aria-label={`Remove ${row.skillId}`}
          onClick={() => onRemove(row.skillId)}
          disabled={pending}
        >
          {pending ? <Spinner /> : <MinusGlyph />}
        </IconButton>
      </Tooltip>,
    ]
    : [
      <Tooltip
        key="add"
        content={`Add ${row.skillId}`}
        placement="bottom"
      >
        <IconButton
          aria-label={`Add ${row.skillId}`}
          onClick={() => onAdd(row.skillId)}
          disabled={pending || !canWrite}
        >
          {pending ? <Spinner /> : <PlusGlyph />}
        </IconButton>
      </Tooltip>,
    ]

  return (
    <React.Fragment>
      <Row
        title={row.title}
        supporting={row.supporting}
        // The Extensions door's own mark for this thing, at the size that door
        // draws it in a list. A skill we ship wears our frond; a skill from
        // anywhere else has no artwork — no publisher ships any — so it takes
        // the monogram chip, exactly as it does in the door's inventory.
        glyph={
          <ExtensionIcon name={row.title} mark={ownMark(row.skillId)} size={ROW_ICON_SIZE} />
        }
        tooltip={row.description}
        open={open}
        actions={actions}
        ariaLabel={row.skillId}
        onToggle={() => onExpand(open ? null : row.key)}
        onDragStart={
          usable ? (event) => onDragStart(row.skillId, event.dataTransfer) : undefined
        }
      />
      {open ? (
        <DetailShell>
          {row.description ? (
            <p className="mb-2 leading-relaxed text-[color:var(--text-default)]">{row.description}</p>
          ) : (
            <p className="mb-2 text-[color:var(--text-muted)]">This skill declares no description.</p>
          )}
          {row.installed && implicitInvocation ? (
            <p className="mb-3 text-micro text-[color:var(--text-muted)]">
              {agentLabel} may also run it unprompted when the description matches.
            </p>
          ) : !row.installed ? (
            <p className="mb-3 text-micro text-[color:var(--text-muted)]">
              Not in this workspace yet
            </p>
          ) : null}
          {/* Exactly one accent fill in this pane, and it is the disclosure's
              primary: Use for a skill the agent has, Add for one it does not. */}
          <div className="flex items-center gap-2">
            {row.installed ? (
              usable ? (
                <PrimaryButton size="xs" onClick={() => onUse(row.skillId)}>
                  Send to {agentLabel}
                </PrimaryButton>
              ) : null
            ) : (
              <PrimaryButton
                size="xs"
                onClick={() => onAdd(row.skillId)}
                disabled={pending || !canWrite}
              >
                {pending ? 'Adding…' : 'Add'}
              </PrimaryButton>
            )}
            <GhostButton size="xs" onClick={onOpenExtensions}>
              Open in Plugins
            </GhostButton>
          </div>
        </DetailShell>
      ) : null}
    </React.Fragment>
  )
}

function ServerRow({
  row,
  open,
  onExpand,
  onOpenExtensions,
}: {
  row: PaneServerRow
  open: boolean
} & Pick<SkillsPaneActions, 'onExpand' | 'onOpenExtensions'>) {
  return (
    <React.Fragment>
      <Row
        title={row.title}
        supporting={row.supporting}
        // Our own server wears the frond; a catalog server wears its own brand
        // mark; anything else — a local or private server the bundled catalog
        // has never heard of — wears its monogram rather than having its name
        // guessed at by an icon CDN.
        glyph={
          <ExtensionIcon
            name={row.title}
            icon={row.iconUrl ?? undefined}
            mark={ownMark(row.serverId)}
            size={ROW_ICON_SIZE}
          />
        }
        // Only when the config stated one. A server with no declared tool count
        // renders no count at all rather than a zero it did not earn.
        trailing={
          row.toolCount === null ? undefined : (
            <span className="shrink-0 tabular-nums text-micro text-[color:var(--text-subtle)]">
              {row.toolCount}
            </span>
          )
        }
        tooltip={`${row.serverId} — ${row.supporting} · ${row.configPaths.join(', ')}`}
        open={open}
        actions={[]}
        ariaLabel={row.serverId}
        onToggle={() => onExpand(open ? null : row.key)}
      />
      {open ? (
        <DetailShell>
          <p className="mb-3 text-micro text-[color:var(--text-muted)]">
            {row.pluginIds.length > 0 ? `Read by ${row.pluginIds.join(', ')} · ` : ''}
            {row.scope === 'workspace' ? 'This workspace' : 'Your user config'}
            {' · '}
            <span className="font-mono text-[color:var(--text-subtle)]">
              {row.configPaths.join(', ')}
            </span>
            {row.toolCount === null ? '' : ` · ${row.toolCount} tools`}
          </p>
          <div className="flex items-center gap-2">
            <GhostButton size="xs" onClick={onOpenExtensions}>
              Open in Plugins
            </GhostButton>
          </div>
        </DetailShell>
      ) : null}
    </React.Fragment>
  )
}

// Neutral tone: this states a fact and asks for nothing. `InlineNotice` carries
// only error and warn, which are the wrong voice for "this CLI reads no skills"
// and "the list may be stale" — neither is a failure or a degraded feature.
function QuietNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-3 mt-3 rounded-[5px] border border-[color:var(--border-subtle)] px-3 py-2 text-micro text-[color:var(--text-default)]"
      role="status"
    >
      {children}
    </div>
  )
}

function Notice({
  notice,
  agentLabel,
  onRetry,
  onDismissWriteReport,
  onDismissUseError,
}: {
  notice: PaneNotice
  agentLabel: string
} & Pick<SkillsPaneActions, 'onRetry' | 'onDismissWriteReport' | 'onDismissUseError'>) {
  switch (notice.kind) {
    case 'unsupported':
      return (
        <QuietNotice>
          <span className="font-medium text-[color:var(--text-strong)]">
            {agentLabel} does not read skills.
          </span>{' '}
          Nothing here reaches it. Your other agents keep every skill below.
        </QuietNotice>
      )
    case 'stale':
      return (
        <QuietNotice>
          <span className="font-medium text-[color:var(--text-strong)]">
            This list may be out of date.
          </span>{' '}
          {notice.message}
        </QuietNotice>
      )
    case 'unreadable':
      return (
        <div className="px-3 pt-3">
          <InlineNotice
            tone="error"
            title={
              notice.capability === 'skills'
                ? 'Could not read this agent’s skills.'
                : 'Could not read this agent’s MCP servers.'
            }
            hint={notice.path}
            detail={notice.message}
            action={
              <GhostButton size="xs" onClick={onRetry}>
                Try again
              </GhostButton>
            }
          />
        </div>
      )
    case 'restart':
      return (
        <div className="px-3 pt-3">
          <InlineNotice tone="warn">
            <span className="font-medium text-[color:var(--text-strong)]">
              Restart {agentLabel}
            </span>{' '}
            to pick up {notice.skillIds.join(', ')}.
          </InlineNotice>
        </div>
      )
    case 'write-partial':
      return (
        <div className="px-3 pt-3">
          <InlineNotice
            tone="warn"
            title={
              notice.verb === 'add'
                ? `${notice.skillId} reached ${notice.written.length} of ${notice.written.length + notice.failed.length} places.`
                : `${notice.skillId} was removed from ${notice.written.length} of ${notice.written.length + notice.failed.length} places.`
            }
            hint={notice.failed.map((failure) => failure.path).join(', ')}
            detail={notice.failed.map((failure) => `${failure.path}: ${failure.message}`).join('\n')}
            action={
              <GhostButton size="xs" onClick={onDismissWriteReport}>
                Dismiss
              </GhostButton>
            }
          />
        </div>
      )
    case 'write-failed':
      return (
        <div className="px-3 pt-3">
          <InlineNotice
            tone="error"
            title={
              notice.verb === 'add'
                ? `${notice.skillId} was not added.`
                : `${notice.skillId} was not removed.`
            }
            detail={notice.message}
            action={
              <GhostButton size="xs" onClick={onDismissWriteReport}>
                Dismiss
              </GhostButton>
            }
          />
        </div>
      )
    case 'use-failed':
      return (
        <div className="px-3 pt-3">
          <InlineNotice
            tone="error"
            title={`${notice.skillId} was not sent to ${notice.agentLabel}.`}
            detail={notice.message}
            action={
              <GhostButton size="xs" onClick={onDismissUseError}>
                Dismiss
              </GhostButton>
            }
          />
        </div>
      )
    default:
      return null
  }
}

export function SkillsPaneBody({
  view,
  expandedKey,
  pendingSkillId,
  canWrite,
  canUse,
  agentLabel,
  implicitInvocation,
  onExpand,
  onAdd,
  onRemove,
  onUse,
  onDragStart,
  onRetry,
  onOpenExtensions,
  onDismissWriteReport,
  onDismissUseError,
}: BodyProps) {
  const { notices, body } = view

  const noticeNodes = notices.map((notice, index) => (
    <Notice
      key={`${notice.kind}:${index}`}
      notice={notice}
      agentLabel={agentLabel}
      onRetry={onRetry}
      onDismissWriteReport={onDismissWriteReport}
      onDismissUseError={onDismissUseError}
    />
  ))

  const skillRowProps = {
    canWrite,
    canUse,
    agentLabel,
    implicitInvocation,
    onExpand,
    onAdd,
    onRemove,
    onUse,
    onDragStart,
    onOpenExtensions,
  }

  const content = ((): React.ReactNode => {
    switch (body.kind) {
      case 'loading':
        // One animation at a time: a single spinner, not a field of skeletons.
        return (
          <div
            className="flex items-center gap-2 px-3 py-4 text-meta text-[color:var(--text-muted)]"
            role="status"
          >
            <Spinner />
            Reading this agent’s skills…
          </div>
        )
      case 'no-agent':
        return (
          <p className="px-3 py-4 text-meta text-[color:var(--text-muted)]">
            No agent tab is focused.
          </p>
        )
      case 'unavailable':
        return (
          <p className="px-3 py-4 text-meta text-[color:var(--text-muted)]">{body.message}</p>
        )
      case 'fault':
        // Named above by its own banner, with the path and the retry. Repeating
        // it here as an empty line would be the failure reading as absence.
        return null
      case 'empty':
        return (
          <p className="px-3 py-4 text-meta text-[color:var(--text-muted)]">
            No skills or MCP servers for this agent.
          </p>
        )
      case 'no-matches':
        return (
          <div className="px-3 py-6 text-center text-meta text-[color:var(--text-muted)]">
            <p>No skill or server matches “{body.query}”.</p>
            <div className="mt-2 flex justify-center">
              <GhostButton size="xs" onClick={onOpenExtensions}>
                Search your sources
              </GhostButton>
            </div>
          </div>
        )
      case 'sections':
        return (
          <>
            {body.skills.length > 0 ? (
              <>
                <SectionHead label="Skills" count={body.skills.length} />
                {body.skills.map((row) => (
                  <SkillRow
                    key={row.key}
                    row={row}
                    open={expandedKey === row.key}
                    pending={pendingSkillId === row.skillId}
                    {...skillRowProps}
                  />
                ))}
              </>
            ) : null}
            {body.available.length > 0 ? (
              <>
                <SectionHead label="Not installed" count={body.available.length} />
                {body.available.map((row) => (
                  <SkillRow
                    key={row.key}
                    row={row}
                    open={expandedKey === row.key}
                    pending={pendingSkillId === row.skillId}
                    {...skillRowProps}
                  />
                ))}
              </>
            ) : null}
            {body.servers.length > 0 ? (
              <>
                <SectionHead label="MCP servers" count={body.servers.length} />
                {body.servers.map((row) => (
                  <ServerRow
                    key={row.key}
                    row={row}
                    open={expandedKey === row.key}
                    onExpand={onExpand}
                    onOpenExtensions={onOpenExtensions}
                  />
                ))}
              </>
            ) : null}
            {body.catalogueRemaining > 0 ? (
              <p className="px-3 pt-4 text-micro text-[color:var(--text-subtle)]">
                {body.catalogueRemaining} more in your sources.
              </p>
            ) : null}
          </>
        )
      default:
        return null
    }
  })()

  return (
    <div className="group/pane min-h-0 flex-1 overflow-y-auto pb-3">
      {noticeNodes}
      {content}
    </div>
  )
}
