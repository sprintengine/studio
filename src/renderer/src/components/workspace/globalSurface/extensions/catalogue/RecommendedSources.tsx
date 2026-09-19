// Recommended sources: the places to get skills and plugins, offered one click
// from where a person manages the sources they already have (owner
// ruling 2026-09-08).
//
// The studio used to ship other people's software — a bundled catalogue of
// sixteen MCP servers and three vendored third-party plugins. It ships none of
// them now, and the replacement is not a smaller catalogue: it is a list of
// *sources*, published as `sources.json` in the releases repository and read by
// `src/main/hosted-feed/sources-feed-client.ts`. We recommend places; we do not
// host their contents, and adding one is the person's decision.
//
// This is a region in front of the add path, never a second installer: the Add
// button calls the same `skills:add-source` the "Add from GitHub…" modal calls,
// with the same repository string, so a source added here is byte-identical to
// one added by typing it. What this region contributes is that the person did
// not have to know the repository's name.
//
// What is offered is what the feed lists MINUS what this studio already has —
// the two always-present sources included, since `listSources` returns those
// first and the store refuses to remove them. The de-duplication is
// `recommendedSourcesToAdd`, shared with the seed gate, and it keys on the id
// `addSource` would mint (`github:owner/name`), case-folded, so a
// recommendation and its installed copy can never be keyed differently.
//
// A feed that could not be read shows nothing at all. That is not a degraded
// state to apologise for: it is exactly what this surface showed before the
// feed existed, and a person who knows a repository can still type it in.

import React, { useCallback, useEffect, useState } from 'react'

import type { HostedSource } from '../../../../../../../shared/electron-api'
import { recommendedSourcesToAdd } from '../../../../../../../shared/hosted-sources-feed'
import { skillSourceMonogram, type SkillSource } from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, SettingCard, Spinner } from '../../../../ui'
import { ConnectorRow, ConnectorSectionHeading } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { SourceMonogram } from '../skills/SourceMonogram'

/** What a recommendation's `kind` is called on the row. */
const KIND_LABEL: Record<HostedSource['kind'], string> = {
  'claude-marketplace': 'Marketplace',
  skills: 'Skills',
}

/**
 * The recommendations still worth offering here, given the sources this studio
 * already holds. Exported for its test: the feed read is asynchronous and the
 * subtraction is the part with a rule in it.
 */
export function offerableRecommendations(
  feed: { sources: HostedSource[] } | null,
  existing: readonly Pick<SkillSource, 'id'>[],
): HostedSource[] {
  return recommendedSourcesToAdd(
    feed,
    existing.map((source) => source.id),
  )
}

type FeedLoad =
  | { status: 'loading' }
  | { status: 'ready'; sources: HostedSource[] }
  // Unreadable is not shown: see the file comment. The state exists so the
  // component can stop rendering rather than hang on a spinner forever.
  | { status: 'unavailable' }

export function RecommendedSources({
  existingSources,
  onAdded,
}: {
  /** Every source this studio holds, as `listSources` returns them. */
  existingSources: readonly SkillSource[]
  /** The source that was just added, so the caller can refresh and open it. */
  onAdded: (sourceId: string) => void
}): JSX.Element | null {
  const [load, setLoad] = useState<FeedLoad>({ status: 'loading' })
  const [busyRepo, setBusyRepo] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ repo: string; message: string } | null>(null)

  // Read once per mount, off disk. `hostedSourcesFeedGet` never touches the
  // network — the poller's feed leg is what keeps that copy fresh — so opening
  // the door never waits on GitHub to draw this.
  useEffect(() => {
    if (typeof window.api.hostedSourcesFeedGet !== 'function') {
      setLoad({ status: 'unavailable' })
      return undefined
    }
    let cancelled = false
    void window.api
      .hostedSourcesFeedGet()
      .then((result) => {
        if (cancelled) return
        setLoad(result.ok ? { status: 'ready', sources: result.feed.sources } : { status: 'unavailable' })
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const add = useCallback(
    async (source: HostedSource): Promise<void> => {
      if (typeof window.api.skillsAddSource !== 'function' || busyRepo) return
      setBusyRepo(source.repo)
      setFailure(null)
      try {
        // The same call the "Add from GitHub…" modal makes, with the same
        // shape. `replace` stays false: a repository already in the list is a
        // recommendation that should not have been offered, and silently
        // re-adding it would hide that rather than report it.
        const result = await window.api.skillsAddSource({ repo: source.repo })
        if (!result.ok) {
          setFailure({ repo: source.repo, message: result.message })
          return
        }
        onAdded(result.source.id)
      } catch (error) {
        setFailure({ repo: source.repo, message: error instanceof Error ? error.message : String(error) })
      } finally {
        setBusyRepo(null)
      }
    },
    [busyRepo, onAdded],
  )

  if (load.status === 'unavailable') return null
  if (load.status === 'loading') return null

  const offered = offerableRecommendations({ sources: load.sources }, existingSources)
  // Every recommendation is already in the list. Saying so would be a heading
  // over nothing; the absence is the message.
  if (offered.length === 0) return null

  return (
    <section className="space-y-2" aria-label="Recommended sources">
      <ConnectorSectionHeading label="Recommended sources" count={offered.length} />
      <p className="text-meta leading-4 text-[color:var(--text-subtle)]">
        Places to get skills and plugins. The studio recommends these; it does not publish what is in them.
      </p>
      {failure ? <InlineNotice tone="error" title="That source was not added." hint={failure.message} /> : null}
      {/* The same list card the catalogue groups above it sit in (list-card
          ruling 2026-09-15): this list is offered under them and must not
          look like a different kind of list. */}
      <SettingCard as="ul" ariaLabel="Recommended sources" columns={2}>
        {offered.map((source) => (
          <li key={source.id}>
            <ConnectorRow
              surface="card"
              icon={
                <SourceMonogram monogram={skillSourceMonogram(source.repo.split('/')[1] ?? source.repo)} size="lg" />
              }
              name={source.repo}
              summary={source.description}
              chips={[KIND_LABEL[source.kind]]}
              actions={
                <GhostButton
                  size="sm"
                  onClick={() => void add(source)}
                  disabled={busyRepo !== null}
                  className="border border-[color:var(--border-default)]"
                  aria-label={`Add ${source.repo} as a source`}
                >
                  {busyRepo === source.repo ? <Spinner size={12} label="Adding" /> : 'Add'}
                </GhostButton>
              }
            />
          </li>
        ))}
      </SettingCard>
    </section>
  )
}
