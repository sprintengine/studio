import assert from 'node:assert/strict'

import {
  HOSTED_CARD_FEED_SCHEMA_VERSION,
  HOSTED_CARD_FEED_URL,
  hostedCardFeedUpdatedAtMs,
  parseHostedCardFeed,
  refuseCardActions,
} from './hosted-card-feed'

const card = (over: Record<string, unknown> = {}) => ({
  slug: 'drives-your-browser',
  kind: 'mcp',
  title: 'Let an agent drive your browser',
  dek: 'Describe the journey in words.',
  art: 'browser',
  publishedAt: '2026-09-05',
  go: [{ verb: 'open.surface', view: 'plugins' }],
  ...over,
})

const feed = (cards: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  updatedAt: '2026-09-06T00:00:00Z',
  cards,
  ...over,
})

const one = (go: unknown) => {
  const parsed = parseHostedCardFeed(feed([card({ go: [go] })]))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message)
  return parsed.feed.cards[0]?.go[0]
}

// A verb that does not parse takes its whole card with it, so `rejects` is the
// same assertion as "this feed yielded no cards" plus a reason.
const rejects = (go: unknown, match: RegExp) => {
  const parsed = parseHostedCardFeed(feed([card({ go: [go] })]))
  assert.ok(parsed.ok)
  assert.equal(parsed.feed.cards.length, 0)
  assert.equal(parsed.dropped, 1)
  assert.match(parsed.dropReasons[0] ?? '', match)
}

// A string body and an object body parse the same, unknown fields are dropped,
// and the optional fields only appear when the row carried them.
{
  const parsed = parseHostedCardFeed(JSON.stringify(feed([card({ credit: ' Playwright ', hero: true, extra: 1 })])))
  assert.ok(parsed.ok)
  assert.equal(parsed.feed.schemaVersion, HOSTED_CARD_FEED_SCHEMA_VERSION)
  assert.equal(parsed.dropped, 0)
  assert.deepEqual(parsed.feed.cards[0], {
    slug: 'drives-your-browser',
    kind: 'mcp',
    title: 'Let an agent drive your browser',
    dek: 'Describe the journey in words.',
    art: 'browser',
    publishedAt: '2026-09-05',
    go: [{ verb: 'open.surface', view: 'plugins' }],
    credit: 'Playwright',
    hero: true,
  })
  const bare = parseHostedCardFeed(feed([card()]))
  assert.ok(bare.ok)
  assert.equal('credit' in bare.feed.cards[0], false)
  assert.equal('hero' in bare.feed.cards[0], false)
  assert.equal(HOSTED_CARD_FEED_URL.startsWith('https://'), true)
}

// The whole-feed gate: a schemaVersion this build does not know, a body that is
// not an object, an unparsable updatedAt and a missing cards array are all
// refusals of the entire body — never a partial feed.
{
  for (const [body, match] of [
    ['{ not json', /not valid JSON/],
    [[1, 2, 3], /must be a JSON object/],
    [feed([], { schemaVersion: 2 }), /schemaVersion 2 is not one this build reads/],
    [feed([], { updatedAt: 'the other day' }), /updatedAt must be an ISO date-time/],
    [{ schemaVersion: 1, updatedAt: '2026-09-06T00:00:00Z' }, /cards must be an array/],
  ] as [unknown, RegExp][]) {
    const parsed = parseHostedCardFeed(body)
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.message, match)
  }
}

// One bad row is dropped and counted with a reason; the rest of the feed
// renders. A duplicate slug is a bad row like any other.
{
  const parsed = parseHostedCardFeed(
    feed([
      card({ slug: 'keeps' }),
      card({ slug: 'no-art', art: 'https://example.com/pretty.png' }),
      card({ slug: 'no-such-kind', kind: 'poster' }),
      // A kind an older feed used and this build retired is dropped the same way.
      card({ slug: 'retired-kind', kind: 'workflow' }),
      card({ slug: 'no-dek', dek: '   ' }),
      card({ slug: 'undated', publishedAt: 'soon' }),
      card({ slug: 'no-go', go: undefined }),
      'a string is not a card',
      card({ slug: 'keeps' }),
      card({ slug: 'also-keeps' }),
    ]),
  )
  assert.ok(parsed.ok)
  assert.deepEqual(
    parsed.feed.cards.map((c) => c.slug),
    ['keeps', 'also-keeps'],
  )
  assert.equal(parsed.dropped, 8)
  assert.equal(parsed.dropReasons.length, 8)
  assert.match(parsed.dropReasons.join('\n'), /"retired-kind" has kind "workflow", which is not one this build knows/)
  assert.match(parsed.dropReasons.join('\n'), /must name artwork this build ships, not a URL/)
  assert.match(parsed.dropReasons.join('\n'), /duplicate slug "keeps"/)
}

