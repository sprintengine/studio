import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConversationPeek } from '../../shared/conversation-peek'
import {
  MAX_PEEK_ATTACHMENTS,
  MAX_PEEK_FIRST_CHARS,
  MAX_PEEK_MESSAGE_CHARS,
  MAX_PEEK_MESSAGES,
} from '../../shared/conversation-peek'
import { registerConversationPeekIpc } from '../ipc/conversation-peek-ipc'
import {
  clearClaudeTranscriptLocatorCache,
  encodeClaudeProjectDir,
  locateClaudeTranscript,
  resolveClaudeConfigDir,
} from './locate'
import {
  appendLivePeekPrompt,
  createConversationPeekService,
  MAX_LIVE_PEEK_PROMPTS,
  type ConversationPeekSessionState,
} from './service'
import {
  capPeekText,
  collapsePeekText,
  isTranscriptCommandInvocation,
  MAX_COLLAPSE_INPUT_CHARS,
  resolvePeekPath,
} from './text'
import { clearTranscriptPeekCache, readTranscriptPeek, type PeekImagePayload } from './transcript'

// Rows below are trimmed copies of shapes taken from real Claude Code
// transcripts under `~/.claude/projects/`, not invented ones — the filter they
// exercise is the whole risk in this feature, and a fixture that guesses would
// pass while the product showed tool output as "what they said".

type Row = Record<string, unknown>

function userRow(overrides: Row): Row {
  return {
    type: 'user',
    isSidechain: false,
    uuid: `uuid-${Math.random().toString(16).slice(2)}`,
    timestamp: '2026-09-06T10:00:00.000Z',
    cwd: '/home/dev/projects/multicode',
    userType: 'external',
    ...overrides,
  }
}

function humanRow(text: string, overrides: Row = {}): Row {
  return userRow({
    promptSource: 'typed',
    origin: { kind: 'human' },
    permissionMode: 'default',
    message: { role: 'user', content: text },
    ...overrides,
  })
}

async function writeTranscript(rows: Row[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'multicode-peek-'))
  const path = join(directory, 'session.jsonl')
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return path
}

// ── the collapsing rules ────────────────────────────────────────────────────

function testCollapse(): void {
  const fenced = collapsePeekText(
    'Fix the reducer.\n\n```ts\nconst x = 1\nconst y = 2\n```\n\nThat is all.',
  )
  assert.ok(!fenced.text.includes('const x'), `fenced block survived: ${fenced.text}`)
  assert.ok(fenced.text.startsWith('Fix the reducer.'), fenced.text)
  assert.ok(fenced.text.endsWith('That is all.'), fenced.text)

  // A path inside a fence is part of the paste, not something they attached.
  const fencedPath = collapsePeekText('Look:\n```\nsrc/main/secret.ts\n```')
  assert.deepEqual(fencedPath.paths, [], 'a path inside a fence must not become a chip')

  // A five-megabyte paste is collapsed at the head and counted, not run through
  // half a dozen regexes in full on a hover.
  const huge = collapsePeekText(`Take a look.\n${'z'.repeat(MAX_COLLAPSE_INPUT_CHARS * 2)}`)
  assert.equal(huge.overflowChars, MAX_COLLAPSE_INPUT_CHARS + 'Take a look.\n'.length)
  assert.ok(huge.text.startsWith('Take a look.'), huge.text.slice(0, 40))

  const dropped = collapsePeekText(
    'Read `design-system/USAGE.md` and conform.\n/home/dev/projects/multicode/src/main/app.ts\n@src/renderer/App.tsx',
  )
  assert.deepEqual(
    dropped.paths.map((path) => path.label),
    ['USAGE.md', 'app.ts', 'App.tsx'],
    JSON.stringify(dropped),
  )
  // A token promoted out of a SENTENCE leaves its label behind; a token that was
  // a whole line on its own is a drop and leaves nothing.
  assert.equal(dropped.text, 'Read USAGE.md and conform.', dropped.text)

  // A whole typed message: prose over two paragraphs naming several paths, some
  // inline in a sentence and some as bare tokens. This is the message the card
  // quotes in full, and substituting a bare space for each promoted path
  // rendered it as "attached at ; read USAGE.md + + and conform" — which reads
  // as though the app corrupted what the person wrote.
  const real = collapsePeekText(
    'Take a look at the reference repo on GitHub first.\n\n'
    + 'A design system is attached at `design-system/`; read `USAGE.md` + `foundations/tokens.css`'
    + ' + `components/` and conform — do not invent styles.',
  )
  assert.equal(
    real.text,
    'Take a look at the reference repo on GitHub first.\n\n'
    + 'A design system is attached at design-system; read USAGE.md + tokens.css + components'
    + ' and conform — do not invent styles.',
    real.text,
  )
  assert.deepEqual(real.paths.map((path) => path.label), ['design-system', 'tokens.css', 'components'])

  // Prose that merely contains a slash is not a file. A chip claiming otherwise
  // tells the reader something untrue, which is worse than showing no chip.
  const prose = collapsePeekText('Decide whether it is and/or, then tell me.')
  assert.deepEqual(prose.paths, [], JSON.stringify(prose))
  assert.ok(prose.text.includes('and/or'), prose.text)

  // Inline code that is not a path stays in the sentence, unquoted — and the
  // full stop stays attached to it.
  const inline = collapsePeekText('Set `MAX_PEEK_MESSAGES` to fifty.')
  assert.deepEqual(inline.paths, [])
  assert.equal(inline.text, 'Set MAX_PEEK_MESSAGES to fifty.')

  // The image placeholder Claude Code substitutes for a pasted screenshot names
  // an attachment that already arrives as its own block.
  const placeholder = collapsePeekText('[Image #26] What happened? You removed the backdrops.')
  assert.equal(placeholder.text, 'What happened? You removed the backdrops.')

  const urls = collapsePeekText('Compare against https://example.com/a/b/c.png please.')
  assert.deepEqual(urls.paths, [], 'a URL is not a file on this machine')
  assert.ok(urls.text.includes('https://example.com/a/b/c.png'), urls.text)

  assert.ok(isTranscriptCommandInvocation('/compact'))
  assert.ok(isTranscriptCommandInvocation('<command-name>/compact</command-name>'))
  assert.ok(isTranscriptCommandInvocation('<task-notification>\n<task-id>a1</task-id>'))
  assert.ok(!isTranscriptCommandInvocation('/backlog work MC-2455'), 'a command with an argument is a request')
  assert.ok(!isTranscriptCommandInvocation('Use the design system for this'))
}

