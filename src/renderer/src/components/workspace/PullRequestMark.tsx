import React from 'react'

import { PullRequestGlyph, SplitButton, Tooltip, IconButton, type SplitButtonItem } from '../ui'
import { formatRelativeMs, relativeFromNow } from '../../utils/relativeTime'
import {
  earlierPullRequests,
  groupPullRequests,
  primaryPullRequest,
  pullRequestStateLabel,
  pullRequestTone,
  PULL_REQUEST_TONE_VAR,
  type BranchPullRequest,
} from '../../../../shared/git/pull-request'

// The pull request mark a conversation wears, in the two places it is drawn:
// the sidebar's agent line and the conversation peek's head line (epic
// `pull-request-marks`, decisions 4–7; mockup
// `backlog/mockups/2026-09-09-pull-request-marks.html`, frames 2–4).
//
// ONE module for both, because the two surfaces have to agree about four things
// a reader would otherwise catch them disagreeing on: which pull request the
// mark is (`primaryPullRequest` — the most recent one still open, else the
// newest of all), what colour the state inks in (`pullRequestTone`), what the
// hover says, and what a screen reader is told. The tooltips READ differently —
// the line has no room for the pull request's title and the card has nothing
// else to say about it — but the words come from here either way, so the two
// cannot drift.
//
// NOTHING IS DRAWN FOR AN EMPTY LIST (decision 3). There is no "unknown" mark
// and no placeholder: a branch with no pull request, a lookup that has not run,
// and a lookup that failed all draw exactly what a plain terminal draws.
//
// Colour is a reinforcement, never the message: every state has its own shape
// (`PullRequestGlyph`) and every tooltip and accessible name says the state in
// words, so the mark survives grayscale and a screen reader.

/**
 * What a mark says, in the three registers the design asks for: the tooltip's
 * bolder first line, the lines under it, and the same content spoken.
 *
 * Strings, not nodes, so the wording is testable without a DOM — which is the
 * only way to hold a tooltip that is portalled on hover and therefore invisible
 * to the static-markup harness the sidebar and card suites use.
 */
export type PullRequestCopy = {
  title: string
  lines: string[]
  ariaLabel: string
}

/**
 * More than one repository in the list (epic decision 10). An agent that runs
 * `cd ../website && gh pr create` opens a pull request somewhere its session
 * does not sit, so a conversation's marks are not always all in one repo — and
 * when they are not, every LINE of a tooltip and every menu row has to say
 * which repository it is talking about. When they are, naming the repo on every
 * line would be noise on the case that is almost always true.
 *
 * The mark itself never names a repository at any time: it is one glyph.
 */
export function pullRequestsSpanRepositories(list: readonly BranchPullRequest[]): boolean {
  return new Set(list.map((pr) => pr.repoKey)).size > 1
}

/** "#418", or "multicode-website #12" once the list spans repositories. */
function writtenNumber(pr: BranchPullRequest, spans: boolean): string {
  return spans ? `${pr.repoName} #${pr.number}` : `#${pr.number}`
}

/**
 * The same identity spoken. A screen reader gets "pull request 418", never
 * "hash four one eight", and the repository is named with a preposition rather
 * than with the middle dot the visible line uses — a spoken label is a
 * sentence, and the visible line is a label.
 */
function spokenNumber(pr: BranchPullRequest, spans: boolean): string {
  return spans
    ? `Pull request ${pr.number} in ${pr.repoName}`
    : `Pull request ${pr.number}`
}

/**
 * The sidebar line's mark (mockup frame 4): the number and the state, then what
 * clicking does, then one line per earlier pull request — newest first, never
 * dropped, because the line has no chevron and this tooltip is the only place
 * the rest of the record is visible from the sidebar (decision 6).
 *
 * Null when there is no pull request, which is the caller's signal to draw
 * nothing at all.
 */
