import React from 'react'

import CliIcon from '../CliIcon'
import { GitBranchGlyph, RemoteMachineGlyph, WslMachineGlyph } from '../AppIcons'
import { ContextRing, TruncatedText, WorkingMark } from '../ui'
import { formatRelativeMs } from '../../utils/relativeTime'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import type { AgentCli } from '../../types/workspace'
import type { SessionContextUsage } from '../../../../shared/electron-api'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { PullRequestPeekMark } from './PullRequestMark'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'

// The conversation peek — one hover surface for "what is this chat", opened
// from a sidebar row and from an agent tab.
//
// This file is the PRESENTATIONAL half: identity in, markup out, no portal, no
// hover mechanics, no IPC — so it server-renders under the repo's static-markup
// test harness and so the two anchors (row, tab) can hold it in whichever shell
// they already own. `ConversationPeekPopover` and `AgentTabIdentityPopover` are
// the two shells; neither draws any of this itself.
//
// A GLANCE, NOT A READER (owner, 2026-10-04). The card used to carry the
// conversation itself — every captured prompt as a scrolling thread, the files
// the agent changed, the session id with a copy button. The conversation's
// rail now shows the whole history in place, so the card is back to what a
// hover is for: at most four short facts, one per line — the machine when it
// is not this one, the branch, the model, and how much of the context window
// it has spent, in tokens. Modelled on T3 Code's thread hover card, minus the
// project (the row already sits under it) and minus "this computer", which
// is the unmarked default everywhere else in the sidebar too.
//
// ONE AGENT PER CARD (owner, 2026-09-09). The sidebar already lists a chat's
// agents as its own sub-lines, so the person points at the one they mean and
// the card is that agent's.

/**
 * The chat's live state, in the corner's voice.
 *
 * `kind` and not a `Tone`, because the corner is not a status dot and never
 * was: it is the SIDEBAR's own mark — the working mark — and one word beside
 * them. Three kinds are all the corner can draw differently: dots and muted
 * ink, no dots and subtle ink, no dots and muted ink.
 */
export type ConversationPeekStatus = {
  /**
   * - `working` — the dots, and the word.
   * - `idle` — no dots, and the quieter ink: nothing is happening, and a chat
   *   at rest should not be as loud as one that is running.
   * - `attention` — no dots, muted ink. Waiting, Failed, Paused: states worth
   *   the same weight as Working without claiming motion that is not there.
   */
  kind: 'working' | 'idle' | 'attention'
  /** The one word (or short phrase) the corner says: "Working", "Idle", "Failed". */
  label: string
  /**
   * A label that reads its age once there is one: from a minute after `since`
   * the corner says "`label` · 2m" ("Paused · 2m", "Last typed · 12m") in
   * place of the plain `label` above. It formats the age on its own clock, so
   * the age keeps moving while the card is open and nothing else redraws.
   */
  aged?: { label: string; since: number }
}

/**
 * The agent this card is about. One, always — see the file header.
 *
 * The session figures below ride the identity rather than being read here
 * because the card is presentational and the shells already hold a session
 * snapshot (the sidebar) or an agent record (the tab). A component that fetched
 * its own would be a second source for facts the anchor is already drawing.
 */
export type ConversationPeekAgent = {
  /** The terminal session this card is about — what the shells key on. */
  sessionId: string
  /** The agent behind the session, when there is one. */
  agentId?: string | null
  /** Runtime id; null when unknown. */
  cli: AgentCli | null
  /** Launch model id; null → the CLI's own default. */
  model: string | null
  /** Subagents out right now. Replaces the corner's word while it is above zero. */
  activeSubagents: number
  /**
   * The pull requests this conversation has opened, newest first — main's own
   * union of the ones on its branch and the ones it opened itself in any
   * repository (epic `pull-request-marks`, decision 10). Empty draws nothing.
   *
   * An OUTCOME of the conversation rather than a place: the branch line says
   * where the work is being done, this says where it went, and only this card
   * knows which conversation sent it there.
   */
  pullRequests: BranchPullRequest[]
  /**
   * Context-window usage, or null when nothing has reported any. Null draws no
   * context line at all: 0% and "this runtime reports none" are different
   * facts, and a line at 0% would claim the first.
   */
  contextUsage: SessionContextUsage | null
}

