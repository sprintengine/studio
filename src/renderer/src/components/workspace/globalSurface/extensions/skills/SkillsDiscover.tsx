// Discover: where a source comes from when the user does not already have a
// repository in mind.
//
// Two tabs, answering two different questions. **Most starred** is repository
// search over the skill topics — it matches a repo's name, description and
// README, so it finds repos that *mention* a capability. It is a stars sort,
// which is the only ordering GitHub offers, so it is labelled as one and never
// as "trending". **Search** is code search inside SKILL.md files, so it finds
// skills that *do* the thing — including skills vendored in repos that are not
// skill collections at all, which repo search would never surface.
//
// Code search costs ten requests a minute, so a keystroke is not a request:
// nothing goes below three characters, and a burst coalesces into one request
// after ~700ms of quiet (`createSkillSearchScheduler`, proven under a fake
// clock in skillsSurfaceModel.test.ts).
//
// A hit is a candidate, not a source. A row shows only what GitHub returned —
// repository, stars, description — and never a skill count: stars do not
// predict one (a 52k-star repo holds a single skill, a 4.9k-star one holds
// 103), and only a scan can derive it. Scan hands the repository to the same
// Add-a-source flow a pasted URL takes.

import React, { useCallback, useEffect, useRef, useState } from 'react'

import type {
  SkillDiscoveryResult,
  SkillRepoHit,
  SkillSearchHit,
} from '../../../../../../../shared/skills'
import {
  Badge,
  EmptyState,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  OutlineButton,
  Section,
  SegmentedControl,
  Spinner,
  StarGlyph,
} from '../../../../ui'
import { FOCUS_RING_INSET_CLASS } from '../../../../ui/tokens'

import {
  createSkillSearchScheduler,
  describeSearchBudget,
  discoverNoticeTone,
  formatStars,
  isRepoAdded,
  POPULAR_REPOS_EMPTY_LINE,
  skillSearchEmptyLine,
  type SkillSearchIntent,
  type SkillSearchScheduler,
} from './discoverModel'

const MISSING_API_MESSAGE = 'Skills need an app restart before they are available.'

type DiscoverTab = 'starred' | 'search'

/** `query` is the one the results belong to, so rows are never labelled with a
 *  query the user has since typed past. '' for a list that has no query. */
export type DiscoverLoad<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; query: string; result: SkillDiscoveryResult<T> }
  | { status: 'error'; message: string }