export function sidebarMarkCopy(list: readonly BranchPullRequest[]): PullRequestCopy | null {
  const primary = primaryPullRequest(list)
  if (!primary) return null
  const spans = pullRequestsSpanRepositories(list)
  const earlier = earlierPullRequests(list)
  const stateOf = (pr: BranchPullRequest) => pullRequestStateLabel(pr)
  return {
    title: spans
      ? `${writtenNumber(primary, spans)} · ${stateOf(primary)}`
      : `Pull request ${writtenNumber(primary, spans)} ${stateOf(primary)}`,
    lines: [
      'Open it on GitHub',
      ...earlier.map((pr) =>
        spans
          ? `Earlier: ${writtenNumber(pr, spans)} · ${stateOf(pr)}`
          : `Earlier: ${writtenNumber(pr, spans)} ${stateOf(pr)}`,
      ),
    ],
    // The spoken name carries the state and the earlier pull requests too: the
    // tooltip is portalled on hover and a person who cannot summon it must lose
    // nothing (design-system/components/tooltip → Accessibility).
    ariaLabel: [
      `${spokenNumber(primary, spans)}, ${stateOf(primary)}.`,
      ...earlier.map((pr) => `Earlier: ${spokenNumber(pr, spans).toLowerCase()}, ${stateOf(pr)}.`),
      'Open it on GitHub',
    ].join(' '),
  }
}

/**
 * The peek head's mark (mockup frame 3). The card has room the line does not,
 * so the pull request's own TITLE leads and the identity line carries the
 * number, the state and how long ago it was opened.
 */
export function peekMarkCopy(list: readonly BranchPullRequest[], now: number): PullRequestCopy | null {
  const primary = primaryPullRequest(list)
  if (!primary) return null
  const spans = pullRequestsSpanRepositories(list)
  const state = pullRequestStateLabel(primary)
  const opened = relativeFromNow(primary.openedAt, now)
  const identity = spans
    ? writtenNumber(primary, spans)
    : `Pull request ${writtenNumber(primary, spans)}`
  // A pull request the hooks CAPTURED has no title until GitHub answers — and
  // never gets one if `gh` cannot reach it. Untitled, the identity moves up
  // into the title line, because a bold empty line over "Pull request #418 ·
  // open · 12 minutes ago" is a tooltip whose first line is missing, and a
  // spoken "Pull request 418, open: . Open it on GitHub" is a sentence with a
  // hole in it. The number is a name; the title is an elaboration of it, and an
  // elaboration that is not there is simply left out.
  const titled = primary.title.trim().length > 0
  return {
    title: titled ? primary.title : identity,
    lines: [
      // Identity only ONCE: it is the title line above when there is no title,
      // and this line then carries what is left to say about it.
      (titled ? [identity, state, opened] : [state, opened])
        .filter((part) => part.length > 0)
        .join(' · '),
      'Open it on GitHub',
    ],
    ariaLabel: titled
      ? `${spokenNumber(primary, spans)}, ${state}: ${primary.title}. Open it on GitHub`
      : `${spokenNumber(primary, spans)}, ${state}. Open it on GitHub`,
  }
}

/** One row of the peek's menu — everything it draws and everything it says. */
export type PullRequestMenuRow = {
  url: string
  /** "#409", or "multicode-website #12" when the conversation spans repositories. */
  number: string
  title: string
  /** The terse age in the hint slot ("1d"); empty under a minute, and then omitted. */
  age: string
  state: BranchPullRequest['state']
  ariaLabel: string
}

/** A group of the peek's menu: the label with its count, and its rows. */
export type PullRequestMenuGroup = {
  id: 'open' | 'merged' | 'closed'
  label: string
  rows: PullRequestMenuRow[]
}

/**
 * The menu behind the chevron (decision 6): every pull request the conversation
 * has made, grouped Open / Merged / Closed, newest first within each, with the
 * empty groups omitted rather than shown as a heading over nothing.
 *
 * The grouping and the ordering are the shared module's (`groupPullRequests`),
 * so this cannot disagree with the mark about which one is newest.
 */