// An empty go list is legal: a showcase card can be pure marketing.
{
  const parsed = parseHostedCardFeed(feed([card({ go: [] })]))
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.feed.cards[0].go, [])
}

// The seven verbs, each parsed to the shape its call site takes.
{
  assert.deepEqual(one({ verb: 'require.cli', cli: ' claude-code ' }), { verb: 'require.cli', cli: 'claude-code' })
  rejects({ verb: 'require.cli' }, /require\.cli needs a cli id/)

  // install.mcp has no source dimension: the catalogue is bundled and singular.
  assert.deepEqual(one({ verb: 'install.mcp', id: 'io-github-domdomegg-gmail-mcp', source: 'builtin' }), {
    verb: 'install.mcp',
    id: 'io-github-domdomegg-gmail-mcp',
  })
  rejects({ verb: 'install.mcp' }, /install\.mcp needs a server id/)

  // install.module names an entry in the app's OWN signed registry and carries
  // no source: there is exactly one registry, it ships with the app, and a card
  // that could name another would be choosing where this machine's code comes
  // from. A `source` beside it is copied out, not through.
  assert.deepEqual(one({ verb: 'install.module', id: 'review', source: 'github:someone/else' }), {
    verb: 'install.module',
    id: 'review',
  })
  assert.deepEqual(one({ verb: 'install.module', id: '  review  ' }), { verb: 'install.module', id: 'review' })
  rejects({ verb: 'install.module' }, /install\.module needs a marketplace entry id/)
  rejects({ verb: 'install.module', id: '   ' }, /install\.module needs a marketplace entry id/)

  for (const verb of ['install.skill', 'install.plugin']) {
    assert.deepEqual(one({ verb, source: 'github:sprintengine/studio-releases', id: 'studio-skills/skills/debug' }), {
      verb,
      source: 'github:sprintengine/studio-releases',
      id: 'studio-skills/skills/debug',
    })
    rejects({ verb, id: 'debug' }, new RegExp(`${verb.replace('.', '\\.')} needs a source and an id`))
    // The executor resolves marketplaceName / marketplaceRepo / commitSha from
    // the scan; a card that carried them would carry facts that go stale.
    assert.deepEqual(one({ verb, source: 's', id: 'i', commitSha: 'deadbeef', marketplaceName: 'x' }), {
      verb,
      source: 's',
      id: 'i',
    })
  }

  // open.chat keeps skills and MCP servers apart, and must say whether Go sends.
  // The card installs the server it then names, because a card that names one
  // it does not install is refused whole (see the card-level rules below).
  {
    const parsed = parseHostedCardFeed(
      feed([
        card({
          go: [
            { verb: 'install.mcp', id: 'net-todoist-mcp' },
            {
              verb: 'open.chat',
              prompt: 'Do the thing.',
              skills: ['frontend-design'],
              mcpServers: ['net-todoist-mcp'],
              send: true,
            },
          ],
        }),
      ]),
    )
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message)
    assert.deepEqual(parsed.feed.cards[0]?.go[1], {
      verb: 'open.chat',
      prompt: 'Do the thing.',
      send: true,
      skills: ['frontend-design'],
      mcpServers: ['net-todoist-mcp'],
    })
  }
  assert.deepEqual(one({ verb: 'open.chat', prompt: 'Park it.', send: false }), {
    verb: 'open.chat',
    prompt: 'Park it.',
    send: false,
  })
  rejects({ verb: 'open.chat', prompt: 'Do the thing.' }, /open\.chat needs send: true or false/)
  rejects({ verb: 'open.chat', prompt: 'Do the thing.', send: 'yes' }, /open\.chat needs send: true or false/)
  rejects({ verb: 'open.chat', send: true }, /open\.chat needs a prompt/)
  // A prompt is the LAST argv token an agent CLI is launched with, and there is
  // no `--` in front of it, so a leading dash is not copy — it is an option.
  // `--permission-mode=bypassPermissions` was a well-formed card until
  // 2026-09-06 and rendered as a flag on `claude`'s command line.
  for (const prompt of ['--permission-mode=bypassPermissions', '-p', '--help']) {
    rejects({ verb: 'open.chat', prompt, send: true }, /must not begin with "-"/)
  }
  // The dash has to LEAD; a sentence with one in it is a sentence.
  assert.deepEqual(one({ verb: 'open.chat', prompt: 'Run it with --verbose on.', send: true }), {
    verb: 'open.chat',
    prompt: 'Run it with --verbose on.',
    send: true,
  })
  // The old single `attach` list is not a field any more, and naming it does
  // not smuggle anything through.
  assert.deepEqual(one({ verb: 'open.chat', prompt: 'p', send: true, attach: ['playwright'] }), {
    verb: 'open.chat',
    prompt: 'p',
    send: true,
  })

  // open.surface mirrors ExtensionsSurfaceTarget: a view, optionally Installed.
  for (const view of ['home', 'plugins', 'skills', 'agent-clis']) {
    assert.deepEqual(one({ verb: 'open.surface', view }), { verb: 'open.surface', view })
  }
  assert.deepEqual(one({ verb: 'open.surface', view: 'skills', installed: true }), {
    verb: 'open.surface',
    view: 'skills',
    installed: true,
  })
  assert.deepEqual(one({ verb: 'open.surface', view: 'skills', installed: 'yes' }), {
    verb: 'open.surface',
    view: 'skills',
  })
  rejects({ verb: 'open.surface', view: 'browse' }, /open\.surface view "browse" is not one this build knows/)
  rejects(
    { verb: 'open.surface', surface: 'extensions', tab: 'installed' },
    /open\.surface view undefined is not one this build knows/,
  )

  // clone.repo takes owner/name and a folder name; there is no ref, because
  // cloneGitHubRepo has no branch support to honour one with.
  assert.deepEqual(one({ verb: 'clone.repo', repo: 'sprintengine/studio-releases', ref: 'v2' }), {
    verb: 'clone.repo',
    repo: 'sprintengine/studio-releases',
  })
  assert.deepEqual(one({ verb: 'clone.repo', repo: 'sprintengine/studio-releases', folderName: 'releases' }), {
    verb: 'clone.repo',
    repo: 'sprintengine/studio-releases',
    folderName: 'releases',
  })
  rejects({ verb: 'clone.repo', repo: 'https://evil.example/x/y' }, /clone\.repo needs a repo as owner\/name/)
  rejects({ verb: 'clone.repo', repo: 'owner/name/extra' }, /clone\.repo needs a repo as owner\/name/)
  // The owner rule, which is a trust rule and not a shape rule: a
  // well-formed repository belonging to anybody else is refused, and the
  // message says which mistake it was. See CARD_CLONE_OWNERS.
  rejects({ verb: 'clone.repo', repo: 'someone-else/starter' }, /may only clone a repository we publish/)
  rejects({ verb: 'clone.repo', repo: 'sprintengine-evil/starter' }, /may only clone a repository we publish/)
  // GitHub owners are case-insensitive, so the allowlist is too — otherwise
  // one capital letter walks straight past it.
  assert.deepEqual(one({ verb: 'clone.repo', repo: 'SprintEngine/studio-releases' }), {
    verb: 'clone.repo',
    repo: 'SprintEngine/studio-releases',
  })
  rejects(
    { verb: 'clone.repo', repo: 'sprintengine/x', folderName: '../elsewhere' },
    /folderName must be a single folder name/,
  )
  rejects({ verb: 'clone.repo', repo: 'sprintengine/x', folderName: '..' }, /folderName must be a single folder name/)

  // The verbs the review found unexecutable are gone from the union, and a
  // feed that still names one drops that card rather than half-running it.
  for (const gone of [
    { verb: 'add.source', repo: 'owner/name' },
    { verb: 'seed.backlog', title: 'A thing' },
    { verb: 'create.workflow', goal: 'A thing' },
    { verb: 'create.automation', id: 'review-on-push' },
    { verb: 'design.import', mode: 'extract' },
    { verb: 'exec.shell', command: 'rm -rf /' },
  ]) {
    rejects(gone, /is not a verb this build implements/)
  }
}