function testCap(): void {
  const short = capPeekText('short enough', 400)
  assert.deepEqual(short, { text: 'short enough', truncatedChars: 0 })

  const body = `${'word '.repeat(120)}end`
  const capped = capPeekText(body, 100)
  assert.ok(capped.text.length <= 100, String(capped.text.length))
  assert.equal(
    capped.text.length + capped.truncatedChars,
    body.length,
    'truncatedChars must account for every character the cap removed',
  )
  assert.ok(!capped.text.endsWith(' '), capped.text)
  assert.ok(!capped.text.includes('…'), 'the ellipsis belongs to the renderer, next to the count')

  // One long token has no word boundary to break on; the hard cut still counts.
  const token = 'x'.repeat(500)
  const hard = capPeekText(token, 100)
  assert.equal(hard.text.length, 100)
  assert.equal(hard.truncatedChars, 400)
}

function testResolvePath(): void {
  assert.equal(resolvePeekPath('/a/b/c.ts', null, null), '/a/b/c.ts')
  assert.equal(resolvePeekPath('src/app.ts', '/repo', null), '/repo/src/app.ts')
  assert.equal(resolvePeekPath('src/app.ts', null, null), null, 'a relative path with no cwd cannot be opened')
  assert.equal(resolvePeekPath('~/notes.md', null, '/Users/me'), '/Users/me/notes.md')
  assert.equal(resolvePeekPath('~/notes.md', null, null), null)
  assert.equal(resolvePeekPath('a\0b', '/repo', null), null)
}

// ── the transcript filter ───────────────────────────────────────────────────

async function testTranscriptFilter(): Promise<void> {
  const path = await writeTranscript([
    humanRow('Right now we store the first six words of the prompt as the title.'),
    // A tool result. This is the row shape that outnumbers real messages ~30:1.
    userRow({
      toolUseResult: { stdout: 'ok' },
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 't1' }] },
    }),
    // A tool result with no `toolUseResult` key, caught by the block shape alone.
    userRow({ message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', tool_use_id: 't2' }] } }),
    // A Task subagent's own prompt.
    humanRow('subagent prompt', { isSidechain: true }),
    // The CLI talking in the user's voice.
    userRow({ isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } }),
    // A background task report: reads like a person until you look at `origin`.
    userRow({
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>' },
    }),
    // An interruption is an event, not a message.
    userRow({
      interruptedMessageId: 'msg_1',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }),
    // The summary a compaction injects as the next user turn.
    userRow({
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
    }),
    // A bare slash command, as older Claude Code wrote it.
    userRow({ message: { role: 'user', content: '/compact' } }),
    userRow({ message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
    humanRow('Check whether the prompt is persisted anywhere.', { promptSource: 'queued' }),
    humanRow('Use the design system for this.'),
  ])

  const peek = await readTranscriptPeek(path)
  assert.ok(peek, 'a transcript with three human messages must answer')
  assert.ok(peek.first?.text.startsWith('Right now we store'), String(peek.first?.text))
  assert.deepEqual(peek.since.map((message) => message.text), [
    'Check whether the prompt is persisted anywhere.',
    'Use the design system for this.',
  ])
  assert.equal(peek.first?.at, Date.parse('2026-09-06T10:00:00.000Z'))
}

