import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ConversationPeekCard,
  elideSessionId,
  messageTooltipParts,
  splitChangedPath,
  type ConversationPeekIdentity,
} from './ConversationPeekCard'
import type { SessionFileChange } from '../../../../shared/electron-api'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import type { ConversationPeek, ConversationPeekMessage } from '../../../../shared/conversation-peek'

// QA for the conversation peek's card — the presentational half of the hover
// surface both anchors share. What matters here is what the card SAYS: which of
// the four runtime shapes it is in, what it does with one message versus forty,
// that the files and the images are real controls, and that the things the
// design cut (a footer, a keyboard hint, a message count, the agent list, the two
// section headings) stayed cut.
//
// The kit's Tooltip runs a useLayoutEffect the static renderer no-ops; React
// says so once per render and that warning is the one line of noise filtered.
const consoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return
  consoleError(...args)
}

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const AGENT: ConversationPeekIdentity['agent'] = {
  sessionId: 'e4b3d55c-d78c-4687',
  cli: 'claude-code',
  model: 'claude-opus-5',
  fileChanges: [],
  pullRequests: [],
  activeSubagents: 0,
  contextUsage: null,
}

const IDENTITY: ConversationPeekIdentity = {
  name: 'Deara Shea',
  status: { kind: 'working', label: 'Working' },
  agent: AGENT,
}

const change = (over: Partial<SessionFileChange> = {}): SessionFileChange => ({
  path: '/repo/src/main/automations/run/scheduler.ts',
  additions: 14,
  deletions: 6,
  edits: 2,
  lastEditedAt: NOW - MINUTE,
  ...over,
})

const message = (over: Partial<ConversationPeekMessage> = {}): ConversationPeekMessage => ({
  id: 'm1',
  text: 'Right now we store the first five or six words from the prompt as the title.',
  at: NOW - 3 * HOUR,
  attachments: [],
  truncatedChars: 0,
  ...over,
})

const peek = (over: Partial<ConversationPeek> = {}): ConversationPeek => ({
  sessionId: AGENT.sessionId,
  source: 'transcript',
  first: message(),
  since: [],
  images: [],
  ...over,
})

function card(
  over: {
    identity?: Partial<ConversationPeekIdentity>
    agent?: Partial<ConversationPeekIdentity['agent']>
    peek?: ConversationPeek | null
    loading?: boolean
    copied?: boolean
    onOpenAttachment?: ((attachmentId: string) => void) | undefined
    onOpenDiff?: ((path: string | null) => void) | undefined
  } = {},
): string {
  return renderToStaticMarkup(
    <ConversationPeekCard
      identity={{
        ...IDENTITY,
        ...(over.identity ?? {}),
        agent: { ...AGENT, ...(over.agent ?? {}) },
      }}
      peek={over.peek === undefined ? peek() : over.peek}
      loading={over.loading ?? false}
      now={NOW}
      copied={over.copied ?? false}
      onCopySession={() => {}}
      onOpenAttachment={'onOpenAttachment' in over ? over.onOpenAttachment : () => {}}
      onOpenDiff={'onOpenDiff' in over ? over.onOpenDiff : () => {}}
    />,
  )
}

// --- Identity: what survived the cull, and what did not --------------------
run('the card keeps the model and the session id, and drops the four rows that repeated the window', () => {
  const markup = card()
  assert.match(markup, /Deara Shea/, 'names the chat')
  assert.match(markup, /claude-opus-5/, 'shows the exact model')
  assert.match(markup, /e4b3d55c…4687/, 'shows the session id, elided in the middle')
  assert.match(markup, /aria-label="Copy session id"/, 'the session id keeps its copy button')
  assert.match(markup, /Working/, 'shows the live status')
  for (const gone of ['No role', 'Role', 'Runtime', 'Checkout', 'Main checkout']) {
    assert.equal(markup.includes(`>${gone}<`), false, `the ${gone} row is gone`)
  }
})

run('a model the agent never chose reads as the CLI default, never blank', () => {
  const markup = card({ agent: { model: null } })
  assert.match(markup, /CLI default/, 'null model falls back to "CLI default"')
  assert.equal(markup.includes('claude-opus-5'), false, 'no stale model string when unset')
})