/** The machine a chat runs on when it is not this computer. */
export type ConversationPeekMachine = {
  /** "WSL: Ubuntu", or an SSH machine's or a paired machine's name. */
  label: string
  kind: 'wsl' | 'remote'
}

/**
 * Where the chat runs. Every field is independently optional — a chat in a
 * plain folder has no branch, and a line with nothing to say is not drawn.
 */
export type ConversationPeekPlace = {
  /** Null on this computer — local is the unmarked default. */
  machine: ConversationPeekMachine | null
  branch: string | null
}

export type ConversationPeekIdentity = {
  /** The chat's name — the tab's or the row's title. */
  name: string
  /**
   * Where it runs. Absent on the TAB's card: a tab sits inside the chat's own
   * window, whose header already says the machine and branch.
   */
  place?: ConversationPeekPlace | null
  /** The corner's state; null to omit it entirely. */
  status: ConversationPeekStatus | null
  /** The one agent whose conversation this card shows. */
  agent: ConversationPeekAgent
}

/**
 * The corner: the sidebar's own working mark and one word, and nothing else
 * added for a state (mockup frame 2).
 *
 * Never a `StatusDot` — that was the shipped card's mistake and it is the whole
 * point of this revision. The row says "working" with three staggered dots; the
 * card saying it with a pulsing green disc six pixels away made two vocabularies
 * for one fact, and the reader has to learn both.
 *
 * Subagents REPLACE the word rather than adding to it: "2 running" is strictly
 * more than "Working" — it says the agent is working AND what it is doing — so
 * a card that said both would be spending a line on the weaker half.
 */
function LiveCorner({
  status,
  activeSubagents,
  seed,
}: {
  status: ConversationPeekStatus
  activeSubagents: number
  seed?: string
}) {
  const working = status.kind === 'working'
  const label = working && activeSubagents > 0 ? `${activeSubagents} running` : status.label
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-meta ${
        status.kind === 'idle' ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-muted)]'
      }`}
    >
      {working ? (
        <>
          {/* The mark carries the accessible name and the word beside it is
              decorative, so the state is announced once rather than twice.
              (`WorkingMark` is `role="img"` with a label by construction —
              it is the sidebar's mark, and this is the same mark, seeded the
              same way so the card moves like the row it opened from.) */}
          <WorkingMark label={label} seed={seed} />
          <span aria-hidden="true">{label}</span>
        </>
      ) : (
        <span>{status.aged ? <LabelWithAge label={label} aged={status.aged} /> : label}</span>
      )}
    </span>
  )
}

/**
 * "Paused · 2m" once a minute has passed, else the plain label, on a clock of
 * its own. An age with no label of its own (a chat's) is the time alone: "2m".
 */
function LabelWithAge({ label, aged }: { label: string; aged: { label: string; since: number } }) {
  const now = useRelativeNow()
  const age = formatRelativeMs(aged.since, now)
  return <>{age ? (aged.label ? `${aged.label} · ${age}` : age) : label}</>
}

/**
 * A token count in the card's terse voice: `850`, `4.5k`, `84k`, `1.2M`. One
 * decimal only where a whole number would hide a real difference (under ten
 * thousand, and in millions), and never a trailing `.0`.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/u, '')
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 10_000) return `${trim(tokens / 1_000)}k`
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`
  return `${trim(tokens / 1_000_000)}M`
}

/**
 * The context line's words: "84k / 200k tokens · 42%", or "42% of context
 * used" when the runtime has not said how big its window is.
 *
 * The used count is DERIVED from the whole percent the session reports, so it
 * is good to one percent of the window — which is all a glance asks of it, and
 * is why it is never shown finer than `formatTokenCount` rounds.
 */