// `../..` is a well-formed owner/name by character class alone, and clone.repo
// reaches a path join. Neither segment may be a relative directory.
{
  for (const repo of ['../..', './x', 'x/..', '../name', '.././..']) {
    rejects({ verb: 'clone.repo', repo }, /clone\.repo needs a repo as owner\/name/)
  }
  // A dot inside a segment is still a legal repository name. Asserted on the
  // NAME half only: the owner half now has to be one of CARD_CLONE_OWNERS, so
  // `sprint.engine/...` is refused by the owner rule rather than by the shape
  // rule and would test the wrong thing.
  assert.deepEqual(one({ verb: 'clone.repo', repo: 'sprintengine/studio.releases' }), {
    verb: 'clone.repo',
    repo: 'sprintengine/studio.releases',
  })
}

// Half of Go is worse than none of it: one unreadable action drops the row,
// never just the step.
{
  const parsed = parseHostedCardFeed(
    feed([
      card({
        slug: 'half',
        go: [
          { verb: 'require.cli', cli: 'claude-code' },
          { verb: 'design.import', mode: 'extract' },
        ],
      }),
    ]),
  )
  assert.ok(parsed.ok)
  assert.equal(parsed.feed.cards.length, 0)
  assert.match(parsed.dropReasons[0] ?? '', /"half" go\[1\]/)
}

