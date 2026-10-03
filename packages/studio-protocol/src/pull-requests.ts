import type { StudioErrorCode } from './envelope.js'
import { STUDIO_PULL_REQUESTS_CAPABILITY } from './handshake.js'
import type { StudioScope } from './scopes.js'

// The pull requests a Studio knows its conversations have. A Studio finds them
// by asking its host "is there a pull request for this branch?" for every
// checkout a conversation worked in (its own, and each other repository its
// agent changed files in), keeps what GitHub answered, and watches the open
// ones until they land. A client only displays them: a sidebar's mark, a
// tooltip, a peek's menu.
//
// Two ways to ask, by workspace (every conversation in it, and every agent it
// ever had) and by conversation (one agent). `pullRequests.changed` names what
// moved, never the lists themselves, so a client asks again for what it is
// showing. A Studio with no way to ask its host (no `gh`, or not signed in)
// answers with empty lists and never fails for it.
//
// `pullRequests.noteWork` is for a client that runs agents the Studio does not:
// the desktop's terminal agents. It says where such an agent did work, and the
// Studio looks those branches up as it does for its own chats.
//
// Owners only in this version, behind the `pull-requests` capability.

export type StudioPullRequestState = 'open' | 'merged' | 'closed'

/** One pull request, as its host last answered for it. */
export type StudioPullRequest = {
  /** Canonical: `https://<host>/<owner>/<repo>/pull/<n>`. */
  url: string
  /** The repository it is in, `host/owner/name`. Not always the conversation's own. */
  repoKey: string
  repoName: string
  number: number
  title: string
  state: StudioPullRequestState
  /** A draft is still `open`. */
  isDraft: boolean
  /** When it was opened, ms epoch; 0 when the host never said. */
  openedAt: number
  /** When its state was last read from the host, ms epoch. */
  stateAt: number
  /**
   * On a conversation's list only: the pull request is on the branch the
   * conversation's own checkout is on, and so may say whether that branch has
   * landed. Absent for one found in another repository the agent worked in.
   */
  onConversationBranch?: true
}

/** A conversation by its workspace and agent. */
export type StudioPullRequestOwner = { workspaceId: string; agentId: string }

/** What to ask about. Both lists are optional; at most `STUDIO_PULL_REQUESTS_MAX_IDS` each. */
export type StudioPullRequestsTarget = {
  workspaceIds?: string[]
  conversations?: StudioPullRequestOwner[]
}

/** The most ids one request may name in each list. */
export const STUDIO_PULL_REQUESTS_MAX_IDS = 500
/** The most changed paths one `noteWork` may carry. */
export const STUDIO_PULL_REQUESTS_MAX_PATHS = 256

export type StudioPullRequestsMethodMap = {
  /**
   * Newest first, de-duplicated by URL. Only what has pull requests is
   * answered: an id with none is left out of `workspaces` and `conversations`.
   */
  'pullRequests.list': {
    params: StudioPullRequestsTarget
    result: {
      workspaces: Record<string, StudioPullRequest[]>
      conversations: Array<StudioPullRequestOwner & { pullRequests: StudioPullRequest[] }>
    }
  }
  /**
   * Ask the host again: look the branches up (at most once a minute each) and
   * re-read states older than a minute. With no ids, every open pull request
   * the Studio holds. `asked` is false when there was nothing to ask about.
   * The answers arrive as `pullRequests.changed`.
   */
  'pullRequests.refresh': { params: StudioPullRequestsTarget; result: { asked: boolean } }
  /**
   * An agent this client runs did work: its checkout (the branch it is on),
   * and the files it changed since it last said so. `turnEnded` asks for a
   * lookup made after this call; without it a recent answer is enough.
   */
  'pullRequests.noteWork': {
    params: {
      conversation: StudioPullRequestOwner
      /** The client's own id for the session the agent runs in. */
      sessionId?: string
      checkout?: { gitRoot: string; branch: string }
      /** Absolute paths, in this Studio's spelling. */
      changedPaths?: string[]
      turnEnded?: boolean
    }
    result: Record<string, never>
  }
}

export type StudioPullRequestsMethod = keyof StudioPullRequestsMethodMap

export type StudioPullRequestsTopicMap = {
  /** What moved, as `{ workspaceIds: string[], conversations: StudioPullRequestOwner[] }`; ask `pullRequests.list` again. */
  'pullRequests.changed': { params: Record<string, never> }
}

type MethodSpec = {
  scope: StudioScope
  mutation: false
  capability: typeof STUDIO_PULL_REQUESTS_CAPABILITY
  owner: true
}

const owned: MethodSpec = {
  scope: 'workspaces:read',
  mutation: false,
  capability: STUDIO_PULL_REQUESTS_CAPABILITY,
  owner: true,
}

export const STUDIO_PULL_REQUESTS_METHODS: { readonly [M in StudioPullRequestsMethod]: MethodSpec } = {
  'pullRequests.list': owned,
  'pullRequests.refresh': owned,
  'pullRequests.noteWork': owned,
}

