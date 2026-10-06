import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { StudioClient } from '../../../../../packages/agent-sdk/src/index'
import {
  STUDIO_LOCAL_SERVERS_CAPABILITY,
  STUDIO_LOCAL_SERVERS_MAX_IDS,
  type StudioLocalServer,
  type StudioLocalServerOwner,
} from '../../../../../packages/studio-protocol/src/public'
import { watchWindowStudio, windowStudioClient, windowStudioState } from '../../studio/windowStudioClient'

// The local servers a conversation's agents started — a dev server, a preview,
// anything an agent linked with `local_server.link` — for the two places a
// person looks for them: the open chat's composer strip (one conversation) and
// the sidebar's rows (every conversation on screen, by workspace).
//
// The record is the Studio server's, and it is the server that checks each
// one (is anything accepting connections on its port?). So this reads it the
// way the pull request marks read theirs: `localServers.list` over the
// window's Studio connection, asked again when `localServers.changed` names
// what moved and when the connection comes back. The renderer never polls: a
// server stopping is something the Studio notices and pushes.

export type WorkspaceLocalServers = Readonly<Record<string, readonly StudioLocalServer[]>>

/** What `run`, `stop` and `remove` answer. Never a throw: the caller says the message. */
export type LocalServerActionResult = { ok: true } | { ok: false; message: string }

const NONE: WorkspaceLocalServers = {}
const EMPTY: readonly StudioLocalServer[] = []

/**
 * One ask per changed set, coalesced across a burst. A run that starts flips
 * a server to Starting and then to Running a moment later, and each flip
 * pushes; the sidebar must not send a request per push.
 */
const COALESCE_MS = 250

/** The window's Studio client, when it serves local servers; null otherwise (or in a test with no window). */
async function localServersClient(): Promise<StudioClient | null> {
  const api = typeof window === 'undefined' ? null : window.api
  if (typeof api?.studioConnect !== 'function') return null
  try {
    const client = await windowStudioClient(api)
    return client.supports(STUDIO_LOCAL_SERVERS_CAPABILITY) ? client : null
  } catch {
    return null
  }
}

/**
 * Every server the conversations in these workspaces linked, by workspace,
 * newest first. A workspace with none is absent.
 *
 * @param workspaceIds The conversations on screen. Keyed on the joined ids, so
 *   a caller rebuilding the array every render is fine.
 */
export function useWorkspaceLocalServers(workspaceIds: readonly string[]): WorkspaceLocalServers {
  const [byWorkspace, setByWorkspace] = useState<WorkspaceLocalServers>(NONE)
  const key = useMemo(() => [...workspaceIds].sort().join('\0'), [workspaceIds])
  const idsRef = useRef<readonly string[]>(workspaceIds)
  idsRef.current = workspaceIds
  const aliveRef = useRef(true)
  // Asks overlap (a push lands while the ids change); only the latest one's
  // answer is drawn, or an older ask for fewer ids would drop a row's servers.
  const askedRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const ask = useCallback(async (): Promise<void> => {
    const asked = ++askedRef.current
    const ids = idsRef.current
    if (ids.length === 0) {
      setByWorkspace((current) => (current === NONE ? current : NONE))
      return
    }
    const client = await localServersClient()
    if (!client) return
    try {
      const answer: Record<string, readonly StudioLocalServer[]> = {}
      for (let start = 0; start < ids.length; start += STUDIO_LOCAL_SERVERS_MAX_IDS) {
        const page = await client.request('localServers.list', {
          workspaceIds: ids.slice(start, start + STUDIO_LOCAL_SERVERS_MAX_IDS),
        })
        for (const [workspaceId, list] of Object.entries(page.workspaces)) answer[workspaceId] = list
      }
      if (!aliveRef.current || asked !== askedRef.current) return
      // Replace rather than merge: the answer is the whole truth for the ids
      // asked about. Each workspace keeps its old list when it reads the same,
      // so a memoized row whose servers did not move is not drawn again.
      setByWorkspace((current) => shareUnchanged(current, answer))
    } catch {
      // A read that reached nobody leaves what is on screen alone.
    }
  }, [])

  useEffect(() => {
    void ask()
  }, [ask, key])
  useAskWhenLocalServersMove(ask)

  return byWorkspace
}

/**
 * The servers ONE conversation linked, newest first: what the open chat's
 * strip shows. Null asks nothing (a chat on a paired machine, whose record is
 * that machine's).
 */
