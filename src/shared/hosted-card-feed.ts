// The hosted card feed: `cards-feed.json` at the root of the public
// sprintengine/studio-releases repo, built by CI from the one-directory-per-card
// repository, fetched raw by every running studio and rendered as the Extensions
// home page. It is how a card reaches every install without an app release —
// the same mechanism the model feed already proved
// (backlog/2026-09-06-the-card-feed-is-a-hosted-file.md, item 2465).
//
// A card travels as data and never as code. It carries copy, the *name* of an
// artwork this build already ships, and an ordered list of actions drawn from a
// closed vocabulary of verbs the studio already implements. A card may name an
// action; it may not bring one. That is why there is no exec verb, no verb that
// writes a file, and no field anywhere below that holds a URL: a hostile copy of
// this feed can at worst propose a bad plugin, which is the blast radius the
// plugin catalogue already has.
//
// Node-free on purpose: `src/shared` cannot import `src/main` (TS6307). The
// fetcher, cache, and seed live in src/main/hosted-feed/card-feed-client.ts.
//
// The schema is a permanent contract: builds that are years old will keep
// reading it. Add fields; never remove or repurpose one. A body whose
// `schemaVersion` is not one this build knows is rejected whole and the client
// keeps its last good copy — but a single malformed card is dropped and
// counted, because one bad row must never blank the home page.

export const HOSTED_CARD_FEED_SCHEMA_VERSION = 1 as const

export const HOSTED_CARD_FEED_URL =
  'https://raw.githubusercontent.com/sprintengine/studio-releases/main/cards-feed.json'

// What the card is, which is also the word on its stamp. Not a taxonomy to
// filter by — the home page is marketing, not a catalogue — but the renderer
// needs to know whether it is showing an MCP server or a showcase.
export type HostedCardKind = 'mcp' | 'skill' | 'plugin' | 'workflow' | 'sprint' | 'automation' | 'showcase'

const CARD_KINDS: readonly HostedCardKind[] = ['mcp', 'skill', 'plugin', 'workflow', 'sprint', 'automation', 'showcase']

// The Extensions views a card may open. The last three are exactly
// `EXTENSIONS_DRAWER_VIEWS` in the renderer's extensionsSurfaceTarget.ts, and
// `home` is the card feed's own tab beside them. Restated here rather than
// imported because src/shared may not reach into the renderer; if a fourth view
// is ever added to the door, it is added here too, never renamed.
export type CardSurfaceView = 'home' | 'plugins' | 'skills' | 'agent-clis'

const CARD_SURFACE_VIEWS: readonly CardSurfaceView[] = ['home', 'plugins', 'skills', 'agent-clis']

