// The renderer's view of a repository's changelists (epic `git-commit-window`,
// T6). Same shape as `useGitStatus`: ONE shared subscription per repo root, so
// two panels looking at the same checkout read one answer and a mutation in
// either is seen by both.
//
// Shared rather than per-hook because the store is authoritative and every
// mutation answers with the WHOLE reconciled set. A per-component copy would
// let the Git panel and, say, a future commit dialog disagree about which list
// is active — and "which list is active" decides where the next change lands.
//
// The lists follow status: main prunes on every read, so this refreshes
// whenever the tree is re-read (`useGitTreeRevision`) rather than polling.

import { useCallback, useEffect, useState } from 'react'
import {
  activeChangelist as pickActive,
  createDefaultChangelists,
  type Changelist,
} from '../../../shared/git/changelists'
import { normalizePathKey, useGitTreeRevision } from './useGitStatus'

type ChangelistSubscriber = (lists: Changelist[]) => void

type ChangelistSubscription = {
  repoRoot: string
  lists: Changelist[]
  subscribers: Set<ChangelistSubscriber>
  inFlight: Promise<Changelist[]> | null
}

const subscriptions = new Map<string, ChangelistSubscription>()

function getSubscription(repoRoot: string): ChangelistSubscription {
  const key = normalizePathKey(repoRoot)
  const existing = subscriptions.get(key)
  if (existing) return existing
  const subscription: ChangelistSubscription = {
    repoRoot,
    lists: createDefaultChangelists(),
    subscribers: new Set(),
    inFlight: null,
  }
  subscriptions.set(key, subscription)
  return subscription
}

function publish(subscription: ChangelistSubscription, lists: Changelist[]): Changelist[] {
  subscription.lists = lists
  subscription.subscribers.forEach((subscriber) => subscriber(lists))
  return lists
}

/**
 * What a mutation actually did. The lists come back either way — a failed call
 * keeps the last good ones on screen, because falling back to the bare default
 * would make a transient IPC error look exactly like "someone deleted all your
 * changelists" — but `ok` is the half the caller must read.
 *
 * It exists because the panel used to announce "Moved 3 files to Spike" off the
 * mere fact that the promise settled, while this module swallowed every error
 * and answered with the unchanged lists. The rejection went nowhere, the lists
 * did not move, and the person was told they had.
 */
export type ChangelistCallResult = {
  ok: boolean
  changelists: Changelist[]
  /** Only when `ok` is false: what to put in front of the person. */
  error?: string
}

/**
 * Run one store call and publish its answer. Every mutation goes through here
 * rather than setting state from its own return value, so a second panel is
 * told about a rename it did not make.
 */
async function runChangelistCall(
  repoRoot: string | null,
  call: (root: string) => Promise<Changelist[]>,
): Promise<ChangelistCallResult> {
  if (!repoRoot || typeof window.api.getGitChangelists !== 'function') {
    // No repository, or a preload that predates changelists. Not an error to
    // report — there was nothing to act on — but not a success to announce
    // either, so nothing is claimed.
    return { ok: false, changelists: createDefaultChangelists() }
  }
  const subscription = getSubscription(repoRoot)
  try {
    return { ok: true, changelists: publish(subscription, await call(subscription.repoRoot)) }
  } catch (error) {
    return {
      ok: false,
      changelists: subscription.lists,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Re-read from the store — after a commit, a discard, or anything else that
 *  changes which paths git reports. */
export function refreshChangelists(repoRoot: string | null): Promise<Changelist[]> {
  if (!repoRoot || typeof window.api.getGitChangelists !== 'function')
    return Promise.resolve(createDefaultChangelists())
  const subscription = getSubscription(repoRoot)
  // Coalesce: a burst of watch ticks must not become a burst of git spawns.
  if (subscription.inFlight) return subscription.inFlight
  // A READ, not a mutation: it announces nothing, so a failed one legitimately
  // resolves to the last good lists rather than to a signal somebody must read.
  const promise = runChangelistCall(repoRoot, (root) => window.api.getGitChangelists(root))
    .then((result) => result.changelists)
    .finally(() => {
      subscription.inFlight = null
    })
  subscription.inFlight = promise
  return promise
}

export function setActiveChangelistFor(repoRoot: string | null, id: string): Promise<ChangelistCallResult> {
  return runChangelistCall(repoRoot, (root) => window.api.setActiveGitChangelist(root, id))
}

export function createChangelistFor(
  repoRoot: string | null,
  input: { name: string; comment?: string; activate?: boolean; paths?: string[] },
): Promise<ChangelistCallResult> {
  return runChangelistCall(repoRoot, (root) => window.api.createGitChangelist(root, input))
}

export function renameChangelistFor(
  repoRoot: string | null,
  id: string,
  input: { name: string; comment?: string },
): Promise<ChangelistCallResult> {
  return runChangelistCall(repoRoot, (root) => window.api.renameGitChangelist(root, id, input))
}

export function deleteChangelistFor(repoRoot: string | null, id: string): Promise<ChangelistCallResult> {
  return runChangelistCall(repoRoot, (root) => window.api.deleteGitChangelist(root, id))
}

export function moveChangelistPathsFor(
  repoRoot: string | null,
  id: string,
  paths: string[],
): Promise<ChangelistCallResult> {
  return runChangelistCall(repoRoot, (root) => window.api.moveGitChangelistPaths(root, id, paths))
}

export type UseChangelistsResult = {
  changelists: Changelist[]
  /** Never null once a repository is resolved — the default always exists. */
  activeChangelist: Changelist | null
  refresh: () => Promise<void>
}

export function useChangelists(repoRoot: string | null): UseChangelistsResult {
  const [changelists, setChangelists] = useState<Changelist[]>(createDefaultChangelists)
  // Every completed `git status` read is a reason to re-read the lists: main
  // prunes against status, so a file that was just committed leaves its list on
  // the very next tick rather than on the next mutation.
  const treeRevision = useGitTreeRevision(repoRoot)

  const refresh = useCallback(async () => {
    await refreshChangelists(repoRoot)
  }, [repoRoot])

  useEffect(() => {
    if (!repoRoot) {
      setChangelists(createDefaultChangelists())
      return
    }
    const subscription = getSubscription(repoRoot)
    subscription.subscribers.add(setChangelists)
    setChangelists(subscription.lists)
    void refreshChangelists(repoRoot)
    return () => {
      subscription.subscribers.delete(setChangelists)
      if (subscription.subscribers.size === 0) subscriptions.delete(normalizePathKey(repoRoot))
    }
  }, [repoRoot])

  useEffect(() => {
    if (!repoRoot || treeRevision === 0) return
    void refreshChangelists(repoRoot)
  }, [repoRoot, treeRevision])

  // Main writes these lists too: an agent launching, editing or exiting moves
  // its own changelist with nobody in a window having asked. It pushes the ROOT
  // and nothing else — the store always answers with the whole reconciled set,
  // so a pushed copy could only ever be the older one — on one channel for every
  // repository, which is why the root is compared here. `refreshChangelists`
  // coalesces, so a burst of writes costs one read.
  useEffect(() => {
    if (!repoRoot || typeof window.api.onGitChangelistsChanged !== 'function') return
    const key = normalizePathKey(repoRoot)
    return window.api.onGitChangelistsChanged((event) => {
      if (!event?.repoRoot || normalizePathKey(event.repoRoot) !== key) return
      void refreshChangelists(repoRoot)
    })
  }, [repoRoot])

  return { changelists, activeChangelist: pickActive(changelists), refresh }
}
