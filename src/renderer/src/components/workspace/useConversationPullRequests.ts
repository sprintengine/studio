import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { StudioClient } from '../../../../../packages/agent-sdk/src/index'
import {
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUESTS_MAX_IDS,
  type StudioPullRequest,
} from '../../../../../packages/studio-protocol/src/public'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { watchWindowStudio, windowStudioClient, windowStudioState } from '../../studio/windowStudioClient'

// The pull requests a CONVERSATION holds, for the sidebar rows that have
// nothing running in them (owner, 2026-09-10).
//
// The problem it solves, in the owner's words: "there is an agent who has an
// open pull request… he is no longer active, but it doesn't show on his card
// that he has an open pull request. If I'm scanning through the old chats I
// don't know is there a pull request open that I'm missing."
//
// A live session's marks already arrive on the terminal snapshot and this hook
// deliberately does not touch them — a row with a live agent reads that, and
// this fills in only where there is no session left to read. Two sources, one
// per row, chosen by whether the row has a line of its own: see
// `pullRequestsForRow`.
//
// The record is the Studio server's (owner ruling 2026-10-03), so this reads
// it the way any client does: `pullRequests.list` by workspace over the
// window's Studio connection, in process and out of process alike, asked
// again when `pullRequests.changed` names what moved and when the connection
// comes back. A window coming to the front asks the server to look again.

export type ConversationPullRequests = Readonly<Record<string, readonly BranchPullRequest[]>>

const NONE: ConversationPullRequests = {}

/**
 * One ask per changed set, coalesced across a burst. A record change can move
 * several branches at once (a lookup merging a list), and each one pushes; the
 * sidebar must not send a request per push.
 */
const COALESCE_MS = 250

/** The window's Studio client, when it serves pull requests; null otherwise (or in a test with no window). */
async function pullRequestClient(): Promise<StudioClient | null> {
  const api = typeof window === 'undefined' ? null : window.api
  if (typeof api?.studioConnect !== 'function') return null
  try {
    const client = await windowStudioClient(api)
    return client.supports(STUDIO_PULL_REQUESTS_CAPABILITY) ? client : null
  } catch {
    return null
  }
}

/**
 * @param workspaceIds The conversations on screen. The hook keys its effect on
 *   the joined ids, so a caller rebuilding the array every render is fine, but
 *   the ids themselves changing re-asks.
 */
export function useConversationPullRequests(workspaceIds: readonly string[]): ConversationPullRequests {
  const [byWorkspace, setByWorkspace] = useState<ConversationPullRequests>(NONE)
  const key = useMemo(() => [...workspaceIds].sort().join('\0'), [workspaceIds])
  const idsRef = useRef<readonly string[]>(workspaceIds)
  idsRef.current = workspaceIds
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const ask = useCallback(async (): Promise<void> => {
    const ids = idsRef.current
    if (ids.length === 0) {
      setByWorkspace((current) => (current === NONE ? current : NONE))
      return
    }
    const client = await pullRequestClient()
    if (!client) return
    try {
      const answer: Record<string, BranchPullRequest[]> = {}
      for (let start = 0; start < ids.length; start += STUDIO_PULL_REQUESTS_MAX_IDS) {
        const page = await client.request('pullRequests.list', {
          workspaceIds: ids.slice(start, start + STUDIO_PULL_REQUESTS_MAX_IDS),
        })
        for (const [workspaceId, list] of Object.entries(page.workspaces)) answer[workspaceId] = list.map(fromWire)
      }
      if (!aliveRef.current) return
      // Replace rather than merge. The answer is the whole truth for the ids
      // asked about, and merging would keep a conversation's marks alive after
      // its row left the list — which is how a stale count survives a filter.
      setByWorkspace((current) => (sameLists(current, answer) ? current : answer))
    } catch {
      // A read that reached nobody leaves what is on screen alone. A mark must
      // never blink out because one request failed (the record's own rule).
    }
  }, [])

  // Ask when the set of conversations changes, and once on mount.
  useEffect(() => {
    void ask()
  }, [ask, key])

  // …and whenever the server says something moved, or the connection comes
  // back from a server restart. The ids on a push are not filtered against what
  // is on screen: the answer is filtered by the ask itself.
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (typeof api?.studioConnect !== 'function') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let stop: (() => void) | null = null
    const schedule = () => {
      if (timer || !alive) return
      timer = setTimeout(() => {
        timer = null
        void ask()
      }, COALESCE_MS)
    }
    void pullRequestClient().then((client) => {
      if (!client || !alive) return
      stop = client.subscribe('pullRequests.changed', {}, { onPayload: schedule })
    })
    const unwatch = watchWindowStudio(api, () => {
      if (windowStudioState(api) === 'open') schedule()
    })
    // Coming back to the app is the cheapest moment to notice a pull request
    // that merged while it was in the background (decision 9).
    const onFocus = () => {
      void pullRequestClient().then((client) => client?.request('pullRequests.refresh', {}).catch(() => undefined))
    }
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      stop?.()
      unwatch()
      window.removeEventListener('focus', onFocus)
    }
  }, [ask])

  return byWorkspace
}

/** A wire entry as the marks read it. A workspace's list says nothing about any one branch. */
function fromWire(entry: StudioPullRequest): BranchPullRequest {
  const { onConversationBranch: _onBranch, ...rest } = entry
  return rest
}

/** Whether two answers say the same thing, so an unchanged read commits nothing. */
function sameLists(a: ConversationPullRequests, b: ConversationPullRequests): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const id of aKeys) {
    const left = a[id]
    const right = b[id]
    if (!right || left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      // URL and state are the whole of what a mark draws from; a title moving
      // changes a tooltip, which is not worth a sidebar repaint.
      if (left[i].url !== right[i].url || left[i].state !== right[i].state) return false
      if (left[i].isDraft !== right[i].isDraft) return false
    }
  }
  return true
}

/**
 * Which list a row should draw: its live session's, or the conversation's.
 *
 * A row with a live agent line already has marks from the terminal snapshot and
 * they are the more precise answer — they carry `onSessionBranch`, which is what
 * decides the "landed" diff reading. The conversation's list is the fallback for
 * a row with no line left, and it is deliberately NOT merged into a live one: a
 * conversation's list spans every agent it ever had, and folding that into a
 * running agent's row would put another agent's pull request on this agent's
 * line.
 */
export function pullRequestsForRow(input: {
  /** Whether the row has agent lines of its own, each drawing its own marks. */
  hasLiveLines: boolean
  /** What the conversation holds, from this hook. */
  conversation: readonly BranchPullRequest[] | undefined
}): readonly BranchPullRequest[] {
  // A row with lines has already said everything it has to say, on the lines
  // themselves, where each mark sits beside the agent that opened it. Adding
  // the conversation's list underneath would draw the same pull request twice
  // and put one agent's work on another agent's row.
  if (input.hasLiveLines) return EMPTY
  return input.conversation ?? EMPTY
}

const EMPTY: readonly BranchPullRequest[] = []