export function useLocalServersOfConversation(
  conversation: StudioLocalServerOwner | null,
): readonly StudioLocalServer[] {
  const workspaceId = conversation?.workspaceId ?? null
  const agentId = conversation?.agentId ?? null
  const key = workspaceId && agentId ? `${workspaceId}\0${agentId}` : null
  // The list is held with the conversation it is for. The chat view is not
  // remounted when it moves to another conversation, and the last one's
  // servers must not be drawn (or acted on) under the next while it is asked.
  const [held, setHeld] = useState<{ key: string | null; list: readonly StudioLocalServer[] }>({
    key: null,
    list: EMPTY,
  })
  const keyRef = useRef(key)
  keyRef.current = key
  // Only the latest ask is drawn: two that overlap (a push while the first
  // read is out) can answer out of order, and the older list must not land
  // last over the newer.
  const askedRef = useRef(0)
  const ask = useCallback(async (): Promise<void> => {
    if (!workspaceId || !agentId || !key) return
    const asked = ++askedRef.current
    const client = await localServersClient()
    if (!client) return
    try {
      const page = await client.request('localServers.list', { conversations: [{ workspaceId, agentId }] })
      // An answer for a conversation this view has since left is not drawn.
      if (keyRef.current !== key || asked !== askedRef.current) return
      const found = page.conversations.find((entry) => entry.workspaceId === workspaceId && entry.agentId === agentId)
      const next = found && found.servers.length > 0 ? found.servers : EMPTY
      setHeld((current) =>
        current.key === key && sameLocalServerList(current.list, next) ? current : { key, list: next },
      )
    } catch {
      // A read that reached nobody leaves what is on screen alone.
    }
  }, [workspaceId, agentId, key])
  useEffect(() => {
    void ask()
  }, [ask])
  useAskWhenLocalServersMove(ask)
  return key !== null && held.key === key ? held.list : EMPTY
}

/** Start the server's command again, as a process the Studio owns. Never throws. */
export function runLocalServer(conversation: StudioLocalServerOwner, id: string): Promise<LocalServerActionResult> {
  return act('localServers.run', conversation, id, 'could not be started')
}

/** Stop the run the Studio started. Never throws. */
export function stopLocalServer(conversation: StudioLocalServerOwner, id: string): Promise<LocalServerActionResult> {
  return act('localServers.stop', conversation, id, 'could not be stopped')
}

/** Forget the link (and stop the Studio's own run of it). Never throws. */
export function removeLocalServer(conversation: StudioLocalServerOwner, id: string): Promise<LocalServerActionResult> {
  return act('localServers.remove', conversation, id, 'could not be removed')
}

async function act(
  method: 'localServers.run' | 'localServers.stop' | 'localServers.remove',
  conversation: StudioLocalServerOwner,
  id: string,
  failed: string,
): Promise<LocalServerActionResult> {
  const client = await localServersClient()
  if (!client) return { ok: false, message: `The server ${failed}: this Studio does not manage local servers.` }
  try {
    await client.request(method, { conversation, id })
    // The new state is not in the answer: it arrives as `localServers.changed`.
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `The server ${failed}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Ask again whenever the server says local servers moved, and when the
 * window's Studio connection comes back (a restarted server may have seen a
 * port close while nobody was connected).
 */
function useAskWhenLocalServersMove(ask: () => Promise<void>): void {
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
    // A client that reconnects keeps its subscription; one that closed for
    // good is replaced by a new client, which needs one of its own.
    let subscribed: StudioClient | null = null
    const subscribe = () => {
      void localServersClient().then((client) => {
        if (!client || !alive || client === subscribed) return
        stop?.()
        subscribed = client
        stop = client.subscribe('localServers.changed', {}, { onPayload: schedule })
      })
    }
    subscribe()
    const unwatch = watchWindowStudio(api, () => {
      if (windowStudioState(api) !== 'open') return
      subscribe()
      schedule()
    })
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      stop?.()
      unwatch()
    }
  }, [ask])
}

/**
 * Whether two lists draw the same: everything the strip, the sidebar mark and
 * the menu say. `stateAt` is left out on purpose — the Studio stamps it on
 * every check, and a check that found nothing new is not worth a repaint.
 */
export function sameLocalServerList(a: readonly StudioLocalServer[], b: readonly StudioLocalServer[]): boolean {
  return (
    a.length === b.length &&
    a.every((server, i) => {
      const other = b[i]
      return (
        server.id === other.id &&
        // Another agent in the workspace can take a server's address over;
        // its actions then name that agent's conversation.
        server.agentId === other.agentId &&
        server.state === other.state &&
        server.url === other.url &&
        server.title === other.title &&
        server.command === other.command &&
        server.cwd === other.cwd &&
        server.startedByStudio === other.startedByStudio &&
        server.lastExit?.at === other.lastExit?.at
      )
    })
  )
}

/**
 * The new answer, keeping every list (and the whole map) that reads the same
 * as before, so an unchanged read commits nothing.
 */
function shareUnchanged(
  current: WorkspaceLocalServers,
  answer: Record<string, readonly StudioLocalServer[]>,
): WorkspaceLocalServers {
  const ids = Object.keys(answer)
  let changed = ids.length !== Object.keys(current).length
  const next: Record<string, readonly StudioLocalServer[]> = {}
  for (const id of ids) {
    const before = current[id]
    if (before && sameLocalServerList(before, answer[id])) next[id] = before
    else {
      next[id] = answer[id]
      changed = true
    }
  }
  if (!changed) return current
  return ids.length === 0 ? NONE : next
}