// The closed verb set, and it is closed against the call sites rather than
// against an imagination of them. The first cut of this union carried thirteen
// verbs, nine of which no installer in this repository could execute:
// `add.source`, `seed.backlog`, `create.sprint`, `create.workflow`,
// `create.automation` and `design.import` named nothing, and the four that
// remained were shaped wrong — `install.mcp` carried a source the catalogue does
// not have, `clone.repo` a `ref` git-clone does not take, `open.chat` one
// attachment list where the composer keeps two, and `open.surface` a
// surface/tab pair the door stopped speaking in September. A schema is a
// permanent forward-compatible contract, so shipping a fictional vocabulary is
// worse than shipping a small true one: adding a verb later is cheap and
// additive, while un-shipping one is a breaking change to every build in the
// field. Each verb below is a call this repository already makes.
//
// **No action carries a workspace, deliberately.** A card runs in the workspace
// the person is already in, and the executor supplies it — a card that could
// name a workspace could reach into a project the person was not looking at.
// `clone.repo` is the one verb that makes a new one, and everything after it in
// the same card runs in that.
export type CardAction =
  // Make sure an agent CLI is there, and install it if not. `cli` is a plugin id
  // under `resources/plugins/` (`claude-code`, `codex`), never a vendor name or
  // a binary path.
  | { verb: 'require.cli'; cli: string }
  // A server from the bundled MCP catalogue, by its catalogue id — reverse-DNS,
  // as `resources/mcps/catalog.json` writes them
  // (`io-github-domdomegg-gmail-mcp`). There is NO source dimension:
  // `mcpConfigService.listCatalog()` reads one bundled file and there is nowhere
  // else an MCP server comes from, so a `source` field would be a parameter with
  // exactly one legal value — and the first cut's `"source": "builtin"` named a
  // source id that no longer exists.
  | { verb: 'install.mcp'; id: string }
  // A skill and a plugin each name a source the app already holds and an id
  // within it. `source` is a source id as src/shared/skills.ts mints them:
  // `github:owner/name` or `local:<absolute path>` — `builtin` is gone. For a
  // skill, `id` is a `ScannedSkill.id`, which is the skill directory's path
  // relative to its source (`studio-skills/skills/debug`).
  | { verb: 'install.skill'; source: string; id: string }
  // For a plugin, `id` is the plugin's name in its source's marketplace
  // manifest. The card carries nothing else: `installPlugin` also wants
  // `marketplaceName`, `marketplaceRepo` and `commitSha`, and the executor
  // resolves all three from that source's scan at run time. A card that carried
  // them would be carrying facts that go stale the moment the marketplace is
  // republished, and a stale commitSha installs the wrong bytes.
  | { verb: 'install.plugin'; source: string; id: string }
  // Open a chat with the named tools attached and the prompt sent. Two lists and
  // not one because the composer draft keeps them apart (newChatDraft.ts:
  // `skills: WorkspaceSkill[]` beside `mcpServers: AgentComposerConnector[]`),
  // and a flat list could not say which an entry was. `skills` names installed
  // skills by directory name — a `WorkspaceSkill.id`; `mcpServers` names
  // catalogue ids. `send` is required rather than optional: R4 is "Go goes", and
  // an unstated `send` leaves the reader guessing whether the card meant to park
  // its prompt in the composer for somebody to approve.
  | { verb: 'open.chat'; prompt: string; skills?: string[]; mcpServers?: string[]; send: boolean }
  // A door, on one of the Extensions views. Mirrors `ExtensionsSurfaceTarget`
  // exactly: a view, and optionally its Installed tab. The pair it replaces
  // (`surface` + `tab`) was the vocabulary of a surface that no longer exists.
  | { verb: 'open.surface'; view: CardSurfaceView; installed?: boolean }
  // Clone a public GitHub repository and open it. `repo` is `owner/name`: a card
  // names a repository, never a URL, so no card can point git at a host of its
  // choosing. `folderName` is the single directory name to clone into, and the
  // executor supplies `parentDir` — where this app keeps projects is the app's
  // business, not a card's. There is no `ref`, because `cloneGitHubRepo` takes
  // `{ url, parentDir, folderName }` and has no branch or tag support: a `ref`
  // field would be a promise the installer cannot keep.
  | { verb: 'clone.repo'; repo: string; folderName?: string }

export type CardActionVerb = CardAction['verb']

export type HostedCard = {
  // Stable for the life of the card: the directory name in the cards repo, and
  // the key the renderer counts a press against.
  slug: string
  kind: HostedCardKind
  // A capability in the second person, never a product name — "Let an agent
  // drive your browser", not "Playwright MCP server" (epic ruling R2).
  title: string
  dek: string
  // The quiet line under the dek: what it is built on, in words a person
  // recognises. Optional because a showcase often has nothing to credit.
  credit?: string
  // The NAME of an artwork this build ships ('browser', 'city', 'tokens'),
  // never a URL. A card with no picture is not a card, so this is required and
  // a row without it is dropped.
  art: string
  // ISO date the card was published. The home page orders by it.
  publishedAt: string
  // The one full-bleed card at the top of the page. More than one is allowed by
  // the schema; which of them leads is the renderer's business.
  hero?: boolean
  // What Go does, in order. An empty list is legal — a showcase card can be
  // pure marketing — so it is not a reason to drop the row.
  go: CardAction[]
}

export type HostedCardFeed = {
  schemaVersion: typeof HOSTED_CARD_FEED_SCHEMA_VERSION
  // Bumped on every edit. The tie-break between a bundled seed and a disk
  // cache: whichever was edited later wins, regardless of when it was fetched.
  updatedAt: string
  cards: HostedCard[]
}

