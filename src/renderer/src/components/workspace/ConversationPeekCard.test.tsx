import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ConversationPeekCard,
  elideSessionId,
  messageTooltipParts,
  type ConversationPeekIdentity,
} from './ConversationPeekCard'
import type { ConversationPeek, ConversationPeekMessage } from '../../../../shared/conversation-peek'

// QA for the conversation peek's card — the presentational half of the hover
// surface both anchors share. What matters here is what the card SAYS: which of
// the three runtime shapes it is in, what it does with one message versus
// forty, that attachments are real controls, and that the things the design cut
// (a footer, a keyboard hint, a message count) stayed cut.
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

const IDENTITY: ConversationPeekIdentity = {
  name: 'Deara Shea',
  cli: 'claude-code',
  model: 'claude-opus-5',
  sessionId: 'e4b3d55c-d78c-4687',
  taskId: null,
  status: { tone: 'good', pulse: true, label: 'Working' },
  agentScope: null,
}

const message = (over: Partial<ConversationPeekMessage> = {}): ConversationPeekMessage => ({
  id: 'm1',
  text: 'Right now we store the first five or six words from the prompt as the title.',
  at: NOW - 3 * HOUR,
  attachments: [],
  truncatedChars: 0,
  ...over,
})

const peek = (over: Partial<ConversationPeek> = {}): ConversationPeek => ({
  sessionId: IDENTITY.sessionId ?? 's',
  source: 'transcript',
  first: message(),
  since: [],
  totalMessages: 1,
  ...over,
})

function card(
  over: {
    identity?: Partial<ConversationPeekIdentity>
    peek?: ConversationPeek | null
    loading?: boolean
    copied?: boolean
    onOpenAttachment?: ((attachmentId: string) => void) | undefined
  } = {},
): string {
  return renderToStaticMarkup(
    <ConversationPeekCard
      identity={{ ...IDENTITY, ...(over.identity ?? {}) }}
      peek={over.peek === undefined ? peek() : over.peek}
      loading={over.loading ?? false}
      now={NOW}
      copied={over.copied ?? false}
      onCopySession={() => {}}
      onOpenAttachment={'onOpenAttachment' in over ? over.onOpenAttachment : () => {}}
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
  const markup = card({ identity: { model: null } })
  assert.match(markup, /CLI default/, 'null model falls back to "CLI default"')
  assert.equal(markup.includes('claude-opus-5'), false, 'no stale model string when unset')
})

run('a sprint task rides the meta row when there is one', () => {
  assert.match(card({ identity: { taskId: 'MC-2488' } }), /MC-2488/, 'shows the claimed task id')
  assert.equal(card().includes('MC-2488'), false, 'and nothing when there is none')
})

// --- The three shapes a runtime can put the card in (mockup frame 8) -------
run('a transcript peek shows the first message and the thread', () => {
  const markup = card({
    peek: peek({
      since: [message({ id: 'm2', text: 'Check whether the prompt is persisted', at: NOW - 2 * HOUR })],
      totalMessages: 2,
    }),
  })
  assert.match(markup, />First message</, 'labels the quoted message')
  assert.match(markup, />Since then</, 'labels the thread')
  assert.match(markup, /Check whether the prompt is persisted/, 'shows the thread row')
  assert.match(markup, /2h/, 'a thread row is aged in the terse voice, never a clock')
})

run('a live peek says its messages are the ones seen since launch', () => {
  const markup = card({ peek: peek({ source: 'live' }) })
  assert.match(
    markup,
    /First message since launch/,
    'the label carries the shape: a live peek is not the chat’s history',
  )
})

run('a live peek with nothing yet says what it cannot see, rather than looking empty', () => {
  const markup = card({ peek: peek({ source: 'live', first: null, totalMessages: 0 }) })
  assert.match(markup, /Nothing sent since this app launched/, 'says what it is missing')
  assert.match(markup, /no transcript/, 'and why')
})

run('an identity-only peek says the runtime reports nothing, and still earns its place', () => {
  const markup = card({ peek: peek({ source: 'none', first: null, totalMessages: 0 }) })
  assert.match(markup, /doesn’t report its messages/, 'says which shape it is in')
  assert.match(markup, /claude-opus-5/, 'the model still stands')
  assert.match(markup, /e4b3d55c…4687/, 'and the session id')
  assert.equal(markup.includes('Since then'), false, 'no thread heading over an empty thread')
})