export function pullRequestMenuGroups(
  list: readonly BranchPullRequest[],
  now: number,
): PullRequestMenuGroup[] {
  const spans = pullRequestsSpanRepositories(list)
  const grouped = groupPullRequests(list)
  const rowOf = (pr: BranchPullRequest): PullRequestMenuRow => {
    // Same rule as the tooltip above: a captured pull request has no title
    // until GitHub answers, and the row is then the number alone rather than a
    // number followed by a gap. Spoken, the colon clause goes with it.
    const titled = pr.title.trim().length > 0
    return {
      url: pr.url,
      number: writtenNumber(pr, spans),
      title: titled ? pr.title : '',
      age: formatRelativeMs(pr.openedAt, now),
      state: pr.state,
      ariaLabel: titled
        ? `${spokenNumber(pr, spans)}, ${pullRequestStateLabel(pr)}: ${pr.title}. Open it on GitHub`
        : `${spokenNumber(pr, spans)}, ${pullRequestStateLabel(pr)}. Open it on GitHub`,
    }
  }
  return (
    [
      { id: 'open', label: 'Open', rows: grouped.open },
      { id: 'merged', label: 'Merged', rows: grouped.merged },
      { id: 'closed', label: 'Closed', rows: grouped.closed },
    ] as const
  )
    .filter((group) => group.rows.length > 0)
    .map((group) => ({
      id: group.id,
      label: `${group.label} · ${group.rows.length}`,
      rows: group.rows.map(rowOf),
    }))
}

/**
 * How long an ask holds before the same conversation may be asked about again.
 *
 * Matched to the record's own "re-read a reading older than ~60s on hover"
 * (epic decision 9): this side must not be the thing that makes that
 * unreachable. It is a FLOOR on how often this window asks, not a schedule —
 * nothing here polls, and an ask only happens under a pointer.
 */
const LOOKUP_ASK_TTL_MS = 60_000

/**
 * When this window last asked main about a conversation, keyed by session AND
 * branch.
 *
 * It was a permanent one-shot `Set` of session ids, and that burned the only
 * ask the app would ever make before main could act on it. Three ways, all of
 * them the common case:
 *
 * - the key was the session alone, while the ask is really about a BRANCH. A
 *   line's branch is filled from the launch intent long before the observed
 *   checkout resolves, and main only acts once it has resolved — so the very
 *   first hover, in the first second of a chat, spent the one ask on a question
 *   main could not answer, and no later hover asked again.
 * - a `gh` read that never settled (no auth, no network, a repo `gh` cannot
 *   see) was also never re-asked.
 * - and the branch CHANGING — the agent moving to its worktree, a rebase onto a
 *   new branch — asked nothing, because the session id had not changed.
 *
 * Keyed by session + branch with a TTL, all three re-ask on the next hover.
 * There is no timer and no poll: entries are written by hovers and read by
 * hovers, so a window nobody is pointing at asks nothing at all.
 */
const askedAt = new Map<string, number>()

function askKey(sessionId: string, branch: string | null): string {
  // A newline, which no branch name and no session id can contain, so
  // "a" + "b/c" and "a\nb" + "c" cannot collide.
  return `${sessionId}\n${branch ?? ''}`
}

/**
 * Whether pointing at this line should ask main to look its branch up (epic
 * decision 8a):
 *
 * - an AGENT line, because a shell has no conversation and a remote pane's
 *   checkout is on another machine's disk;
 * - with a BRANCH, because the lookup is `gh pr list --head <branch>` and there
 *   is nothing to ask about without one.
 *
 * A line that already WEARS a mark asks too, which it used to be barred from.
 * The bar made decision 9's "refresh on hover when the reading is older than
 * ~60s" unreachable — the only lines with a reading to refresh were exactly the
 * lines this refused to ask about — and it is not what keeps this from becoming
 * a poller: the TTL above does, and main holds the lookup behind its own hold
 * and coalesces the refreshes it accepts.
 */
export function shouldLookUpPullRequests(line: {
  kind: 'agent' | 'shell' | 'remote'
  branch: string | null
}): boolean {
  return line.kind === 'agent' && line.branch !== null
}