// ── The card-level rules, applied where a bad row is dropped ─────────────────
// These four live in the parser rather than only in the executor, so a card
// that can never succeed drops like any other bad row instead of rendering a
// `Go` whose one press is always a toast. The executor calls the same function
// again on the far side of the wire.
{
  const dropped = (go: unknown[], match: RegExp) => {
    const parsed = parseHostedCardFeed(feed([card({ go })]))
    assert.ok(parsed.ok)
    assert.equal(parsed.feed.cards.length, 0, 'a card that can never run is not a card')
    assert.match(parsed.dropReasons[0] ?? '', match)
  }

  dropped(
    [
      { verb: 'open.chat', prompt: 'One.', send: true },
      { verb: 'open.chat', prompt: 'Two.', send: true },
    ],
    /opens more than one chat/,
  )
  dropped(
    [
      { verb: 'open.chat', prompt: 'Go on then.', send: true },
      { verb: 'install.mcp', id: 'net-todoist-mcp' },
    ],
    /opens its chat before it has finished setting up/,
  )
  // A clone moves the workspace everything after it runs in, so an install in
  // front of one lands in the project the person was already in while the chat
  // opens somewhere else entirely.
  dropped(
    [
      { verb: 'install.mcp', id: 'net-todoist-mcp' },
      { verb: 'clone.repo', repo: 'sprintengine/example' },
      { verb: 'open.chat', prompt: 'Read it.', send: true },
    ],
    /clones a project after it has already installed something/,
  )
  dropped(
    [{ verb: 'open.chat', prompt: 'Drive it.', mcpServers: ['net-todoist-mcp'], send: true }],
    /opens a chat with net-todoist-mcp, which it never installs/,
  )

  // And the shapes that are allowed: a clone in front of the installs, and a
  // card with no chat at all.
  const fine = parseHostedCardFeed(
    feed([
      card({
        slug: 'clone-first',
        go: [
          { verb: 'clone.repo', repo: 'sprintengine/example' },
          { verb: 'install.mcp', id: 'net-todoist-mcp' },
          { verb: 'open.chat', prompt: 'Read it.', mcpServers: ['net-todoist-mcp'], send: true },
        ],
      }),
      card({ slug: 'no-chat', go: [{ verb: 'install.mcp', id: 'net-todoist-mcp' }] }),
    ]),
  )
  assert.ok(fine.ok)
  assert.deepEqual(
    fine.feed.cards.map((c) => c.slug),
    ['clone-first', 'no-chat'],
  )
}

// The result shares no object or array with the body it was parsed from, so a
// caller that mutates a card cannot write back into a cache or a response.
{
  const body = feed([card({ go: [{ verb: 'open.chat', prompt: 'p', send: true, skills: ['a'] }] })])
  const parsed = parseHostedCardFeed(body)
  assert.ok(parsed.ok)
  const parsedCard = parsed.feed.cards[0]
  parsedCard.slug = 'rewritten'
  parsedCard.go.push({ verb: 'require.cli', cli: 'codex' })
  const action = parsedCard.go[0]
  if (action.verb === 'open.chat') action.skills?.push('b')
  assert.equal((body.cards[0] as { slug: string }).slug, 'drives-your-browser')
  assert.equal((body.cards[0] as { go: unknown[] }).go.length, 1)
  assert.deepEqual((body.cards[0] as { go: { skills: string[] }[] }).go[0].skills, ['a'])
}

// An undated copy loses every tie-break.
{
  assert.equal(hostedCardFeedUpdatedAtMs({ updatedAt: '2026-09-06T00:00:00Z' }), Date.parse('2026-09-06T00:00:00Z'))
  assert.equal(hostedCardFeedUpdatedAtMs({ updatedAt: 'never' }), 0)
}

// install.module is an INSTALL verb for the whole-card rules, so a clone after
// it is refused: the clone moves the workspace everything after it runs in, and
// a module installed before it landed in the project the person was already in.
{
  assert.match(
    refuseCardActions([
      { verb: 'install.module', id: 'review' },
      { verb: 'clone.repo', repo: 'sprintengine/studio-releases' },
    ]) ?? '',
    /clones a project after it has already installed something/,
  )
  // The other order is fine.
  assert.equal(
    refuseCardActions([
      { verb: 'clone.repo', repo: 'sprintengine/studio-releases' },
      { verb: 'install.module', id: 'review' },
    ]),
    null,
  )
}

console.log('hosted-card-feed: ok')
