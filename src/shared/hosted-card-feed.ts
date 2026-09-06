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

// The closed verb set. Every entry is something the studio already does, with
// its arguments constrained to things the app can name for itself: a plugin in a
// source it already trusts, a repository by owner/name, a surface that already
// has an id. This item ships the types and the parser for the whole set; the
// executor honours the subset it can (item 2469), and an action it does not yet
// implement is simply not run — never guessed at.
export type CardAction =
  // Make sure an agent CLI is there, and install it if not. `cli` is a studio
  // plugin id (`claude-code`, `codex`), never a vendor name or a binary path.
  | { verb: 'require.cli'; cli: string }
  // The three installs all name a source the app already holds and an id within
  // it. `source` is a source id ('builtin', a marketplace id, a registered
  // GitHub source) — resolving it is the installer's job, not the card's.
  | { verb: 'install.mcp'; source: string; id: string }
  | { verb: 'install.skill'; source: string; id: string }
  | { verb: 'install.plugin'; source: string; id: string }
  // Add a GitHub source and scan it. `repo` is `owner/name`: a card names a
  // repository, it does not name a URL, so no card can point the scanner at a
  // host of its choosing.
  | { verb: 'add.source'; repo: string }
  | { verb: 'clone.repo'; repo: string; ref?: string }
  // Open a chat with the named tools attached. `send: true` is R4 — Go goes:
  // the prompt is sent, not parked in the composer for somebody to approve.
  | { verb: 'open.chat'; prompt: string; attach?: string[]; send?: boolean }
  | { verb: 'seed.backlog'; title: string; children?: string[] }
  | { verb: 'create.sprint'; goal: string; roster?: string[] }
  | { verb: 'create.workflow'; goal: string; roster?: string[] }
  // Created disabled, for a person to arm. A card never arms an automation:
  // nothing a card sets up may run again without somebody asking for it.
  | { verb: 'create.automation'; id: string }
  | { verb: 'design.import'; mode: 'import' | 'extract' }
  // A door, on a named tab. Both are ids this build already knows.
  | { verb: 'open.surface'; surface: string; tab?: string }

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
    const action = parseAction(entry)
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

function parseAction(raw: unknown): { ok: true; action: CardAction } | { ok: false; message: string } {
  if (!isObject(raw)) return { ok: false, message: 'action must be an object.' }
  const verb = text(raw.verb)
  switch (verb) {
    case 'require.cli': {
      const cli = text(raw.cli)
      return cli ? { ok: true, action: { verb, cli } } : { ok: false, message: 'require.cli needs a cli id.' }
    }
    case 'install.mcp':
    case 'install.skill':
    case 'install.plugin': {
      const source = text(raw.source)
      const id = text(raw.id)
      if (!source || !id) return { ok: false, message: `${verb} needs a source and an id.` }
      return { ok: true, action: { verb, source, id } }
    }
    case 'add.source': {
      const repo = repoName(raw.repo)
      return repo ? { ok: true, action: { verb, repo } } : { ok: false, message: 'add.source needs a repo as owner/name.' }
    }
    case 'clone.repo': {
      const repo = repoName(raw.repo)
      if (!repo) return { ok: false, message: 'clone.repo needs a repo as owner/name.' }
      const ref = text(raw.ref)
      return { ok: true, action: ref ? { verb, repo, ref } : { verb, repo } }
    }
    case 'open.chat': {
      const prompt = text(raw.prompt)
      if (!prompt) return { ok: false, message: 'open.chat needs a prompt.' }
      const action: Extract<CardAction, { verb: 'open.chat' }> = { verb, prompt }
      const attach = stringList(raw.attach)
      if (attach) action.attach = attach
      if (raw.send === true) action.send = true
      return { ok: true, action }
    }
    case 'seed.backlog': {
      const title = text(raw.title)
      if (!title) return { ok: false, message: 'seed.backlog needs a title.' }
      const action: Extract<CardAction, { verb: 'seed.backlog' }> = { verb, title }
      const children = stringList(raw.children)
      if (children) action.children = children
      return { ok: true, action }
    }
    case 'create.sprint':
    case 'create.workflow': {
      const goal = text(raw.goal)
      if (!goal) return { ok: false, message: `${verb} needs a goal.` }
      const action: Extract<CardAction, { verb: 'create.sprint' | 'create.workflow' }> = { verb, goal }
      const roster = stringList(raw.roster)
      if (roster) action.roster = roster
      return { ok: true, action }
    }
    case 'create.automation': {
      const id = text(raw.id)
      return id ? { ok: true, action: { verb, id } } : { ok: false, message: 'create.automation needs an id.' }
    }
    case 'design.import': {
      const mode = text(raw.mode)
      if (mode !== 'import' && mode !== 'extract') return { ok: false, message: 'design.import mode must be import or extract.' }
      return { ok: true, action: { verb, mode } }
    }
    case 'open.surface': {
      const surface = text(raw.surface)
      if (!surface) return { ok: false, message: 'open.surface needs a surface id.' }
      const tab = text(raw.tab)
      return { ok: true, action: tab ? { verb, surface, tab } : { verb, surface } }
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
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : ''
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