// --- One agent per card: the agent list is gone (mockup frame 3) -----------
run('there is no agent list, no disc and no selector — the sidebar already lays the agents out', () => {
  const markup = card()
  assert.equal(/role="radiogroup"/.test(markup), false, 'no selector')
  assert.equal(/role="radio"/.test(markup), false, 'no discs')
  assert.equal(markup.includes('Terminals in this chat'), false, 'and nothing to label')
  assert.equal(markup.includes('agents'), false, 'the header never counts terminals')
})

// --- The corner: the sidebar's mark and one word (mockup frame 2) ----------
run('a working agent wears the sidebar’s own dots and the word, never a status dot', () => {
  const markup = card()
  assert.match(markup, /agent-working-dots/, 'the sidebar’s mark, so the row and the card agree')
  assert.match(markup, />Working</, 'and the word beside it')
  assert.equal(
    /status-dot|animate-pulse/.test(markup),
    false,
    'a pulsing disc six pixels from the dots would be two vocabularies for one fact',
  )
})

run('subagents replace the word rather than being added beside it', () => {
  const markup = card({ agent: { activeSubagents: 2 } })
  assert.match(markup, />2 running</, 'says what it is doing, not merely that it is doing something')
  assert.equal(markup.includes('>Working<'), false, 'and does not say both')
  assert.match(markup, /aria-label="2 running"/, 'the state travels in words, on the mark')
  assert.match(markup, /agent-working-dots/, 'the dots stay: it is still working')
})

run('an idle agent drops the dots and takes the quieter ink', () => {
  const idle = card({ identity: { status: { kind: 'idle', label: 'Idle · 12m' } } })
  assert.match(idle, />Idle · 12m</, 'says how long, not a bare "Idle"')
  assert.equal(idle.includes('agent-working-dots'), false, 'nothing is running, so nothing moves')
  // Read the CORNER's own class attribute, not the whole card: `text.subtle`
  // is on half the markup — the ages, the file glyph, the notes — so a match
  // anywhere would pass whatever ink the corner actually took.
  const cornerInk = (markup: string): string =>
    markup.match(/<span class="(ml-auto[^"]*)"/)?.[1] ?? ''
  assert.match(cornerInk(idle), /--text-subtle/, 'idle recedes')
  assert.match(
    cornerInk(card({ identity: { status: { kind: 'attention', label: 'Waiting' } } })),
    /--text-muted/,
    'a chat that wants you does not',
  )
})

run('waiting and failed keep their labels and lose their dots', () => {
  for (const label of ['Waiting', 'Failed']) {
    const markup = card({ identity: { status: { kind: 'attention', label } } })
    assert.match(markup, new RegExp(`>${label}<`), `${label} still says so`)
    assert.equal(markup.includes('agent-working-dots'), false, `${label} is not motion`)
  }
})

run('a subagent count is ignored unless the agent is actually working', () => {
  const markup = card({
    identity: { status: { kind: 'idle', label: 'Idle · 3m' } },
    agent: { activeSubagents: 4 },
  })
  assert.match(markup, />Idle · 3m</, 'a stale count must not claim work that stopped')
  assert.equal(markup.includes('4 running'), false)
})

run('a card with no status at all draws no corner', () => {
  const markup = card({ identity: { status: null } })
  assert.equal(markup.includes('agent-working-dots'), false)
  assert.equal(markup.includes('Working'), false)
})

// --- The context ring (mockup frames 2 and 4) ------------------------------
run('the ring is drawn beside the title, with the percentage in words', () => {
  const markup = card({ agent: { contextUsage: { usedPercentage: 38, at: NOW } } })
  assert.match(markup, /aria-label="Context 38% used"/, 'the accessible name is the value')
  assert.match(markup, /stroke-dasharray="14\.33 37\.70"/, 'and the sweep is that same value')
  assert.match(markup, /var\(--accent-primary\)/, 'accent below the threshold')
})

run('past eighty per cent the fill turns the sidebar’s attention gold', () => {
  const markup = card({ agent: { contextUsage: { usedPercentage: 84, at: NOW } } })
  assert.match(markup, /aria-label="Context 84% used"/)
  assert.match(markup, /var\(--tone-warn\)/, 'a compaction is coming, which is worth a glance')
})

run('nothing reported means no ring — not a ring at zero', () => {
  const markup = card()
  assert.equal(markup.includes('Context '), false, 'a ring at 0% and a ring for "unknown" are the same picture')
})