export function contextUsageText(usage: SessionContextUsage): string {
  const percentage = Math.max(0, Math.min(100, Math.round(usage.usedPercentage)))
  const size = usage.contextWindowSize
  if (!size || !Number.isFinite(size) || size <= 0) return `${percentage}% of context used`
  const used = (size * percentage) / 100
  return `${formatTokenCount(used)} / ${formatTokenCount(size)} tokens · ${percentage}%`
}

const MACHINE_GLYPH = {
  wsl: WslMachineGlyph,
  remote: RemoteMachineGlyph,
} as const

/**
 * One fact: a glyph in a fixed gutter and a value that truncates. The glyph is
 * decorative and the label is the line's accessible name, so a screen reader
 * hears "Branch: main" rather than "main" on its own.
 */
function Fact({
  glyph,
  label,
  children,
  mono = false,
}: {
  glyph: React.ReactNode
  label: string
  children: string
  mono?: boolean
}) {
  return (
    <li className="flex min-w-0 items-center gap-2" aria-label={`${label}: ${children}`}>
      <span className="flex w-3.5 shrink-0 justify-center text-[color:var(--text-subtle)]" aria-hidden="true">
        {glyph}
      </span>
      <TruncatedText
        as="span"
        text={children}
        className={`min-w-0 flex-1 text-meta text-[color:var(--text-muted)] ${mono ? 'font-mono' : ''}`}
      />
    </li>
  )
}

/**
 * The card: a header that names the chat and says what it is doing, then one
 * line per fact the shells could answer. A fact nobody knows is not drawn —
 * an empty "Branch" line is the card describing its own absence.
 */
export function ConversationPeekCard({ identity, now }: { identity: ConversationPeekIdentity; now: number }) {
  const agent = identity.agent
  const place = identity.place ?? null
  const runtime = agent.cli ? labelForCliRuntime(agent.cli) : null
  // "claude-opus-5 · Claude Code", the model first because it is what differs
  // between two chats on the same runtime.
  const modelLine = [agent.model ?? (runtime ? 'Default model' : null), runtime].filter(Boolean).join(' · ')
  const MachineGlyph = place?.machine ? MACHINE_GLYPH[place.machine.kind] : null
  return (
    <>
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        {/* The name in full is what the row's own truncation tooltip used to
            show; this header takes that job, which is how the row keeps to one
            hover surface at a time. */}
        <TruncatedText
          as="span"
          text={identity.name}
          className="min-w-0 flex-1 text-heading font-semibold text-[color:var(--text-strong)]"
        />
        <PullRequestPeekMark pullRequests={agent.pullRequests} now={now} />
        {identity.status ? (
          <LiveCorner
            status={identity.status}
            activeSubagents={agent.activeSubagents}
            seed={agent.agentId ?? agent.sessionId ?? undefined}
          />
        ) : null}
      </div>

      <ul className="m-0 flex list-none flex-col gap-1 px-3 pb-2.5 pt-0.5">
        {place?.machine && MachineGlyph ? (
          <Fact label="Machine" glyph={<MachineGlyph className="icon-xs" />}>
            {place.machine.label}
          </Fact>
        ) : null}
        {place?.branch ? (
          <Fact label="Branch" glyph={<GitBranchGlyph className="icon-xs" />} mono>
            {place.branch}
          </Fact>
        ) : null}
        {modelLine ? (
          <Fact
            label="Model"
            glyph={agent.cli ? <CliIcon cli={agent.cli} className="icon-xs" /> : <span className="icon-xs" />}
          >
            {modelLine}
          </Fact>
        ) : null}
        {agent.contextUsage ? (
          <Fact label="Context" glyph={<ContextRing usedPercentage={agent.contextUsage.usedPercentage} decorative />}>
            {contextUsageText(agent.contextUsage)}
          </Fact>
        ) : null}
      </ul>
    </>
  )
}