export const STUDIO_PULL_REQUESTS_TOPICS: {
  readonly [T in keyof StudioPullRequestsTopicMap]: {
    scope: StudioScope
    capability: typeof STUDIO_PULL_REQUESTS_CAPABILITY
    owner: true
    push: true
  }
} = {
  'pullRequests.changed': {
    scope: 'workspaces:read',
    capability: STUDIO_PULL_REQUESTS_CAPABILITY,
    owner: true,
    push: true,
  },
}

export function isStudioPullRequestsMethod(value: unknown): value is StudioPullRequestsMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_PULL_REQUESTS_METHODS, value)
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = { ok: false; code: StudioErrorCode; message: string }
const refuse = (message: string): Refusal => ({ ok: false, code: 'invalid_params', message })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A conversation by workspace and agent, or null. */
export function parseStudioPullRequestOwner(value: unknown): StudioPullRequestOwner | null {
  if (!record(value) || !id(value.workspaceId) || !id(value.agentId)) return null
  return { workspaceId: value.workspaceId, agentId: value.agentId }
}

function parseTarget(value: Record<string, unknown>): StudioPullRequestsTarget | Refusal {
  const target: StudioPullRequestsTarget = {}
  if (value.workspaceIds !== undefined) {
    if (!Array.isArray(value.workspaceIds) || value.workspaceIds.length > STUDIO_PULL_REQUESTS_MAX_IDS)
      return refuse(`"workspaceIds" is a list of at most ${STUDIO_PULL_REQUESTS_MAX_IDS} workspace ids.`)
    if (!value.workspaceIds.every(id)) return refuse('Every entry of "workspaceIds" is a workspace id.')
    target.workspaceIds = [...new Set(value.workspaceIds as string[])]
  }
  if (value.conversations !== undefined) {
    if (!Array.isArray(value.conversations) || value.conversations.length > STUDIO_PULL_REQUESTS_MAX_IDS)
      return refuse(`"conversations" is a list of at most ${STUDIO_PULL_REQUESTS_MAX_IDS} conversations.`)
    const conversations: StudioPullRequestOwner[] = []
    for (const entry of value.conversations) {
      const owner = parseStudioPullRequestOwner(entry)
      if (!owner) return refuse('Every entry of "conversations" is { workspaceId, agentId }.')
      conversations.push(owner)
    }
    target.conversations = conversations
  }
  return target
}

/** A `pullRequests.*` method's params, shape-checked, keeping only the members it defines. */
export function parseStudioPullRequestsParams<M extends StudioPullRequestsMethod>(
  method: M,
  params: unknown,
): { ok: true; params: StudioPullRequestsMethodMap[M]['params'] } | Refusal {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse(`${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioPullRequestsMethodMap[M]['params'] })
  if (method === 'pullRequests.list' || method === 'pullRequests.refresh') {
    const target = parseTarget(value)
    return 'ok' in target ? target : ok(target)
  }
  if (method !== 'pullRequests.noteWork') return refuse(`${method} is not a pullRequests method.`)
  const conversation = parseStudioPullRequestOwner(value.conversation)
  if (!conversation) return refuse('"conversation" is { workspaceId, agentId }.')
  const parsed: StudioPullRequestsMethodMap['pullRequests.noteWork']['params'] = { conversation }
  if (value.sessionId !== undefined) {
    if (!id(value.sessionId)) return refuse('"sessionId" is a string of 1 to 200 characters.')
    parsed.sessionId = value.sessionId
  }
  if (value.checkout !== undefined) {
    const checkout = value.checkout
    if (
      !record(checkout) ||
      typeof checkout.gitRoot !== 'string' ||
      checkout.gitRoot.length === 0 ||
      checkout.gitRoot.length > 4096 ||
      checkout.gitRoot.includes('\0') ||
      typeof checkout.branch !== 'string' ||
      checkout.branch.length === 0 ||
      checkout.branch.length > 255 ||
      checkout.branch.startsWith('-') ||
      checkout.branch.includes('\0')
    )
      return refuse('"checkout" is { gitRoot, branch }: a folder, and a branch name that does not start with "-".')
    parsed.checkout = { gitRoot: checkout.gitRoot, branch: checkout.branch }
  }
  if (value.changedPaths !== undefined) {
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length > STUDIO_PULL_REQUESTS_MAX_PATHS)
      return refuse(`"changedPaths" is a list of at most ${STUDIO_PULL_REQUESTS_MAX_PATHS} paths.`)
    if (
      !value.changedPaths.every(
        (path) => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'),
      )
    )
      return refuse('Every entry of "changedPaths" is an absolute path.')
    parsed.changedPaths = value.changedPaths as string[]
  }
  if (value.turnEnded !== undefined) {
    if (typeof value.turnEnded !== 'boolean') return refuse('"turnEnded" is true or false.')
    parsed.turnEnded = value.turnEnded
  }
  return ok(parsed)
}