async function testTranscriptRejections(): Promise<void> {
  assert.equal(await readTranscriptPeek('relative/path.jsonl'), null, 'a relative path must be refused')
  assert.equal(await readTranscriptPeek('/tmp/not-a-transcript.txt'), null, 'only .jsonl is read')
  assert.equal(await readTranscriptPeek('/tmp/missing-\u0000.jsonl'), null, 'a NUL byte must be refused')
  assert.equal(await readTranscriptPeek(join(tmpdir(), 'multicode-peek-absent.jsonl')), null)

  // A directory named like a transcript: `isFile()` is what rejects it, and
  // without that check the streaming read would stall on a FIFO forever.
  const directory = await mkdtemp(join(tmpdir(), 'multicode-peek-dir-'))
  const directoryTranscript = join(directory, 'session.jsonl')
  await mkdir(directoryTranscript)
  assert.equal(await readTranscriptPeek(directoryTranscript), null, 'a directory is not a transcript')

  // A truncated trailing write from a live CLI must not lose the rows above it.
  const partial = await mkdtemp(join(tmpdir(), 'multicode-peek-partial-'))
  const partialPath = join(partial, 'session.jsonl')
  await writeFile(partialPath, `${JSON.stringify(humanRow('First thing.'))}\n{"type":"user","mess`, 'utf8')
  const peek = await readTranscriptPeek(partialPath)
  assert.equal(peek?.first?.text, 'First thing.')

  // A READABLE transcript with nothing a person said is not a failure — a chat
  // opened this morning has exactly this shape — so it answers an empty peek,
  // and the service reports `transcript`, not `none`. Answering null here is
  // what made the card say Claude Code does not report its messages.
  const empty = await writeTranscript([{ type: 'assistant', message: { content: [] } }])
  const emptyPeek = await readTranscriptPeek(empty)
  assert.ok(emptyPeek, 'a readable transcript with no person-message must still answer')
  assert.equal(emptyPeek.first, null)
  assert.deepEqual(emptyPeek.since, [])
}

async function testTranscriptAttachments(): Promise<void> {
  const png = 'iVBORw0KGgo='
  // A real directory with real files, because whether a chip is live now
  // depends on whether the file is actually there.
  const repo = await mkdtemp(join(tmpdir(), 'multicode-peek-repo-'))
  await mkdir(join(repo, 'backlog', 'mockups'), { recursive: true })
  await writeFile(join(repo, 'backlog', 'mockups', 'peek.html'), '<p>ok</p>', 'utf8')
  await writeFile(join(repo, 'run-1877.log'), 'stalled\n', 'utf8')

  const path = await writeTranscript([
    humanRow('', {
      cwd: repo,
      imagePasteIds: [1, 2],
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            // Three path-shaped tokens: two that resolve against the session's
            // own cwd, and one that does not — `foundations/tokens.css` was
            // written while talking about a design system and means
            // `design-system/foundations/tokens.css`, so resolving it against
            // the repo root names a file that is not there.
            text: 'This is the card I mean — see `backlog/mockups/peek.html`, `foundations/tokens.css` and run-1877.log',
          },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: png } },
          // A URL source is a fetch this app has no business making on a hover.
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
        ],
      },
    }),
    // The companion line that names the pasted files, a few rows later.
    { type: 'attachment', attachment: { type: 'total_tokens_reminder' } },
    userRow({
      isMeta: true,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image: source: /tmp/TemporaryItems/Screenshot 2026-09-04 at 00.49.04.png]' },
          { type: 'text', text: '[Image: source: /tmp/TemporaryItems/second.png]' },
        ],
      },
    }),
    humanRow('And another with an image', {
      cwd: repo,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'And another with an image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ],
      },
    }),
  ])

  const peek = await readTranscriptPeek(path, { home: '/Users/me' })
  assert.ok(peek)
  const first = peek.first
  assert.ok(first)
  const images = first.attachments.filter(
    (attachment): attachment is Extract<typeof attachment, { kind: 'image' }> => attachment.kind === 'image',
  )
  const files = first.attachments.filter(
    (attachment): attachment is Extract<typeof attachment, { kind: 'file' }> => attachment.kind === 'file',
  )
  assert.equal(images.length, 2, JSON.stringify(first.attachments))
  assert.deepEqual(images.map((image) => image.label), [
    'Screenshot 2026-09-04 at 00.49.04.png',
    'second.png',
  ])
  assert.deepEqual(files.map((file) => file.label), ['peek.html', 'tokens.css'])
  assert.equal(
    files[0]?.path,
    join(repo, 'backlog', 'mockups', 'peek.html'),
    'a repo-relative drop resolves against the cwd the row recorded',
  )
  // THE DEFECT: this used to be a live button carrying a confident absolute
  // path to a file that is not there, which did nothing when pressed.
  assert.equal(
    files[1]?.path,
    null,
    'a token that resolves to nothing on disk must be an inert chip, not a button that no-ops',
  )
  // A bare filename with no separator is prose, not an attachment.
  assert.ok(!files.some((file) => file.label === 'run-1877.log'), JSON.stringify(files))

  // The sentence still reads: a promoted token leaves its label behind, and the
  // punctuation that followed it stays attached.
  assert.ok(
    first.text.startsWith('This is the card I mean — see peek.html, tokens.css and run-1877.log'),
    first.text,
  )

  // Only the quoted message retains payloads: the card draws a count on the rest.
  assert.equal(peek.images.size, 2, [...peek.images.keys()].join(','))
  for (const image of images) assert.ok(peek.images.has(image.id), image.id)
  const later = peek.since[0]
  assert.equal(later?.attachments.length, 1)
  assert.equal(peek.images.has(later?.attachments[0]?.id ?? ''), false)
}