// --- The pull request on the head line (pull-request-marks, frame 3) -------
//
// A git fact is admitted to this card because it is an OUTCOME of the
// conversation — like the changed files below, and unlike the branch and the
// checkout, which say where the agent is standing and were cut for repeating
// the window. What the words say is held in `PullRequestMark.test.tsx`; what is
// held here is that the head carries it, in the right place, in the right shape.
const pullRequest = (over: Partial<BranchPullRequest> & { number: number }): BranchPullRequest => ({
  url: `https://github.com/acme/multicode/pull/${over.number}`,
  repoKey: 'github.com/acme/multicode',
  repoName: 'multicode',
  title: `Pull request ${over.number}`,
  state: 'open',
  isDraft: false,
  openedAt: NOW - 12 * MINUTE,
  stateAt: NOW,
  ...over,
})

run('the head reads CLI mark · title · ring · pull request · live corner, in that order', () => {
  const markup = card({
    agent: {
      contextUsage: { usedPercentage: 38, at: NOW },
      pullRequests: [pullRequest({ number: 418, title: 'Extensions icon carries its unread count' })],
    },
  })
  const at = (needle: string) => {
    const index = markup.indexOf(needle)
    assert.ok(index >= 0, `${needle} is on the card`)
    return index
  }
  assert.ok(at('Deara Shea') < at('Context 38% used'), 'the title comes before the ring')
  assert.ok(at('Context 38% used') < at('data-pull-request-mark'), 'the ring before the pull request')
  assert.ok(at('data-pull-request-mark') < at('Working'), 'and the live corner last')
  assert.match(
    markup,
    /aria-label="Pull request 418, open: Extensions icon carries its unread count\. Open it on GitHub"/,
  )
})

run('the title is still the only thing on the head that yields width', () => {
  const markup = card({ agent: { pullRequests: [pullRequest({ number: 418 })] } })
  assert.match(markup, /min-w-0 flex-1 truncate/, 'the title keeps its ellipsis and its flex')
  const markIndex = markup.indexOf('data-pull-request-mark')
  assert.ok(markIndex > 0, 'the mark is on the head')
  // The mark is a control GROUP now (the split button's primary half, alone
  // when there is one pull request), so what must not shrink is the group and
  // the tooltip wrapper around it, not the inner button.
  const beforeTheMark = markup.slice(0, markIndex)
  assert.match(
    beforeTheMark.slice(-400),
    /flex shrink-0 items-center/,
    'the mark sits in a slot that holds its width',
  )
})

run('a conversation that opened nothing draws no mark at all', () => {
  const markup = card()
  assert.equal(markup.includes('data-pull-request-mark'), false)
  assert.equal(markup.includes('Pull request'), false)
})

run('one pull request is a plain link; a second grows the chevron beside it', () => {
  const one = card({ agent: { pullRequests: [pullRequest({ number: 418 })] } })
  assert.equal(one.includes('aria-haspopup="menu"'), false, 'a one-row menu says nothing')

  const two = card({
    agent: {
      pullRequests: [
        pullRequest({ number: 421 }),
        pullRequest({ number: 411, state: 'merged', openedAt: NOW - 2 * HOUR }),
      ],
    },
  })
  assert.match(two, /aria-haspopup="menu"/, 'the split control appears at two')
  assert.match(two, /aria-expanded="false"/, 'and says whether its menu is up')
  assert.match(two, /aria-label="All pull requests from this conversation, 2"/)
  assert.match(two, /Pull request 421, open/, 'the primary is still the most recent open one')
})

// --- Files this agent changed (mockup frames 1 and 4) ----------------------
const FILES = [
  change({ path: '/repo/src/renderer/src/components/git/GitDiffPane.tsx', additions: 48, deletions: 12 }),
  change({ path: '/repo/src/renderer/src/components/git/gitDiffModel.ts', additions: 31, deletions: 4 }),
]

run('each changed file is a link that opens its diff, named by its whole path', () => {
  const markup = card({ agent: { fileChanges: FILES } })
  assert.match(
    markup,
    /aria-label="Open the diff for \/repo\/src\/renderer\/src\/components\/git\/GitDiffPane\.tsx"/,
    'the action and the path, because three files in a list can share a basename',
  )
  assert.match(markup, />GitDiffPane\.tsx</, 'the eye lands on the basename')
  assert.match(markup, /\/repo\/src\/renderer\/src\/components\/git/, 'with the folder behind it')
  assert.match(markup, /\+48/, 'and the lines added')
  assert.match(markup, /−12/, 'and removed, in the minus sign, not a hyphen')
  assert.match(markup, /aria-label="Files changed in this session"/, 'the list is named as a group')
})