/**
 * Ask main to look this conversation's pull requests up — the ONE path both
 * anchors use, so the sidebar line and the agent tab cannot ask at two
 * different rates or key their coalescing two different ways.
 *
 * `now` is a test seam. Callers are event handlers and pass nothing.
 */
export function refreshPullRequestsForLine(
  sessionId: string,
  branch: string | null,
  now: number = Date.now(),
): void {
  if (!sessionId) return
  const key = askKey(sessionId, branch)
  const last = askedAt.get(key)
  if (last !== undefined && now - last < LOOKUP_ASK_TTL_MS) return
  // Recorded BEFORE the call, not in its `then`: a mousemove storm is
  // synchronous and would otherwise fire an IPC per event while the first
  // promise was still in flight.
  askedAt.set(key, now)
  const answer = window.api?.refreshPullRequestsForSession?.(sessionId) as unknown
  void Promise.resolve(answer).then(
    (accepted) => {
      // Main may answer whether it actually took the ask (it can hold one back
      // while the observed checkout is unresolved). A refusal is not an ask, so
      // it must not spend the minute — anything else, including today's
      // `Promise<void>`, is one that was taken.
      if (accepted === false) askedAt.delete(key)
    },
    // A rejected call reached nobody. Forget it, or a main process that was
    // restarting during the hover would cost this window a silent minute.
    () => askedAt.delete(key),
  )
}

/** Test seam: forget what has been asked, so a case can assert the coalescing. */
export function resetPullRequestRefreshes(): void {
  askedAt.clear()
}

function openPullRequest(url: string): void {
  void window.api?.openExternal?.(url)
}

/**
 * The tooltip body: the identifier in the title's weight, then the description
 * (design-system/components/tooltip → Anatomy). Block spans rather than a
 * newline-joined string, so the first line can carry the title treatment.
 */
function MarkTooltip({ copy }: { copy: PullRequestCopy }) {
  return (
    <>
      <span className="block font-medium text-[color:var(--text-strong)]">{copy.title}</span>
      {copy.lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </>
  )
}

/**
 * The SIDEBAR line's mark — right after the branch chip and before the ±lines,
 * because it belongs to the branch: "this branch, this much changed, and here
 * is where it went."
 *
 * The glyph is `icon-xs` and the control around it is the kit's smallest icon
 * step, whose transparent overlay pads a 16px drawing out to the 24px hit floor
 * without growing the 20px line it sits on. It is a real control and not an
 * anchor: nothing here navigates inside the app, and the click hands the URL to
 * the app's one external-open path.
 *
 * The ink is the state's tone, inline from the shared map — the idiom every
 * other tone-driven mark in the app already uses (`runPullRequestChipInk`,
 * `StatusDot`) — so no per-state class literal exists here to fall out of step
 * with the map. Inline also outranks the kit's own ink at every state, which is
 * what keeps a merged mark violet under the pointer instead of reverting to the
 * button's neutral hover ink.
 */
export function PullRequestMark({
  pullRequests,
  dim = false,
}: {
  pullRequests: readonly BranchPullRequest[]
  /** The row is background: the mark recedes with the rest of its line. */
  dim?: boolean
}): JSX.Element | null {
  const primary = primaryPullRequest(pullRequests)
  const copy = sidebarMarkCopy(pullRequests)
  if (!primary || !copy) return null
  return (
    <Tooltip content={<MarkTooltip copy={copy} />} multiline wrapperClassName="flex shrink-0 items-center">
      <IconButton
        size="3xs"
        aria-label={copy.ariaLabel}
        data-pull-request-mark={primary.url}
        className={`shrink-0 ${dim ? 'opacity-60' : ''}`}
        style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(primary.state)] }}
        onClick={(event) => {
          // The row underneath is a click target: without this, opening the
          // pull request would also select the chat.
          event.stopPropagation()
          openPullRequest(primary.url)
        }}
      >
        <PullRequestGlyph state={primary.state} className="icon-xs" />
      </IconButton>
    </Tooltip>
  )
}