run('a chat nobody has spoken in says so plainly', () => {
  const markup = card({ peek: peek({ first: null, totalMessages: 0 }) })
  assert.match(markup, /No messages yet/, 'the never-prompted state')
  assert.match(markup, /becomes its title/, 'and what will happen when you do')
})

run('a chat with one message shows it and stops — no empty Since then', () => {
  const markup = card()
  assert.match(markup, />First message</, 'quotes the one message')
  assert.equal(markup.includes('Since then'), false, 'and grows no empty heading under it')
})

// --- A long thread scrolls in place, faded at the top ----------------------
run('a long thread is masked at its top edge so it is obvious there is more above', () => {
  const long = peek({
    since: Array.from({ length: 9 }, (_, index) =>
      message({ id: `m${index}`, text: `message ${index}`, at: NOW - (9 - index) * MINUTE }),
    ),
    totalMessages: 10,
  })
  const markup = card({ peek: long })
  assert.match(markup, /conversation-peek-thread--faded/, 'the fade is on')
  assert.match(markup, /max-h-\[108px\]/, 'and the list scrolls rather than growing the card')

  const short = card({
    peek: peek({ since: [message({ id: 'm2', text: 'one more' })], totalMessages: 2 }),
  })
  assert.equal(short.includes('--faded'), false, 'a thread that fits is not faded')
})

// --- Attachments are controls, not decoration (mockup frame 6) -------------
run('an image on the first message is a button that opens it', () => {
  const markup = card({
    peek: peek({
      first: message({
        attachments: [
          { kind: 'image', id: 'a1', label: 'screenshot.png', thumbnailDataUrl: 'data:image/png;base64,AA' },
        ],
      }),
    }),
  })
  assert.match(markup, /<button[^>]*aria-label="Open screenshot\.png"/, 'a real control with a real name')
  assert.match(markup, /data:image\/png;base64,AA/, 'and the thumbnail it was given')
})

run('past three images the rest are counted, not crammed in', () => {
  const images = Array.from({ length: 5 }, (_, index) => ({
    kind: 'image' as const,
    id: `img${index}`,
    label: `shot-${index}.png`,
  }))
  const markup = card({ peek: peek({ first: message({ attachments: images }) }) })
  assert.match(markup, /\+2/, 'the remainder is counted')
  assert.equal(markup.includes('shot-4.png'), false, 'and the fourth thumbnail is not drawn')
})

run('a file is a chip that opens the file; one with no readable path is inert and says so', () => {
  const openable = card({
    peek: peek({
      first: message({ attachments: [{ kind: 'file', id: 'f1', label: 'run-1877.log', path: '/tmp/run.log' }] }),
    }),
  })
  assert.match(openable, /aria-label="Open run-1877\.log"/, 'the chip opens the file')
  assert.equal(/title="/.test(openable), false, 'the path rides the kit tooltip, never a native title')

  const pathless = card({
    peek: peek({
      first: message({ attachments: [{ kind: 'file', id: 'f1', label: 'spec.md', path: null }] }),
    }),
  })
  assert.match(pathless, /no readable path/, 'a chip with nothing to open says that')
  assert.match(pathless, /disabled=""/, 'and is not pressable')
})

run('with no opener in the preload the chips render inert rather than lying', () => {
  const markup = card({
    onOpenAttachment: undefined,
    peek: peek({
      first: message({ attachments: [{ kind: 'file', id: 'f1', label: 'spec.md', path: '/spec.md' }] }),
    }),
  })
  assert.match(markup, /spec\.md/, 'the attachment is still named')
  assert.match(markup, /disabled=""/, 'but nothing pretends to open it')
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
      totalMessages: 2,
    }),
  })
  assert.match(markup, /aria-label="1 attachment"/, 'the row counts what it carries')
  assert.equal(markup.includes('Open card.png'), false, 'and opens nothing from a one-line row')
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
    peek: peek({
      since: [message({ id: 'm2', text: 'Drop the role row from the tab card' })],
      totalMessages: 2,
    }),
  })
  assert.match(markup, /Drop the role row from the tab card/, 'the one line the row shows')
  assert.equal(/<li[^>]*>\s*<button/.test(markup), false, 'a thread row is not a button — it is a hover target')
})