run('the file list scrolls rather than growing the card', () => {
  const markup = card({ agent: { fileChanges: FILES } })
  assert.match(markup, /max-h-\[92px\]/, 'about five rows, then it scrolls')
})

run('past twenty files the rows are not drawn at all — one line opens the whole diff', () => {
  const many = Array.from({ length: 24 }, (_, index) =>
    change({ path: `/repo/src/file-${index}.ts` }))
  const markup = card({ agent: { fileChanges: many } })
  assert.match(markup, />24 files changed · open the diff</, 'says how many, and offers the diff')
  assert.equal(markup.includes('file-0.ts'), false, 'and lists none of them: a hover is a glance')
  assert.equal(markup.includes('Open the diff for'), false, 'no per-file links either')

  const twenty = Array.from({ length: 20 }, (_, index) =>
    change({ path: `/repo/src/file-${index}.ts` }))
  const atTheLimit = card({ agent: { fileChanges: twenty } })
  assert.match(atTheLimit, /Open the diff for \/repo\/src\/file-19\.ts/, 'twenty still lists')
  assert.equal(atTheLimit.includes('files changed · open the diff'), false)
})

run('an agent that has changed nothing draws no file list', () => {
  const markup = card()
  assert.equal(markup.includes('Files changed in this session'), false, 'no heading over an absence')
})

run('with no diff opener the rows render inert rather than lying', () => {
  const markup = card({ agent: { fileChanges: FILES }, onOpenDiff: undefined })
  assert.match(markup, />GitDiffPane\.tsx</, 'the file is still named')
  assert.match(markup, /disabled=""/, 'but nothing pretends to open it')
})

run('a path splits at either separator, so a Windows path is not one long basename', () => {
  assert.deepEqual(splitChangedPath('/repo/src/main/thing.ts'), {
    name: 'thing.ts',
    folder: '/repo/src/main',
  })
  assert.deepEqual(splitChangedPath('C:\\repo\\src\\thing.ts'), {
    name: 'thing.ts',
    folder: 'C:\\repo\\src',
  })
  assert.deepEqual(splitChangedPath('thing.ts'), { name: 'thing.ts', folder: '' })
})

// --- Every image in the chat, in one strip (mockup frame 3) ----------------
const image = (index: number) => ({
  kind: 'image' as const,
  id: `img${index}`,
  label: `shot-${index}.png`,
  thumbnailDataUrl: 'data:image/png;base64,AA',
})

run('the strip draws every image the conversation carries, whichever message it came from', () => {
  const markup = card({ peek: peek({ images: [image(0), image(1), image(2)] }) })
  assert.match(markup, /aria-label="Images in this conversation"/, 'named as a group')
  assert.match(markup, /<button[^>]*aria-label="Open shot-0\.png"/, 'a real control with a real name')
  assert.match(markup, /<button[^>]*aria-label="Open shot-2\.png"/, 'including the newest')
  assert.match(markup, /data:image\/png;base64,AA/, 'and the thumbnail it was given')
})

run('past six thumbnails the rest are counted, never wrapped onto a second row', () => {
  const markup = card({
    peek: peek({ images: Array.from({ length: 8 }, (_, index) => image(index)) }),
  })
  assert.match(markup, /\+2/, 'the remainder is counted')
  assert.equal(markup.includes('shot-7.png'), false, 'and the seventh thumbnail is not drawn')
})

run('a conversation with no images draws no strip', () => {
  assert.equal(card().includes('Images in this conversation'), false)
})

run('with no opener in the preload the thumbnails render inert rather than lying', () => {
  const markup = card({ onOpenAttachment: undefined, peek: peek({ images: [image(0)] }) })
  assert.match(markup, /shot-0\.png/, 'the image is still named')
  assert.match(markup, /disabled=""/, 'but nothing pretends to open it')
})