/** The mark's own drawing on the peek: the glyph and the number, in the tone. */
function PeekMarkFace({ pr }: { pr: BranchPullRequest }) {
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-micro tabular-nums"
      style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(pr.state)] }}
    >
      <PullRequestGlyph state={pr.state} className="icon-xs" />#{pr.number}
    </span>
  )
}

/**
 * The CONVERSATION PEEK's mark — on the card's head line, right of the context
 * ring and left of the live corner (mockup frame 3).
 *
 * One pull request is a link: the glyph, the number, and a tooltip carrying the
 * pull request's title. Two or more grow the split control — the same mark on
 * the primary half, and a chevron opening the whole record, grouped by state.
 * Choosing a row opens it and does NOT re-point the primary, which is the one
 * place this deliberately departs from the split button's own usage note: the
 * primary here is a RULE (the most recent open one, decision 5), not a memory
 * of what you last picked, so it moves when GitHub moves and never because of a
 * click.
 *
 * Clicks are already sealed by the card's shell (`PointerPopover` stops click,
 * mousedown and keydown at its surface, because a portal is still a React child
 * of its opener), and the link stops its own as well so the mark is correct
 * wherever the card is hosted.
 */
export function PullRequestPeekMark({
  pullRequests,
  now,
}: {
  pullRequests: readonly BranchPullRequest[]
  now: number
}): JSX.Element | null {
  const primary = primaryPullRequest(pullRequests)
  const copy = peekMarkCopy(pullRequests, now)
  if (!primary || !copy) return null
  const groups = pullRequestMenuGroups(pullRequests, now)
  const items: SplitButtonItem[] = groups.flatMap((group) =>
    group.rows.map((row) => ({
      id: row.url,
      group: group.label,
      label: (
        <>
          <span className="mr-1.5 font-mono tabular-nums">{row.number}</span>
          {row.title}
        </>
      ),
      ariaLabel: row.ariaLabel,
      icon: (
        <span style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(row.state)] }}>
          <PullRequestGlyph state={row.state} className="icon-xs" />
        </span>
      ),
      hint: row.age || undefined,
      onSelect: () => openPullRequest(row.url),
    })),
  )
  return (
    <Tooltip
      content={<MarkTooltip copy={copy} />}
      multiline
      // The card is a menu-tier surface, so a tooltip opened from inside it at
      // the default tier paints UNDER the card the moment the card is near a
      // viewport edge and the tooltip flips back onto it.
      layer="menu"
      wrapperClassName="flex shrink-0 items-center"
    >
      {/* A plain wrapper, because `Tooltip` wires its handlers onto the element
          it is given and `SplitButton` takes a closed set of props: handed them
          directly they would be dropped and the tooltip would never open. The
          hover and the focus both still reach this span — focus events bubble.

          `Tooltip` also clones its child with `aria-describedby`, which lands on
          THIS span and is therefore never announced. That is deliberate and
          costs nothing: `primaryAriaLabel` below is the whole of what the
          tooltip says (`copy.ariaLabel` — the same number, the same state word,
          the same title, the same "Open it on GitHub"), so a description
          pointing at those words as well would only make a screen reader say
          them twice. The tooltip is the POINTER's copy of a label the control
          already carries. */}
      <span className="flex items-center">
        <SplitButton
          quiet
          layer="menu"
          label={<PeekMarkFace pr={primary} />}
          primaryAriaLabel={copy.ariaLabel}
          // On the primary half, which is the control, exactly as the sidebar
          // mark's marker is on its button. One pull request or several, the
          // mark is found the same way and pressed in the same place.
          primaryData={{ name: 'data-pull-request-mark', value: primary.url }}
          menuAriaLabel={`All pull requests from this conversation, ${pullRequests.length}`}
          // One target draws the primary half alone — the group's own chrome,
          // the 24px hit floor, the hover fill, and no chevron over a menu with
          // one row in it (`SplitButton`'s own rule). The solo arm used to be a
          // text link here, which made the same mark a ~15px target with one
          // pull request and a 24px one with two.
          items={items}
          onPrimary={() => openPullRequest(primary.url)}
        />
      </span>
    </Tooltip>
  )
}