// --- The shapes MAIN actually produces -------------------------------------
// The three above are the whole of `ConversationPeekSource`, and each is
// exercised with the `first` main pairs it with: a capable runtime emits
// `transcript` / `live` with `first: null` until the first prompt lands, and
// only a runtime that cannot report emits `none`. That pairing is the ordering
// bug this suite exists to hold: reading `source` before `first` told every
// brand-new chat that its runtime was broken.
run('an empty chat on a capable runtime is never told its runtime is broken', () => {
  for (const source of ['transcript', 'live'] as const) {
    const markup = card({ peek: peek({ source, first: null, since: [], totalMessages: 0 }) })
    assert.equal(
      markup.includes('doesn’t report its messages'),
      false,
      `a ${source} peek with nothing yet is an empty chat, not a limited runtime`,
    )
  }
})

// --- Unknown timestamps say nothing, never a confident wrong age -----------
run('a message main could not date shows no age at all', () => {
  const markup = card({
    peek: peek({
      first: message({ at: 0 }),
      since: [message({ id: 'm2', text: 'undated', at: 0 })],
      totalMessages: 2,
    }),
  })
  assert.equal(/56y|55y|ago/.test(markup), false, 'epoch zero is a missing value, not 1970')
  assert.equal(/>now</.test(markup), false, 'and it is not passed off as "now" either')
  assert.match(markup, /undated/, 'the message itself still shows')
})

run('a real timestamp still reads as an age', () => {
  const markup = card({ peek: peek({ first: message({ at: NOW - 3 * HOUR }) }) })
  assert.match(markup, /3h ago/, 'the label carries the age when there is one')
})

// --- The session id elides in the middle, keeping both ends ----------------
run('the session id keeps its head and its tail', () => {
  assert.equal(elideSessionId('e4b3d55c-d78c-4687-b8a7-736ef1ed491e'), 'e4b3d55c…491e')
  assert.equal(elideSessionId('short-id'), 'short-id', 'an id that fits is left alone')
})

// --- A multi-agent chat says which agent it is quoting ---------------------
run('a chat with several agents says which one the card is about', () => {
  const markup = card({ identity: { agentScope: { agentName: 'Deara Shea', total: 3 } } })
  assert.match(markup, /Showing/, 'the card says it is showing one of them')
  assert.match(markup, /one of\s*3\s*agents/, 'and how many there are')
})

run('a chat with one agent says nothing about agents at all', () => {
  assert.equal(card().includes('one of'), false, 'no scope line where there is nothing to disclaim')
})

// --- The thread tooltip only fires on a row that is actually cut -----------
run('a row that fits gets no tooltip trigger and no tab stop', () => {
  const markup = card({
    peek: peek({ since: [message({ id: 'm2', text: 'short' })], totalMessages: 2 }),
  })
  assert.equal(/tabindex="0"[^>]*>\s*<span[^>]*>3h/.test(markup), false, 'no tab stop on a row with nothing more to say')
})

run('a row the wire cut is a tab stop, so the rest is reachable without a pointer', () => {
  const markup = card({
    peek: peek({
      since: [message({ id: 'm2', text: 'a very long thing', truncatedChars: 900 })],
      totalMessages: 2,
    }),
  })
  assert.match(markup, /tabindex="0"/, 'both paths: hover and focus')
})

// --- What the design cut, and must stay cut --------------------------------
run('no footer, no keyboard hint, no message count', () => {
  const markup = card({
    peek: peek({
      since: [message({ id: 'm2' }), message({ id: 'm3' })],
      totalMessages: 40,
    }),
  })
  assert.equal(/Esc/.test(markup), false, 'no "Esc dismisses" hint')
  assert.equal(/click to open/i.test(markup), false, 'no "click to open" hint')
  assert.equal(/\b40\b/.test(markup.replace(/<svg[\s\S]*?<\/svg>/g, '')), false, 'the total is never printed — the list is the count')
  assert.equal(/\d+ messages/.test(markup), false, 'and never counted in words')
})

// --- Loading: identity from the first frame, never a blank card ------------
run('while the read is in flight the identity stands and the body is a skeleton', () => {
  const markup = card({ peek: null, loading: true })
  assert.match(markup, /Deara Shea/, 'the half we already know is on screen')
  assert.match(markup, /claude-opus-5/, 'including the model')
  assert.match(markup, /skeleton-shimmer/, 'and the body says it is still reading')
})

run('a read that never answers says the conversation is not readable, never spins forever', () => {
  const markup = card({ peek: null, loading: false })
  assert.match(markup, /isn’t readable from here/, 'the honest dead end')
})

process.exit(failures === 0 ? 0 : 1)