// --- One thread, first message first (mockup frame 1) ----------------------
run('the first message is row one of the thread, with its age — not a quote under a heading', () => {
  const markup = card({
    peek: peek({
      first: message({ text: 'The run stalls on the third task', at: NOW - 3 * HOUR }),
      since: [message({ id: 'm2', text: 'Ignore the migration for now', at: NOW - 40 * MINUTE })],
    }),
  })
  assert.match(markup, /The run stalls on the third task/, 'the message that started it')
  assert.match(markup, /Ignore the migration for now/, 'and everything since, in one list')
  assert.match(markup, />3h</, 'row one carries a relative age like every other row')
  assert.match(markup, />40m</)
  for (const heading of ['First message', 'Since then', 'First message since launch']) {
    assert.equal(markup.includes(heading), false, `the "${heading}" heading is gone`)
  }
  assert.equal((markup.match(/<ol/g) ?? []).length, 1, 'one list, not two')
  assert.equal((markup.match(/<li/g) ?? []).length, 2, 'and one row per message')
})

run('the newest row is the one that lifts, and it is the last', () => {
  const markup = card({
    peek: peek({
      first: message({ text: 'oldest' }),
      since: [message({ id: 'm2', text: 'newest', at: NOW - MINUTE })],
    }),
  })
  const rows = markup.split('<li').slice(1)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.includes('--text-strong'), false, 'the first message is not the newest')
  assert.match(rows[1]!, /--text-strong/, 'the last row is')
})

run('a chat with one message shows it as the only row', () => {
  const markup = card()
  assert.equal((markup.match(/<li/g) ?? []).length, 1)
})

run('a long thread is masked at its top edge so it is obvious there is more above', () => {
  const long = peek({
    since: Array.from({ length: 9 }, (_, index) =>
      message({ id: `m${index}`, text: `message ${index}`, at: NOW - (9 - index) * MINUTE }),
    ),
  })
  const markup = card({ peek: long })
  assert.match(markup, /conversation-peek-thread--faded/, 'the fade is on')
  assert.match(markup, /max-h-\[164px\]/, 'and the list scrolls rather than growing the card')

  const short = card({ peek: peek({ since: [message({ id: 'm2', text: 'one more' })] }) })
  assert.equal(short.includes('--faded'), false, 'a thread that fits is not faded')
})

run('a later message carries a count on its row, never a strip of thumbnails', () => {
  const markup = card({
    peek: peek({
      since: [
        message({
          id: 'm2',
          text: 'This is the card I mean —',
          attachments: [{ kind: 'image', id: 'a2', label: 'card.png' }],
        }),
      ],
    }),
  })
  assert.match(markup, /aria-label="1 attachment"/, 'the row counts what it carries')
  assert.equal(markup.includes('Open card.png'), false, 'and opens nothing from a one-line row')
})

// --- The four shapes a runtime can put the card in -------------------------
run('a live peek says, quietly, that its messages start at this app’s launch', () => {
  const markup = card({ peek: peek({ source: 'live' }) })
  assert.match(markup, /Since this app launched/, 'the shape is stated')
  assert.match(markup, /no transcript/, 'and why')
  assert.equal(/<h[1-6]/.test(markup), false, 'one small line, never a heading')
})

run('a transcript peek says nothing about where its messages came from', () => {
  assert.equal(card().includes('Since this app launched'), false, 'no note where none is needed')
})

run('a live peek with nothing yet says what it cannot see, rather than looking empty', () => {
  const markup = card({ peek: peek({ source: 'live', first: null }) })
  assert.match(markup, /Nothing sent since this app launched/, 'says what it is missing')
  assert.match(markup, /no transcript/, 'and why')
})

run('an identity-only peek says the runtime reports nothing, and still earns its place', () => {
  const markup = card({ peek: peek({ source: 'none', first: null }) })
  assert.match(markup, /doesn’t report its messages/, 'says which shape it is in')
  assert.match(markup, /claude-opus-5/, 'the model still stands')
  assert.match(markup, /e4b3d55c…4687/, 'and the session id')
})

run('a chat we hold no record of blames our records, not the runtime', () => {
  // The distinction this asserts is the one that made the `none` arm move to
  // last: `none` is a claim about the RUNTIME. Saying it for a chat main simply
  // has no state for — killed rather than quit, or parked past the sidecar TTL
  // — tells someone their Claude Code chat cannot report messages, which is
  // false and reads as unfixable.
  const markup = card({ peek: peek({ source: 'unknown', first: null }) })
  assert.match(markup, /No record of this chat/, 'says whose gap it is')
  assert.equal(markup.includes('doesn’t report its messages'), false, 'never a claim about the runtime')
  assert.match(markup, /claude-opus-5/, 'the identity still stands')
})