export function SkillsDiscover({
  addedRepos,
  onScanRepo,
  onConfigureToken,
}: {
  /** Lowercased `owner/name` of every repository already in the source list. */
  addedRepos: ReadonlySet<string>
  /** Hands a candidate to the Add-a-source flow, pre-filled. */
  onScanRepo: (repo: string) => void
  /** Opens where the GitHub token is configured — code search requires one. */
  onConfigureToken: () => void
}): JSX.Element {
  const [tab, setTab] = useState<DiscoverTab>('starred')
  const [query, setQuery] = useState('')
  const [intent, setIntent] = useState<SkillSearchIntent>({ kind: 'empty' })
  const [repos, setRepos] = useState<DiscoverLoad<SkillRepoHit>>({ status: 'idle' })
  const [hits, setHits] = useState<DiscoverLoad<SkillSearchHit>>({ status: 'idle' })

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // The query a result must still belong to. A slow search overtaken by a
  // faster later one must not land its rows under the newer query.
  const awaiting = useRef('')

  const runSearch = useCallback(async (terms: string): Promise<void> => {
    if (typeof window.api.skillsSearch !== 'function') {
      setHits({ status: 'error', message: MISSING_API_MESSAGE })
      return
    }
    awaiting.current = terms
    setHits({ status: 'loading' })
    try {
      const result = await window.api.skillsSearch({ query: terms })
      if (!mounted.current || awaiting.current !== terms) return
      setHits({ status: 'ready', query: terms, result })
    } catch (error) {
      if (!mounted.current || awaiting.current !== terms) return
      setHits({ status: 'error', message: describe(error) })
    }
  }, [])

  const scheduler = useRef<SkillSearchScheduler | null>(null)
  if (scheduler.current === null) {
    scheduler.current = createSkillSearchScheduler({ onSearch: (terms) => void runSearch(terms) })
  }

  // Re-fed on entering the tab as well as on every keystroke: a query armed and
  // then abandoned by leaving the tab must not come back as a spinner over a
  // request nobody is going to make.
  useEffect(() => {
    if (tab !== 'search') return
    setIntent(scheduler.current!.type(query))
  }, [query, tab])

  useEffect(() => () => scheduler.current?.cancel(), [])

  const loadRepos = useCallback(async (): Promise<void> => {
    if (typeof window.api.skillsListPopularRepos !== 'function') {
      setRepos({ status: 'error', message: MISSING_API_MESSAGE })
      return
    }
    setRepos({ status: 'loading' })
    try {
      const result = await window.api.skillsListPopularRepos()
      if (!mounted.current) return
      setRepos({ status: 'ready', query: '', result })
    } catch (error) {
      if (!mounted.current) return
      setRepos({ status: 'error', message: describe(error) })
    }
  }, [])

  // The starred list is one request and the main process caches it, so it loads
  // on arrival rather than behind a button that would only ask twice.
  useEffect(() => {
    if (tab === 'starred' && repos.status === 'idle') void loadRepos()
  }, [tab, repos.status, loadRepos])

  const changeTab = useCallback((next: DiscoverTab) => {
    // An armed search does not survive leaving the tab that typed it.
    if (next !== 'search') scheduler.current?.cancel()
    setTab(next)
  }, [])

  return (
    <div className="min-w-0">
      <h3 className="text-title font-semibold text-[color:var(--text-strong)]">Discover skills</h3>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <SegmentedControl<DiscoverTab>
          ariaLabel="What to search on GitHub"
          size="sm"
          items={[
            { value: 'starred', label: 'Most starred' },
            { value: 'search', label: 'Search' },
          ]}
          value={tab}
          onChange={changeTab}
        />
        {tab === 'search' ? (
          <div className="flex min-w-[220px] max-w-[340px] flex-1">
            <InboxSearchInput
              value={query}
              onChange={setQuery}
              autoFocus
              ariaLabel="Search inside skill files on GitHub"
              placeholder="What should the skill do?"
            />
          </div>
        ) : null}
      </div>

      {tab === 'starred' ? (
        <DiscoverRepoList
          load={repos}
          addedRepos={addedRepos}
          onScanRepo={onScanRepo}
          onRetry={() => void loadRepos()}
          onConfigureToken={onConfigureToken}
        />
      ) : (
        <DiscoverSearchResults
          load={hits}
          intent={intent}
          addedRepos={addedRepos}
          onScanRepo={onScanRepo}
          onRetry={() => {
            if (awaiting.current) void runSearch(awaiting.current)
          }}
          onConfigureToken={onConfigureToken}
        />
      )}
    </div>
  )
}

/** The browse tab's list. Exported so its states are rendered directly in tests. */
export function DiscoverRepoList({
  load,
  addedRepos,
  onScanRepo,
  onRetry,
  onConfigureToken,
}: {
  load: DiscoverLoad<SkillRepoHit>
  addedRepos: ReadonlySet<string>
  onScanRepo: (repo: string) => void
  onRetry: () => void
  onConfigureToken: () => void
}): JSX.Element {
  if (load.status === 'idle' || load.status === 'loading') return <Loading label="Reading GitHub…" />
  if (load.status === 'error') {
    return (
      <div className="mt-4">
        <InlineNotice
          tone="error"
          title="GitHub could not be reached."
          hint="Nothing is listed — this is not an empty result."
          detail={load.message}
          action={<GhostButton onClick={onRetry}>Try again</GhostButton>}
        />
      </div>
    )
  }

  const { results, degraded, rateLimit } = load.result
  // A missing token costs this tab only the manifest-carrying repositories —
  // the stars half answered — so it is disclosed as the fact it is, not as the
  // failure it would be on the tab that cannot search without one.
  const tokenOnlyGap = degraded?.reason === 'needs_token' && results.length > 0
  return (
    <>
      {tokenOnlyGap ? (
        <p className="mt-3 text-meta text-[color:var(--text-subtle)]">
          Without a GitHub token this list is stars only — repositories carrying a plugin manifest are
          not included.
        </p>
      ) : (
        <Condition condition={degraded} onConfigureToken={onConfigureToken} onRetry={onRetry} />
      )}
      <Section
        // `flush`: the hit rows draw from x=0, so the header takes no inset the
        // rows do not have.
        inset="flush"
        level={4}
        title="Most starred"
        count={results.length}
        action={
          <span className="text-meta text-[color:var(--text-subtle)]">
            {tokenOnlyGap ? 'Sorted by stars' : 'Repositories carrying a plugin manifest first, then stars'}
          </span>
        }
      >
        {results.length === 0 ? (
          <EmptyState title={degraded ? 'Nothing was returned for this list.' : POPULAR_REPOS_EMPTY_LINE} />
        ) : (
          <div role="list" className="mt-1.5 flex flex-col gap-0.5">
            {results.map((hit) => (
              <div role="listitem" key={hit.repo}>
                <RepoHitRow
                  hit={hit}
                  added={isRepoAdded(addedRepos, hit.repo)}
                  onScan={() => onScanRepo(hit.repo)}
                />
              </div>
            ))}
          </div>
        )}
        <Budget rateLimit={rateLimit} />
      </Section>
    </>
  )
}