async function testTranscriptCaps(): Promise<void> {
  const rows: Row[] = [humanRow(`First. ${'x'.repeat(MAX_PEEK_FIRST_CHARS * 2)}`)]
  for (let index = 0; index < MAX_PEEK_MESSAGES + 12; index += 1) {
    rows.push(humanRow(`message ${index} ${'y'.repeat(MAX_PEEK_MESSAGE_CHARS * 2)}`))
  }
  const peek = await readTranscriptPeek(await writeTranscript(rows))
  assert.ok(peek)
  assert.equal(peek.since.length, MAX_PEEK_MESSAGES)
  // The TAIL is kept: the newest work is what a peek is for.
  assert.ok(peek.since[peek.since.length - 1]?.text.startsWith(`message ${MAX_PEEK_MESSAGES + 11}`))
  assert.ok((peek.first?.text.length ?? 0) <= MAX_PEEK_FIRST_CHARS)
  assert.ok((peek.first?.truncatedChars ?? 0) > 0)
  assert.ok((peek.since[0]?.text.length ?? 0) <= MAX_PEEK_MESSAGE_CHARS)

  const manyPaths = Array.from({ length: MAX_PEEK_ATTACHMENTS + 6 }, (_, index) => `/tmp/file-${index}.txt`)
  const capped = await readTranscriptPeek(await writeTranscript([humanRow(`Look at ${manyPaths.join(' ')}`)]))
  assert.equal(capped?.first?.attachments.length, MAX_PEEK_ATTACHMENTS)
}

async function testTranscriptCache(): Promise<void> {
  clearTranscriptPeekCache()
  const path = await writeTranscript([humanRow('Cached message.')])
  const first = await readTranscriptPeek(path)
  const second = await readTranscriptPeek(path)
  assert.ok(first && second)
  assert.equal(first, second, 'an unchanged transcript must be served from the cache, not re-streamed')

  // Concurrent hovers on the same cold transcript share one read.
  clearTranscriptPeekCache()
  const [a, b] = await Promise.all([readTranscriptPeek(path), readTranscriptPeek(path)])
  assert.equal(a, b, 'a second hover during an in-flight read must join it')
}

// ── what the reader is allowed to hold while streaming ──────────────────────