export type HostedCardFeedParseResult =
  | {
      ok: true
      feed: HostedCardFeed
      // How many rows were dropped for failing their own shape, and why. The
      // feed still renders; the count is what a diagnostic line reports.
      dropped: number
      dropReasons: string[]
    }
  | { ok: false; message: string }

export function parseHostedCardFeed(source: unknown): HostedCardFeedParseResult {
  let value: unknown = source
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source)
    } catch (error) {
      return { ok: false, message: `Card feed is not valid JSON. ${formatError(error)}` }
    }
  }
  if (!isObject(value)) return { ok: false, message: 'Card feed must be a JSON object.' }
  if (value.schemaVersion !== HOSTED_CARD_FEED_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `Card feed schemaVersion ${JSON.stringify(value.schemaVersion)} is not one this build reads (${HOSTED_CARD_FEED_SCHEMA_VERSION}).`,
    }
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return { ok: false, message: 'Card feed updatedAt must be an ISO date-time.' }
  }
  if (!Array.isArray(value.cards)) return { ok: false, message: 'Card feed cards must be an array.' }

  const cards: HostedCard[] = []
  const dropReasons: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.cards.entries()) {
    const parsed = parseCard(raw)
    if (!parsed.ok) {
      dropReasons.push(`cards[${index}]: ${parsed.message}`)
      continue
    }
    // A duplicate slug is a mistake in the cards repo, not a reason to blank
    // the page: the first one wins and the second is dropped like any other
    // bad row.
    if (seen.has(parsed.card.slug)) {
      dropReasons.push(`cards[${index}]: duplicate slug "${parsed.card.slug}".`)
      continue
    }
    seen.add(parsed.card.slug)
    cards.push(parsed.card)
  }
  return {
    ok: true,
    feed: { schemaVersion: HOSTED_CARD_FEED_SCHEMA_VERSION, updatedAt: value.updatedAt, cards },
    dropped: dropReasons.length,
    dropReasons,
  }
}

// Every field is copied out of the input, never referenced into it: the result
// shares no object or array with the body it was parsed from, so a caller that
// mutates a card cannot reach back into the cache or the response.
function parseCard(raw: unknown): { ok: true; card: HostedCard } | { ok: false; message: string } {
  if (!isObject(raw)) return { ok: false, message: 'row must be an object.' }
  const slug = text(raw.slug)
  if (!slug) return { ok: false, message: 'slug must be a non-empty string.' }
  const kind = text(raw.kind)
  if (!kind || !CARD_KINDS.includes(kind as HostedCardKind)) {
    return { ok: false, message: `"${slug}" has kind ${JSON.stringify(raw.kind)}, which is not one this build knows.` }
  }
  const title = text(raw.title)
  if (!title) return { ok: false, message: `"${slug}" has no title.` }
  const dek = text(raw.dek)
  if (!dek) return { ok: false, message: `"${slug}" has no dek.` }
  const art = text(raw.art)
  // Artwork is a name the app ships. Anything with a scheme or a slash is
  // somebody trying to serve a picture from their own host.
  if (!art || /[:/\\]/.test(art)) {
    return { ok: false, message: `"${slug}" must name artwork this build ships, not a URL.` }
  }
  const publishedAt = text(raw.publishedAt)
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) {
    return { ok: false, message: `"${slug}" has no publishedAt date.` }
  }
  if (!Array.isArray(raw.go)) return { ok: false, message: `"${slug}" has no go list.` }

  const go: CardAction[] = []
  for (const [index, entry] of raw.go.entries()) {
    const action = parseCardAction(entry)
    // An action this build cannot read makes the whole card untrustworthy: half
    // of Go is worse than none of it, so the row goes rather than the step.
    if (!action.ok) return { ok: false, message: `"${slug}" go[${index}]: ${action.message}` }
    go.push(action.action)
  }

  const card: HostedCard = { slug, kind: kind as HostedCardKind, title, dek, art, publishedAt, go }
  const credit = text(raw.credit)
  if (credit) card.credit = credit
  if (raw.hero === true) card.hero = true
  return { ok: true, card }
}