run('a chat nobody has spoken in says nothing at all', () => {
  // No prose for an empty chat: the composer under the card is the whole
  // story, and a line explaining that a chat with no messages has no messages
  // only adds furniture.
  const markup = card({ peek: peek({ first: null }) })
  assert.equal(markup.includes('No messages yet'), false, 'the never-prompted state stays quiet')
  assert.match(markup, /claude-opus-5/, 'the identity still stands')
})

run('an empty chat on a capable runtime is never told its runtime is broken', () => {
  for (const source of ['transcript', 'live'] as const) {
    const markup = card({ peek: peek({ source, first: null, since: [] }) })
    assert.equal(
      markup.includes('doesn’t report its messages'),
      false,
      `a ${source} peek with nothing yet is an empty chat, not a limited runtime`,
    )
  }
})

run('a peek that never arrived says the conversation is not readable, and keeps the identity', () => {
  const markup = card({ peek: null })
  assert.match(markup, /isn’t readable from here/)
  assert.match(markup, /claude-opus-5/)
})

run('a card still reading shows a skeleton, never a blank body', () => {
  const markup = card({ peek: null, loading: true })
  assert.match(markup, /aria-label="Reading the conversation"/)
  assert.match(markup, /Deara Shea/, 'the identity is on screen from the first frame')
})

// --- The message tooltip: cut at the cap, with the remainder counted -------
// The tooltip is closed at rest and renders nothing, so this reads the decision
// rather than the markup: what the row would say if you hovered it.
run('a message that fits is shown whole, with nothing appended', () => {
  const parts = messageTooltipParts(message({ text: 'Use the design system for this' }))
  assert.equal(parts.text, 'Use the design system for this', 'verbatim')
  assert.equal(parts.cut, null, 'and no cut line on a message that was not cut')
})

run('a message longer than the cap is cut, with the remainder counted', () => {
  const parts = messageTooltipParts(
    message({ text: 'Here is the whole of section 6 for context', truncatedChars: 2140 }),
  )
  assert.match(parts.text, /section 6 for context…/, 'marks the cut')
  assert.equal(parts.cut, '+ 2,140 characters', 'and says how much was left behind')
})

run('an ellipsis main already added is not doubled', () => {
  const parts = messageTooltipParts(message({ text: 'and then…', truncatedChars: 12 }))
  assert.equal(parts.text, 'and then…', 'one ellipsis, whoever put it there')
})

run('the thread row still renders its trigger, and the row is not itself a control', () => {
  const markup = card({
    peek: peek({ since: [message({ id: 'm2', text: 'Drop the role row from the tab card' })] }),
  })
  assert.match(markup, /Drop the role row from the tab card/, 'the one line the row shows')
  assert.equal(/<li[^>]*>\s*<button/.test(markup), false, 'a thread row is not a button — it is a hover target')
})

run('a row the wire cut is a tab stop, so the rest is reachable without a pointer', () => {
  const markup = card({
    peek: peek({ since: [message({ id: 'm2', text: 'a very long thing', truncatedChars: 900 })] }),
  })
  assert.match(markup, /tabindex="0"/, 'both paths: hover and focus')
})

// --- Unknown timestamps say nothing, never a confident wrong age -----------
run('a message main could not date shows no age at all', () => {
  const markup = card({
    peek: peek({
      first: message({ at: 0 }),
      since: [message({ id: 'm2', text: 'undated', at: 0 })],
    }),
  })
  assert.equal(/56y|55y|ago/.test(markup), false, 'epoch zero is a missing value, not 1970')
  assert.equal(/>now</.test(markup), false, 'and it is not passed off as "now" either')
  assert.match(markup, /undated/, 'the message itself still shows')
})

// --- The session id elides in the middle, keeping both ends ----------------
run('the session id keeps its head and its tail', () => {
  assert.equal(elideSessionId('e4b3d55c-d78c-4687-b8a7-736ef1ed491e'), 'e4b3d55c…491e')
  assert.equal(elideSessionId('short-id'), 'short-id', 'an id that fits is left alone')
})

run('a tab whose agent main has no session for still draws its identity, minus the chip', () => {
  const markup = card({ agent: { sessionId: '' }, peek: null })
  assert.match(markup, /Deara Shea/, 'the name still stands')
  assert.equal(markup.includes('Copy session id'), false, 'and there is no empty id to copy')
})

if (failures > 0) {
  console.error(`ConversationPeekCard.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('ConversationPeekCard.test.tsx: ok')