async function testStreamingIsBounded(): Promise<void> {
  // One 512KB base64 image per message, on two hundred messages: ~105MB of
  // payload in a file well under the size cap. Accumulating every message and
  // discarding all but fifty-one afterwards is what took the main process to
  // hundreds of megabytes off a mouse hover, so the invariant under test is
  // that nothing but the answer is ever held.
  const bigImage = 'A'.repeat(512 * 1024)
  const rows: Row[] = []
  for (let index = 0; index < 200; index += 1) {
    rows.push(humanRow('', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `message ${index}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigImage } },
        ],
      },
    }))
  }
  const path = await writeTranscript(rows)

  clearTranscriptPeekCache()
  const before = process.memoryUsage().heapUsed
  const peek = await readTranscriptPeek(path)
  const grew = process.memoryUsage().heapUsed - before
  assert.ok(peek)

  // Only the head message's image is retained — the card draws thumbnails there
  // and a bare count on every later row.
  assert.equal(peek.images.size, 1, [...peek.images.keys()].join(','))
  assert.equal(peek.since.length, MAX_PEEK_MESSAGES)
  assert.ok(
    peek.since.every((message) => message.attachments.length === 1),
    'a later message keeps its attachment (the count is what the row shows), just not its bytes',
  )

  const retained = [...peek.images.values()].reduce((total, image) => total + image.data.length, 0)
  assert.ok(retained <= 512 * 1024, `retained ${retained} bytes`)
  // A smoke bound, not a precise one — GC timing makes the exact figure vary.
  // It is set well below the ~105MB of payload the file carries, which is the
  // whole point: the reader must not be proportional to the transcript.
  if (process.env.PEEK_HEAP_REPORT) console.log('    heap grew', Math.round(grew/1024/1024), 'MB')
  assert.ok(grew < 32 * 1024 * 1024, `heap grew ${Math.round(grew / 1024 / 1024)}MB streaming a ~105MB transcript`)
}

async function testOversizedImageKeepsItsPlace(): Promise<void> {
  // `data` is an unbounded string in a file another process writes. One row must
  // not be able to cost more than every other bound put together.
  const huge = 'A'.repeat(9 * 1024 * 1024)
  const path = await writeTranscript([
    humanRow('', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: huge } },
        ],
      },
    }),
  ])
  const peek = await readTranscriptPeek(path)
  assert.equal(peek?.first?.attachments.length, 1, 'an over-budget image still counts as an attachment')
  assert.equal(peek?.images.size, 0, 'but nothing of it is retained, so there is nothing to thumbnail or open')
}

// ── recovering a transcript the hook never named ────────────────────────────

function testProjectDirEncoding(): void {
  // Every case below pairs a launch cwd with the directory name Claude Code
  // writes under ~/.claude/projects for it. Each covers a distinct shape
  // observed in real project folders — the encoding has changed between Claude
  // Code versions, and an encoding derived from one example would name the
  // wrong folder for the other three.
  const cases: [string, string][] = [
    ['/home/dev/projects/multicode', '-home-dev-projects-multicode'],
    // `/.` becomes `--`: a dot is not special, it is just another separator.
    [
      '/home/dev/projects/multicode/.claude/worktrees/workspace-rail',
      '-home-dev-projects-multicode--claude-worktrees-workspace-rail',
    ],
    [
      '/home/dev/projects/.multicode-worktrees/multicode/perf-review-wholesale',
      '-home-dev-projects--multicode-worktrees-multicode-perf-review-wholesale',
    ],
    // Case is PRESERVED, and a hyphen already in the path survives as itself.
    [
      '/private/var/folders/vf/lknbrykx2l5dytzj634f4qk00000gn/T/mc-sdk-smoke-hFGiGN',
      '-private-var-folders-vf-lknbrykx2l5dytzj634f4qk00000gn-T-mc-sdk-smoke-hFGiGN',
    ],
    [
      '/private/tmp/claude-501/-home-dev-projects-multicode-068fbe4a-9a0c-4859-b095-3a38c5eb7c91/scratchpad/native-probe',
      '-private-tmp-claude-501--home-dev-projects-multicode-068fbe4a-9a0c-4859-b095-3a38c5eb7c91-scratchpad-native-probe',
    ],
  ]
  for (const [cwd, expected] of cases) assert.equal(encodeClaudeProjectDir(cwd), expected, cwd)
}

async function testLocateTranscript(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'multicode-peek-home-'))
  const projects = join(home, '.claude', 'projects')
  const launchCwd = '/tmp/repo'
  const sessionId = '11111111-2222-3333-4444-555555555555'
  await mkdir(join(projects, encodeClaudeProjectDir(launchCwd)), { recursive: true })
  const transcript = join(projects, encodeClaudeProjectDir(launchCwd), `${sessionId}.jsonl`)
  await writeFile(transcript, `${JSON.stringify(humanRow('Recovered.'))}\n`, 'utf8')

  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: sessionId, launchCwd }, { homeDir: home, env: {} }),
    transcript,
    'the derived path is the fast route when the launch cwd is known',
  )

  // The launch cwd we hold can be wrong or absent — a session adopted from a
  // sidecar, an agent whose folder was named by an older encoding. The session
  // id is the file name and is globally unique, so the scan still finds it.
  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript(
      { cliSessionId: sessionId, launchCwd: '/somewhere/else/entirely' },
      { homeDir: home, env: {} },
    ),
    transcript,
    'a wrong launch cwd must fall through to the scan, not answer null',
  )
  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: sessionId, launchCwd: null }, { homeDir: home, env: {} }),
    transcript,
    'no launch cwd at all must still resolve by session id',
  )

  // THE MISS. Every one of these answers null so the card falls back.
  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: 'no-such-session-id', launchCwd }, { homeDir: home, env: {} }),
    null,
    'a session with no transcript on disk must answer null, not a path',
  )
  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: '../../../etc/passwd', launchCwd }, { homeDir: home, env: {} }),
    null,
    'a session id that is not uuid-shaped must never be interpolated into a path',
  )
  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: sessionId, launchCwd }, { homeDir: join(home, 'nope'), env: {} }),
    null,
    'a missing projects directory must not throw',
  )

  // CLAUDE_CONFIG_DIR wins, and takes the first entry of a list — the same rule
  // the token-usage adapter resolves by, so the two cannot disagree.
  const altHome = await mkdtemp(join(tmpdir(), 'multicode-peek-alt-'))
  const altConfig = join(altHome, 'custom-claude')
  await mkdir(join(altConfig, 'projects', encodeClaudeProjectDir(launchCwd)), { recursive: true })
  const altTranscript = join(altConfig, 'projects', encodeClaudeProjectDir(launchCwd), `${sessionId}.jsonl`)
  await writeFile(altTranscript, `${JSON.stringify(humanRow('Elsewhere.'))}\n`, 'utf8')
  assert.equal(resolveClaudeConfigDir(home, { CLAUDE_CONFIG_DIR: `${altConfig},/other` }), altConfig)
  clearClaudeTranscriptLocatorCache()
  assert.equal(
    await locateClaudeTranscript(
      { cliSessionId: sessionId, launchCwd },
      { homeDir: home, env: { CLAUDE_CONFIG_DIR: `${altConfig},/other` } },
    ),
    altTranscript,
  )

  // A remembered hit is revalidated: a transcript that has since been deleted
  // must not be handed to the reader.
  clearClaudeTranscriptLocatorCache()
  const volatileHome = await mkdtemp(join(tmpdir(), 'multicode-peek-vol-'))
  const volatileDir = join(volatileHome, '.claude', 'projects', encodeClaudeProjectDir(launchCwd))
  await mkdir(volatileDir, { recursive: true })
  const volatile = join(volatileDir, `${sessionId}.jsonl`)
  await writeFile(volatile, '{}\n', 'utf8')
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: sessionId, launchCwd }, { homeDir: volatileHome, env: {} }),
    volatile,
  )
  await rm(volatile)
  assert.equal(
    await locateClaudeTranscript({ cliSessionId: sessionId, launchCwd }, { homeDir: volatileHome, env: {} }),
    null,
    'a memoised path that has gone must be dropped, not returned',
  )
}

async function testDerivedTranscriptSelection(): Promise<void> {
  const hookPath = await writeTranscript([humanRow('Named by the hook.')])
  const derivedPath = await writeTranscript([humanRow('Recovered by derivation.')])
  const hookPeek = await readTranscriptPeek(hookPath)
  const derivedPeek = await readTranscriptPeek(derivedPath)
  assert.ok(hookPeek && derivedPeek)

  const { service, located } = harness(
    {
      // A parked Claude chat after a restart: no hook path, but a session id
      // and the directory it was launched in.
      parked: {
        cliSessionId: 'cli-session-1',
        launchCwd: '/home/dev/projects/multicode',
        claudeHarness: true,
        prompts: [],
      },
      // The hook has spoken; the CLI's own answer must win.
      running: {
        transcriptPath: hookPath,
        cliSessionId: 'cli-session-1',
        launchCwd: '/home/dev/projects/multicode',
        claudeHarness: true,
        prompts: [],
      },
      // Codex reports prompts and no transcript. Nothing may invent a
      // Claude-shaped path for it.
      codex: {
        cliSessionId: 'cli-session-2',
        launchCwd: '/home/dev/projects/multicode',
        claudeHarness: false,
        prompts: [{ text: 'Have a look at the reasoning picker', at: 5 }],
      },
      // A Claude session whose transcript is not on disk yet.
      cold: {
        cliSessionId: 'cli-session-3',
        launchCwd: '/home/dev/projects/multicode',
        claudeHarness: true,
        prompts: [{ text: 'Just asked this', at: 7 }],
      },
    },
    { [hookPath]: hookPeek, [derivedPath]: derivedPeek },
    { 'cli-session-1': derivedPath },
  )

  const parked = await service.readConversationPeek('parked')
  assert.equal(parked.source, 'transcript', 'a parked Claude chat must recover its own history')
  assert.equal(parked.first?.text, 'Recovered by derivation.')
  assert.deepEqual(located, [{ cliSessionId: 'cli-session-1', launchCwd: '/home/dev/projects/multicode' }])

  const running = await service.readConversationPeek('running')
  assert.equal(running.first?.text, 'Named by the hook.', 'a hook-supplied path always wins over a derived one')
  assert.equal(located.length, 1, 'a session with a hook path must not be looked up on disk at all')

  const codex = await service.readConversationPeek('codex')
  assert.equal(codex.source, 'live')
  assert.equal(located.length, 1, 'a non-Claude runtime must never have a Claude-shaped path derived for it')

  const cold = await service.readConversationPeek('cold')
  assert.equal(cold.source, 'live', 'a derived path that does not resolve falls back, it does not blank the card')
  assert.equal(cold.first?.text, 'Just asked this')
  assert.equal(located.length, 2)
}

async function testAttachmentBudget(): Promise<void> {
  const png = 'iVBORw0KGgo='
  const path = await writeTranscript([
    humanRow('', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'All of these: /tmp/spec.md and /tmp/run.log' },
          ...Array.from({ length: 8 }, () => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: png },
          })),
        ],
      },
    }),
  ])
  const peek = await readTranscriptPeek(path)
  const attachments = peek?.first?.attachments ?? []
  assert.equal(attachments.length, MAX_PEEK_ATTACHMENTS)
  assert.deepEqual(
    attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => attachment.label),
    ['spec.md', 'run.log'],
    'eight screenshots must not squeeze out the two files — the file is the half you can act on',
  )
  assert.equal(attachments.filter((attachment) => attachment.kind === 'image').length, MAX_PEEK_ATTACHMENTS - 2)
}

// ── the service: which source answered, and what a click opens ──────────────

type Harness = {
  service: ReturnType<typeof createConversationPeekService>
  opened: string[]
  revealed: string[]
  transcriptReads: string[]
  located: { cliSessionId: string; launchCwd?: string | null }[]
}

function harness(
  states: Record<string, ConversationPeekSessionState>,
  transcripts: Record<string, Awaited<ReturnType<typeof readTranscriptPeek>>>,
  derived: Record<string, string> = {},
): Harness {
  const opened: string[] = []
  const revealed: string[] = []
  const transcriptReads: string[] = []
  const located: { cliSessionId: string; launchCwd?: string | null }[] = []
  const service = createConversationPeekService({
    readSessionState: (sessionId) => states[sessionId] ?? null,
    readTranscript: async (transcriptPath) => {
      transcriptReads.push(transcriptPath)
      return transcripts[transcriptPath] ?? null
    },
    locateTranscript: async (input) => {
      located.push(input)
      return derived[input.cliSessionId] ?? null
    },
    renderThumbnail: (image: PeekImagePayload) => `data:image/png;base64,thumb-${image.id}`,
    openImage: async (image) => {
      opened.push(image.id)
    },
    revealFile: async (filePath) => {
      revealed.push(filePath)
    },
  })
  return { service, opened, revealed, transcriptReads, located }
}

async function testSourceSelection(): Promise<void> {
  const png = 'iVBORw0KGgo='
  const logDir = await mkdtemp(join(tmpdir(), 'multicode-peek-log-'))
  const logPath = join(logDir, 'run-1877.log')
  await writeFile(logPath, 'stalled\n', 'utf8')
  const transcriptPath = await writeTranscript([
    humanRow('', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: `The run stalls on the third task — see ${logPath}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ],
      },
    }),
  ])
  const transcript = await readTranscriptPeek(transcriptPath)
  assert.ok(transcript)

  const { service, opened, revealed } = harness(
    {
      'with-transcript': { transcriptPath, prompts: [{ text: 'live text', at: 3 }] },
      'live-only': {
        prompts: [
          { text: 'Have a look at the reasoning picker', at: 1 },
          { text: '```\npasted\n```', at: 2 },
          { text: 'Now do the other one', at: 3 },
        ],
      },
      'stale-transcript': { transcriptPath: '/tmp/gone.jsonl', prompts: [{ text: 'still said this', at: 9 }] },
      silent: { prompts: [] },
    },
    { [transcriptPath]: transcript },
  )

  const full: ConversationPeek = await service.readConversationPeek('with-transcript')
  assert.equal(full.source, 'transcript', 'a readable transcript wins over the live list')
  assert.equal(full.sessionId, 'with-transcript')
  const image = full.first?.attachments.find((attachment) => attachment.kind === 'image')
  assert.ok(image && image.kind === 'image')
  assert.ok(image.thumbnailDataUrl?.startsWith('data:image/png;base64,thumb-'), String(image.thumbnailDataUrl))

  const live = await service.readConversationPeek('live-only')
  assert.equal(live.source, 'live')
  assert.equal(live.first?.text, 'Have a look at the reasoning picker')
  // The pasted-only prompt collapses to nothing and is dropped rather than
  // rendered as an empty row.
  assert.deepEqual(live.since.map((message) => message.text), ['Now do the other one'])
  assert.deepEqual(live.first?.attachments, [], 'a live prompt frame carries no attachments')

  const stale = await service.readConversationPeek('stale-transcript')
  assert.equal(stale.source, 'live', 'an unreadable transcript falls back rather than blanking the card')
  assert.equal(stale.first?.text, 'still said this')

  const silent = await service.readConversationPeek('silent')
  assert.equal(silent.source, 'none')
  assert.equal(silent.first, null)

  // A session main holds no state for is `unknown`, NEVER `none`: the app was
  // killed rather than quit, or the chat was parked past the sidecar TTL. Both
  // are statements about our records; `none` is a statement about the runtime,
  // and making it here tells someone their Claude Code chat cannot report.
  const unknown = await service.readConversationPeek('no-such-session')
  assert.equal(unknown.source, 'unknown')
  assert.equal(unknown.sessionId, 'no-such-session')
  assert.notEqual(unknown.source, 'none', 'no record of a chat is not a claim about its runtime')

  // Opening resolves an id against the peek main itself produced.
  await service.openConversationPeekAttachment('with-transcript', image.id)
  assert.deepEqual(opened, [image.id])
  const file = full.first?.attachments.find((attachment) => attachment.kind === 'file')
  assert.ok(file && file.kind === 'file' && file.path)
  await service.openConversationPeekAttachment('with-transcript', file.id)
  assert.deepEqual(revealed, [logPath])

  // An id the current peek did not hand out opens nothing at all.
  await service.openConversationPeekAttachment('with-transcript', 'made-up-id')
  await service.openConversationPeekAttachment('live-only', file.id)
  assert.deepEqual(opened, [image.id])
  assert.deepEqual(revealed, [logPath])
}