/** The search tab's list, in every state it can be in. Exported for the same reason. */
export function DiscoverSearchResults({
  load,
  intent,
  addedRepos,
  onScanRepo,
  onRetry,
  onConfigureToken,
}: {
  load: DiscoverLoad<SkillSearchHit>
  intent: SkillSearchIntent
  addedRepos: ReadonlySet<string>
  onScanRepo: (repo: string) => void
  /** Runs the last query again — a limit that has reset, or a network blip. */
  onRetry: () => void
  onConfigureToken: () => void
}): JSX.Element {
  if (intent.kind === 'empty') {
    return (
      <EmptyState title="Code search reads inside SKILL.md, so “extract text from PDFs” finds the skills that do it." />
    )
  }
  if (intent.kind === 'too_short') {
    return <EmptyState title={`Type at least ${intent.minLength} characters.`} />
  }
  // Armed but not yet sent is still "about to search" from here; the request
  // follows within the quiet window, and a second state for it would flicker.
  if (load.status === 'idle' || load.status === 'loading') return <Loading label="Searching GitHub…" />
  if (load.status === 'error') {
    return (
      <div className="mt-4">
        <InlineNotice
          tone="error"
          title="That search did not run."
          hint="Nothing was returned — this is not an empty result."
          detail={load.message}
          action={<GhostButton onClick={onRetry}>Try again</GhostButton>}
        />
      </div>
    )
  }

  const { results, degraded, rateLimit } = load.result
  return (
    <>
      <Condition condition={degraded} onConfigureToken={onConfigureToken} onRetry={onRetry} />
      {degraded?.reason === 'needs_token' ? null : (
        // Labelled with the query the rows actually belong to, so results
        // still on screen while a newer query is being typed say so.
        <Section
          inset="flush"
          level={4}
          title={`Results for “${load.query}”`}
          count={results.length}
          action={
            <span className="text-meta text-[color:var(--text-subtle)]">
              Skills, not repositories — GitHub&apos;s own relevance order
            </span>
          }
        >
          {results.length === 0 ? (
            <EmptyState
              title={degraded ? 'Nothing was returned for this search.' : skillSearchEmptyLine(load.query)}
            />
          ) : (
            <div role="list" className="mt-1.5 flex flex-col gap-0.5">
              {results.map((hit) => (
                <div role="listitem" key={`${hit.repo}/${hit.path}`}>
                  <SearchHitRow
                    hit={hit}
                    added={isRepoAdded(addedRepos, hit.repo)}
                    onScan={() => onScanRepo(hit.repo)}
                  />
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
      <Budget rateLimit={rateLimit} />
    </>
  )
}

/**
 * One result row: two siblings in a container, never a button inside a button.
 * The body opens what GitHub returned — the only way to read a candidate before
 * it is scanned — and the trailing action hands it to Add a source.
 */
function HitRow({
  href,
  openLabel,
  repo,
  body,
  added,
  onScan,
}: {
  href: string
  openLabel: string
  /** Names both trailing states, so a row of identical "Scan" buttons is not
   *  what a screen reader hears. */
  repo: string
  body: React.ReactNode
  added: boolean
  onScan: () => void
}): JSX.Element {
  return (
    <div className="flex items-stretch rounded-md transition-colors hover:bg-[color:var(--bg-hover)]">
      <button
        type="button"
        aria-label={openLabel}
        onClick={() => void window.api.openExternal(href)}
        // Inset ring: the target sits flush inside the row's fill, so an
        // outset ring would collide with the neighbouring rows' fills.
        className={`flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left ${FOCUS_RING_INSET_CLASS}`}
      >
        {body}
      </button>
      <div className="flex shrink-0 items-center pr-1.5">
        {added ? (
          <span className="px-2 text-meta text-[color:var(--text-muted)]">
            Added<span className="sr-only">{` — ${repo} is already one of your sources`}</span>
          </span>
        ) : (
          <OutlineButton size="xs" aria-label={`Scan ${repo}`} onClick={onScan}>
            Scan
          </OutlineButton>
        )}
      </div>
    </div>
  )
}

function RepoHitRow({
  hit,
  added,
  onScan,
}: {
  hit: SkillRepoHit
  added: boolean
  onScan: () => void
}): JSX.Element {
  return (
    <HitRow
      href={hit.htmlUrl}
      openLabel={`Open ${hit.repo} on GitHub`}
      repo={hit.repo}
      added={added}
      onScan={onScan}
      body={
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-body font-medium text-[color:var(--text-strong)]">
              {hit.repo}
            </span>
            {hit.description ? (
              <span className="truncate text-meta text-[color:var(--text-muted)]">{hit.description}</span>
            ) : null}
          </span>
          {hit.curated ? (
            // The kit's label badge. What "Manifest" means is stated once, in
            // the list head above ("Repositories carrying a plugin manifest
            // first") — never a native `title=` on a span the keyboard could
            // not reach, and no longer a twelve-word sentence pushed into the
            // row's accessible name through `ariaLabel`, which made every
            // manifest row read its own footnote. The visible word is the name.
            <Badge tone="neutral" className="shrink-0">
              Manifest
            </Badge>
          ) : null}
          {/* Never a zero: a repository the search returned without a star
              count has an unknown one, and 0 is a different fact. */}
          {hit.stars === null ? null : (
            <span className="flex shrink-0 items-center gap-1 text-meta tabular-nums text-[color:var(--text-subtle)]">
              <StarGlyph filled className="h-2.5 w-2.5" />
              {formatStars(hit.stars)}
              <span className="sr-only"> stars</span>
            </span>
          )}
        </>
      }
    />
  )
}

function SearchHitRow({
  hit,
  added,
  onScan,
}: {
  hit: SkillSearchHit
  added: boolean
  onScan: () => void
}): JSX.Element {
  return (
    <HitRow
      href={hit.htmlUrl}
      openLabel={`Open ${hit.path} in ${hit.repo} on GitHub`}
      repo={hit.repo}
      added={added}
      onScan={onScan}
      body={
        <>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-medium text-[color:var(--text-strong)]">
              {hit.name}
            </span>
            {hit.description ? (
              <span className="truncate text-meta text-[color:var(--text-muted)]">{hit.description}</span>
            ) : null}
          </span>
          <span className="shrink-0 truncate font-mono text-meta text-[color:var(--text-subtle)]">
            {hit.repo}
          </span>
        </>
      }
    />
  )
}

/** What GitHub could not do, stated. Never an empty list left to speak for it. */
function Condition({
  condition,
  onConfigureToken,
  onRetry,
}: {
  condition: SkillDiscoveryResult<unknown>['degraded']
  onConfigureToken: () => void
  onRetry: () => void
}): JSX.Element | null {
  if (!condition) return null
  const needsToken = condition.reason === 'needs_token'
  return (
    <div className="mt-4">
      <InlineNotice
        tone={discoverNoticeTone(condition)}
        title={condition.message}
        hint={
          needsToken
            ? 'GitHub requires a token to search inside files. The most starred list works without one.'
            : undefined
        }
        action={
          needsToken ? (
            <GhostButton onClick={onConfigureToken}>Add a GitHub token</GhostButton>
          ) : (
            <GhostButton onClick={onRetry}>Try again</GhostButton>
          )
        }
      />
    </div>
  )
}

function Budget({ rateLimit }: { rateLimit: SkillDiscoveryResult<unknown>['rateLimit'] }): JSX.Element | null {
  const line = describeSearchBudget(rateLimit)
  return line ? <p className="mt-2 text-meta text-[color:var(--text-subtle)]">{line}</p> : null
}

function Loading({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-8 text-body text-[color:var(--text-muted)]">
      <Spinner size={14} />
      {label}
    </div>
  )
}


function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