/**
 * One action, parsed and copied out of whatever it was read from.
 *
 * Exported because the feed is not the only place an action is read: `cards:run`
 * gets its list back from the renderer and puts it through this same function
 * again before the executor touches it (item 2469). One parser, two boundaries —
 * a second hand-written check on the main side would be the thing that drifts.
 */
export function parseCardAction(raw: unknown): { ok: true; action: CardAction } | { ok: false; message: string } {
  if (!isObject(raw)) return { ok: false, message: 'action must be an object.' }
  const verb = text(raw.verb)
  switch (verb) {
    case 'require.cli': {
      const cli = text(raw.cli)
      return cli ? { ok: true, action: { verb, cli } } : { ok: false, message: 'require.cli needs a cli id.' }
    }
    case 'install.mcp': {
      const id = text(raw.id)
      return id ? { ok: true, action: { verb, id } } : { ok: false, message: 'install.mcp needs a catalogue id.' }
    }
    case 'install.skill':
    case 'install.plugin': {
      const source = text(raw.source)
      const id = text(raw.id)
      if (!source || !id) return { ok: false, message: `${verb} needs a source and an id.` }
      return { ok: true, action: { verb, source, id } }
    }
    case 'open.chat': {
      const prompt = text(raw.prompt)
      if (!prompt) return { ok: false, message: 'open.chat needs a prompt.' }
      // Required, and required to be a boolean: a card that forgets to say
      // whether Go sends the prompt is a card nobody can read, and defaulting
      // either way would put words in the author's mouth.
      if (typeof raw.send !== 'boolean') return { ok: false, message: 'open.chat needs send: true or false.' }
      const action: Extract<CardAction, { verb: 'open.chat' }> = { verb, prompt, send: raw.send }
      const skills = stringList(raw.skills)
      if (skills) action.skills = skills
      const mcpServers = stringList(raw.mcpServers)
      if (mcpServers) action.mcpServers = mcpServers
      return { ok: true, action }
    }
    case 'open.surface': {
      const view = text(raw.view)
      if (!CARD_SURFACE_VIEWS.includes(view as CardSurfaceView)) {
        return { ok: false, message: `open.surface view ${JSON.stringify(raw.view)} is not one this build knows.` }
      }
      const action: Extract<CardAction, { verb: 'open.surface' }> = { verb, view: view as CardSurfaceView }
      if (raw.installed === true) action.installed = true
      return { ok: true, action }
    }
    case 'clone.repo': {
      const repo = repoName(raw.repo)
      if (!repo) return { ok: false, message: 'clone.repo needs a repo as owner/name.' }
      const folderName = text(raw.folderName)
      // One segment, and never a relative directory: the executor joins this
      // onto the app's projects directory, which is the same gate
      // `cloneGitHubRepo` puts on its own `folderName`.
      if (folderName && (folderName === '.' || folderName === '..' || /[/\\]/.test(folderName))) {
        return { ok: false, message: 'clone.repo folderName must be a single folder name.' }
      }
      return { ok: true, action: folderName ? { verb, repo, folderName } : { verb, repo } }
    }
    default:
      return { ok: false, message: `${JSON.stringify(raw.verb)} is not a verb this build implements.` }
  }
}

// Epoch millis of `updatedAt`, or 0 when unparsable: an undated copy loses
// every tie-break.
export function hostedCardFeedUpdatedAtMs(feed: Pick<HostedCardFeed, 'updatedAt'>): number {
  const parsed = Date.parse(feed.updatedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// `owner/name`, and nothing else: no scheme, no host, no path beyond the two
// segments. A card names a repository; it does not name a URL.
function repoName(value: unknown): string {
  const repo = text(value)
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return ''
  // The character class admits `.` and `..`, so `../..` is a well-formed
  // owner/name by that rule alone — and `clone.repo` hands the pair to a path
  // join. Neither segment may be a relative directory.
  return repo.split('/').some((segment) => segment === '.' || segment === '..') ? '' : repo
}

// A fresh array of trimmed strings, or null when the field was absent or held
// anything that was not a list of strings.
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const entry of value) {
    const item = text(entry)
    if (item) out.push(item)
  }
  return out.length > 0 ? out : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