async function testEmptyButCapableSource(): Promise<void> {
  // A readable transcript with nothing said yet.
  const emptyTranscript = await writeTranscript([{ type: 'assistant', message: { content: [] } }])
  const emptyPeek = await readTranscriptPeek(emptyTranscript)
  assert.ok(emptyPeek)

  const { service } = harness(
    {
      // A brand-new Claude Code chat, hovered before its first prompt. It has a
      // transcript and it is empty.
      fresh: { transcriptPath: emptyTranscript, claudeHarness: true, reportsMessages: true, prompts: [] },
      // The same chat before the CLI has even written the file.
      unwritten: { cliSessionId: 'cli-x', claudeHarness: true, reportsMessages: true, prompts: [] },
      // Codex: reports prompts, keeps no transcript, has said nothing yet.
      codexFresh: { claudeHarness: false, reportsMessages: true, prompts: [] },
      // OpenCode / Muse / a plain shell: genuinely cannot report.
      opencode: { claudeHarness: false, reportsMessages: false, prompts: [] },
    },
    { [emptyTranscript]: emptyPeek },
  )

  // THE DEFECT: all four of these used to answer `none`, so the card said
  // "this runtime doesn't report its messages" about Claude Code.
  const fresh = await service.readConversationPeek('fresh')
  assert.equal(fresh.source, 'transcript', 'an empty transcript is still a transcript')
  assert.equal(fresh.first, null)
  assert.deepEqual(fresh.since, [])

  const unwritten = await service.readConversationPeek('unwritten')
  assert.equal(unwritten.source, 'transcript', 'a Claude chat with no file yet can still report; it has not yet')

  const codexFresh = await service.readConversationPeek('codexFresh')
  assert.equal(codexFresh.source, 'live', 'a prompt-reporting runtime with nothing said is live-and-empty')
  assert.equal(codexFresh.first, null)

  const opencode = await service.readConversationPeek('opencode')
  assert.equal(opencode.source, 'none', 'only a runtime that cannot report at all is `none`')
}

function testLivePromptWindow(): void {
  let prompts = appendLivePeekPrompt(undefined, 'first', 1)
  for (let index = 1; index < MAX_LIVE_PEEK_PROMPTS + 20; index += 1) {
    prompts = appendLivePeekPrompt(prompts, `message ${index}`, index + 1)
  }
  assert.equal(prompts.length, MAX_LIVE_PEEK_PROMPTS)
  assert.equal(prompts[0]?.text, 'first', 'the message that started the chat is never trimmed away')
  assert.equal(prompts[prompts.length - 1]?.text, `message ${MAX_LIVE_PEEK_PROMPTS + 19}`)
}

// ── the IPC boundary ────────────────────────────────────────────────────────

async function testIpc(): Promise<void> {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const calls: string[] = []
  registerConversationPeekIpc(
    { handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } as unknown as Parameters<typeof registerConversationPeekIpc>[0],
    {
      readConversationPeek: async (sessionId) => {
        calls.push(`read:${sessionId}`)
        return { sessionId, source: 'none', first: null, since: [] }
      },
      openConversationPeekAttachment: async (sessionId, attachmentId) => {
        calls.push(`open:${sessionId}:${attachmentId}`)
      },
    },
  )

  const read = handlers.get('conversation-peek:read')
  const open = handlers.get('conversation-peek:open-attachment')
  assert.ok(read && open)

  assert.equal((await read({}, 'session-1') as ConversationPeek).sessionId, 'session-1')
  await open({}, { sessionId: 'session-1', attachmentId: 'a1' })
  assert.deepEqual(calls, ['read:session-1', 'open:session-1:a1'])

  // A malformed payload answers the empty peek rather than throwing: a hover
  // must never surface an error.
  assert.equal((await read({}, 42) as ConversationPeek).source, 'unknown')
  assert.equal((await read({}, 'a'.repeat(600)) as ConversationPeek).source, 'unknown')
  await open({}, null)
  await open({}, { sessionId: 'session-1' })
  await open({}, { sessionId: 'session-1', attachmentId: 'a\u00001' })
  assert.deepEqual(calls, ['read:session-1', 'open:session-1:a1'], 'no malformed payload reached the service')
}

async function run(): Promise<void> {
  testCollapse()
  testCap()
  testResolvePath()
  await testTranscriptFilter()
  await testTranscriptRejections()
  await testTranscriptAttachments()
  await testTranscriptCaps()
  await testTranscriptCache()
  await testStreamingIsBounded()
  await testOversizedImageKeepsItsPlace()
  testProjectDirEncoding()
  await testLocateTranscript()
  await testAttachmentBudget()
  await testSourceSelection()
  await testDerivedTranscriptSelection()
  await testEmptyButCapableSource()
  testLivePromptWindow()
  await testIpc()
  console.log('conversation-peek.test.ts: all assertions passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
