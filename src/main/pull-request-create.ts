// The chat's "Create PR" button, in the main process (owner ruling
// 2026-10-04): whether it may show for a checkout, the draft of a title and
// description from the person's own agent CLI, the push, and the creation.
// The app does it itself, in the conversation's own checkout on this
// computer: `gh pr create` on GitHub, and on the other forges the forge's own
// prefilled "new pull request" page in the browser, since the app drives no
// other forge's CLI.
//
// Every step answers with a reason when it fails, never silently: the strip
// shows it. Nothing here records a pull request; the window does, through the
// Studio server's `pullRequests.link`, the same record the gateway's tool and
// the captured create commands write.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { classifyPullRequestUrl } from '../shared/git/pr-url'
import {
  createPullRequestReadiness,
  forgeOfRemote,
  newPullRequestPageUrl,
  type CreatePullRequestFacts,
  type CreatePullRequestOutcome,
  type CreatePullRequestReadiness,
  type CreatePullRequestState,
  type ForgeRemote,
  type PushForPullRequestOutcome,
} from '../shared/git/pull-request-create'
import { followsConventionalCommits, type PullRequestTextInput } from '../shared/text-generation/pull-request-text'
import { listBranchPullRequests } from './github/branch-pull-request'
import { sharedGhRunner, type GhRunner } from './github/gh'
import { runGitCommand } from './git-utils'

export type DraftInputOutcome = { ok: true; input: PullRequestTextInput } | { ok: false; message: string }

export type PullRequestCreateDeps = {
  git?: typeof runGitCommand
  gh?: GhRunner
  listBranch?: typeof listBranchPullRequests
  now?: () => number
}

/** How long a branch lookup answers the button before `gh` is asked again. */
const LOOKUP_HOLD_MS = 30_000
/** How much of the diff is read for a draft; the prompt cuts it again. */
const MAX_PATCH_READ_CHARS = 60_000
/** How long `gh pr create` may take. */
const GH_CREATE_TIMEOUT_MS = 60_000
/** gh's refusal to open a second pull request for a branch. */
const GH_ALREADY_EXISTS = /\ba pull request for branch\b[^\n]*\balready exists\b/i
/** Where a repository keeps its pull request template, in the order a forge looks. */
const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  '.gitlab/merge_request_templates/Default.md',
  '.gitea/pull_request_template.md',
]

type Lookup = { at: number; open: boolean | null; mergedHeads: string[] }

export function createPullRequestCreator(deps: PullRequestCreateDeps = {}) {
  const git = deps.git ?? runGitCommand
  const listBranch = deps.listBranch ?? listBranchPullRequests
  const now = deps.now ?? (() => Date.now())
  const lookups = new Map<string, Lookup>()

  const out = async (cwd: string, args: string[]): Promise<string | null> => {
    const result = await git(cwd, args)
    return result.ok ? result.stdout.trim() : null
  }

  /** The checkout's facts, git's and the branch lookup's. */
  async function readFacts(
    cwd: string,
    options: { fresh?: boolean } = {},
  ): Promise<{
    facts: CreatePullRequestFacts
    gitRoot: string | null
    remote: ForgeRemote | null
  }> {
    const empty = {
      facts: {
        branch: null,
        defaultBranch: null,
        dirty: false,
        unmergedCommits: null,
        openPullRequest: null,
        forge: null,
      },
      gitRoot: null,
      remote: null,
    }
    const gitRoot = await out(cwd, ['rev-parse', '--show-toplevel'])
    if (!gitRoot) return empty
    const [branch, originHead, status, remoteUrl] = await Promise.all([
      out(gitRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      out(gitRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
      git(gitRoot, ['status', '--porcelain=v1', '--untracked-files=normal']),
      out(gitRoot, ['remote', 'get-url', 'origin']),
    ])
    let defaultBranch = originHead?.startsWith('origin/') ? originHead.slice('origin/'.length) : null
    if (!defaultBranch) {
      for (const candidate of ['main', 'master']) {
        if (await out(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`])) {
          defaultBranch = candidate
          break
        }
      }
    }
    const remote = remoteUrl ? forgeOfRemote(remoteUrl) : null
    const dirty = !status.ok || status.stdout.trim().length > 0
    let openPullRequest: boolean | null = null
    let mergedHeads: string[] = []
    if (branch && remote?.forge === 'github' && branch !== defaultBranch) {
      const lookup = await lookUp(gitRoot, branch, options.fresh === true)
      openPullRequest = lookup.open
      mergedHeads = lookup.mergedHeads
    }
    const unmergedCommits = branch && defaultBranch ? await countUnmerged(gitRoot, defaultBranch, mergedHeads) : null
    return {
      facts: { branch, defaultBranch, dirty, unmergedCommits, openPullRequest, forge: remote?.forge ?? null },
      gitRoot,
      remote,
    }
  }

  /** Whether the branch has an open pull request (whoever opened it), and the heads its merged ones carried. */
  async function lookUp(gitRoot: string, branch: string, fresh: boolean): Promise<Lookup> {
    const key = `${gitRoot}\0${branch}`
    const held = lookups.get(key)
    if (held && !fresh && now() - held.at < LOOKUP_HOLD_MS) return held
    const read = await listBranch({ gitRoot, branch })
    const lookup: Lookup = read.settled
      ? {
          at: now(),
          open: read.pullRequests.some((pr) => pr.state === 'open'),
          mergedHeads: read.pullRequests.flatMap((pr) =>
            pr.state === 'merged' && pr.headRefOid ? [pr.headRefOid] : [],
          ),
        }
      : { at: now(), open: null, mergedHeads: held?.mergedHeads ?? [] }
    lookups.set(key, lookup)
    return lookup
  }

  /** Commits on HEAD that neither `origin/<default>` nor a merged pull request's head carries. */
  async function countUnmerged(gitRoot: string, defaultBranch: string, mergedHeads: string[]): Promise<number | null> {
    const base = (await out(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`]))
      ? `origin/${defaultBranch}`
      : defaultBranch
    // Only a head this clone has: one it never fetched cannot be excluded,
    // and the commits it carried were pushed from somewhere else.
    const known: string[] = []
    for (const head of mergedHeads) {
      if (await out(gitRoot, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`])) known.push(head)
    }
    const counted = await out(gitRoot, ['rev-list', '--count', `${base}..HEAD`, ...known.map((head) => `^${head}`)])
    if (counted === null) return null
    const count = Number.parseInt(counted, 10)
    return Number.isFinite(count) ? count : null
  }

  async function state(cwd: string): Promise<CreatePullRequestState> {
    const { facts, gitRoot } = await readFacts(cwd)
    return {
      readiness: createPullRequestReadiness(facts),
      gitRoot,
      branch: facts.branch,
      base: facts.defaultBranch,
      forge: facts.forge,
    }
  }

  /** What a draft is written from: the branch's commits and diff against the base, its template, its convention. */
  async function draftInput(cwd: string): Promise<DraftInputOutcome> {
    const { facts, gitRoot } = await readFacts(cwd)
    if (!gitRoot || !facts.branch || !facts.defaultBranch) {
      return { ok: false, message: 'This folder is not a checkout on a branch.' }
    }
    const base = (await out(gitRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${facts.defaultBranch}`,
    ]))
      ? `origin/${facts.defaultBranch}`
      : facts.defaultBranch
    const [commits, diffStat, patch, history] = await Promise.all([
      out(gitRoot, ['log', '--no-merges', '--format=%s%n%n%b%n---', `${base}..HEAD`]),
      out(gitRoot, ['diff', '--stat', `${base}...HEAD`]),
      out(gitRoot, ['diff', `${base}...HEAD`]),
      out(gitRoot, ['log', '-30', '--format=%s', base]),
    ])
    let template: string | null = null
    for (const candidate of TEMPLATE_PATHS) {
      const text = await readFile(path.join(gitRoot, candidate), 'utf8').catch(() => null)
      if (text && text.trim()) {
        template = text.replace(/<!--[\s\S]*?-->/g, '').trim()
        break
      }
    }
    return {
      ok: true,
      input: {
        base: facts.defaultBranch,
        head: facts.branch,
        commits: commits ?? '',
        diffStat: diffStat ?? '',
        patch: (patch ?? '').slice(0, MAX_PATCH_READ_CHARS),
        template,
        conventionalCommits: followsConventionalCommits((history ?? '').split('\n')),
      },
    }
  }

  /**
   * Where the branch is pushed, chosen as a plain `git push` chooses:
   * `branch.<b>.pushRemote` (origin included), then `remote.pushDefault`, then
   * the branch's own remote when it tracks its namesake there (a branch set up
   * on a fork as `fork/<b>`), then origin. A configured push remote that does
   * not exist is an error, as it is for git, never a quiet push to origin.
   *
   * `setUpstream` only for a branch that tracks nothing yet or tracks the
   * trunk (cut from `origin/main`), and pushed where no setting sent it: a
   * branch configured to push elsewhere keeps the upstream it was given.
   */
  async function pushTargetOf(
    gitRoot: string,
    branch: string,
    defaultBranch: string | null,
  ): Promise<{ ok: true; remote: string; setUpstream: boolean } | { ok: false; message: string }> {
    for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault']) {
      const named = await out(gitRoot, ['config', '--get', key])
      if (!named) continue
      // A URL in the setting is a remote too, for git.
      if ((await out(gitRoot, ['remote', 'get-url', '--push', named])) || /[:/]/u.test(named)) {
        return { ok: true, remote: named, setUpstream: false }
      }
      return {
        ok: false,
        message: `Git is set to push this branch to “${named}” (${key}), and this checkout has no remote of that name. Add the remote or change the setting, then push again.`,
      }
    }
    const [upstreamRemote, upstreamMerge] = await Promise.all([
      out(gitRoot, ['config', '--get', `branch.${branch}.remote`]),
      out(gitRoot, ['config', '--get', `branch.${branch}.merge`]),
    ])
    if (
      upstreamRemote &&
      upstreamRemote !== '.' &&
      upstreamMerge === `refs/heads/${branch}` &&
      (await out(gitRoot, ['remote', 'get-url', '--push', upstreamRemote]))
    ) {
      return { ok: true, remote: upstreamRemote, setUpstream: false }
    }
    const tracksTrunk =
      upstreamRemote === 'origin' && defaultBranch !== null && upstreamMerge === `refs/heads/${defaultBranch}`
    return { ok: true, remote: 'origin', setUpstream: !upstreamMerge || tracksTrunk }
  }

  /**
   * Push the branch to its own name on its push remote when that does not have
   * all of it. Always to `refs/heads/<branch>`, never a bare `git push`, which
   * follows the upstream: a branch cut from `origin/main` tracks main.
   */
  async function push(cwd: string): Promise<PushForPullRequestOutcome> {
    const { facts, gitRoot } = await readFacts(cwd)
    const ready = createPullRequestReadiness(facts)
    if (!gitRoot || !facts.branch) return { ok: false, message: 'This folder is not a checkout on a branch.' }
    if (!ready.ready) return { ok: false, message: readinessMessage(ready) }
    const target = await pushTargetOf(gitRoot, facts.branch, facts.defaultBranch)
    if (!target.ok) return target
    const { remote } = target
    const refspec = `HEAD:refs/heads/${facts.branch}`
    // Only the branch's own namesake on the push remote is "already pushed".
    const pushedRef = `refs/remotes/${remote}/${facts.branch}`
    if (await out(gitRoot, ['rev-parse', '--verify', '--quiet', pushedRef])) {
      const ahead = Number.parseInt((await out(gitRoot, ['rev-list', '--count', `${pushedRef}..HEAD`])) ?? '0', 10)
      if (!(ahead > 0)) return { ok: true, pushed: false }
    }
    const pushed = await git(gitRoot, ['push', ...(target.setUpstream ? ['-u'] : []), remote, refspec])
    return pushed.ok ? { ok: true, pushed: true } : { ok: false, message: gitFailure('push', pushed) }
  }

  /** `owner:branch` for a branch pushed to a fork, as `gh pr create --head` names it; the branch alone on origin. */
  async function headOf(gitRoot: string, branch: string, defaultBranch: string | null): Promise<string> {
    const target = await pushTargetOf(gitRoot, branch, defaultBranch)
    if (!target.ok || target.remote === 'origin') return branch
    // The remote's own address names the fork's owner (a push URL may be a mirror).
    const url = (await out(gitRoot, ['remote', 'get-url', target.remote])) ?? target.remote
    const owner = forgeOfRemote(url)?.webUrl.split('/').at(-2)
    return owner ? `${owner}:${branch}` : branch
  }

  /** Open the pull request: `gh pr create` on GitHub, the forge's own page elsewhere. */
  async function create(cwd: string, text: { title: string; body: string }): Promise<CreatePullRequestOutcome> {
    const title = text.title.trim()
    if (!title) return { ok: false, message: 'A pull request needs a title.' }
    const { facts, gitRoot, remote } = await readFacts(cwd, { fresh: true })
    if (!gitRoot || !facts.branch || !facts.defaultBranch || !remote) {
      return { ok: false, message: 'This checkout has no branch and remote to open a pull request from.' }
    }
    if (remote.forge !== 'github') {
      const url = newPullRequestPageUrl(remote, facts.defaultBranch, facts.branch)
      return url
        ? { ok: true, kind: 'page', url }
        : { ok: false, message: 'Pull requests on this forge cannot be opened from here yet.' }
    }
    const scratch = await mkdtemp(path.join(tmpdir(), 'sprintengine-pr-'))
    try {
      const bodyFile = path.join(scratch, 'body.md')
      await writeFile(bodyFile, text.body, 'utf8')
      const gh = deps.gh ?? sharedGhRunner()
      const result = await gh.run(
        [
          'pr',
          'create',
          '--base',
          facts.defaultBranch,
          '--head',
          await headOf(gitRoot, facts.branch, facts.defaultBranch),
          '--title',
          title,
          '--body-file',
          bodyFile,
        ],
        { cwd: gitRoot, timeoutMs: GH_CREATE_TIMEOUT_MS },
      )
      lookups.delete(`${gitRoot}\0${facts.branch}`)
      if (!result.found) {
        return { ok: false, message: 'The GitHub CLI (gh) is not installed. Install it and run `gh auth login`.' }
      }
      if (result.timedOut) return { ok: false, message: 'gh did not answer in time.' }
      const output = `${result.stdout}\n${result.stderr}`
      const url = firstPullRequestUrl(output)
      if (result.code === 0 && url) return { ok: true, kind: 'created', url }
      // The branch already has one, whoever opened it: shown, not claimed.
      // Only gh's own refusal says so, not the words in a title it echoed.
      if (url && result.code !== 0 && GH_ALREADY_EXISTS.test(output)) return { ok: true, kind: 'existing', url }
      return { ok: false, message: lastLines(result.stderr || result.stdout) || `gh exited ${result.code}.` }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { state, draftInput, push, create }
}

export type PullRequestCreator = ReturnType<typeof createPullRequestCreator>

function readinessMessage(readiness: Extract<CreatePullRequestReadiness, { ready: false }>): string {
  switch (readiness.reason) {
    case 'detached':
      return 'Check out a branch first: HEAD is detached.'
    case 'default-branch':
      return "This is the repository's default branch. Work on a branch of its own to open a pull request."
    case 'uncommitted':
      return 'Commit or stash the changes first: a pull request proposes committed work.'
    case 'nothing-to-propose':
      return 'The branch has no commits that are not already on the default branch.'
    case 'open-pull-request':
      return 'This branch already has an open pull request.'
    case 'no-remote':
      return 'This checkout has no remote named origin to open a pull request on.'
    case 'unsupported-forge':
      return 'Pull requests on this forge cannot be opened from here yet.'
  }
}

function gitFailure(step: string, result: { stderr: string; message: string | null }): string {
  const detail = lastLines(result.stderr) || result.message || ''
  return detail ? `git ${step} failed: ${detail}` : `git ${step} failed.`
}

function firstPullRequestUrl(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const classified = classifyPullRequestUrl(match[0].replace(/[.,;:!?)]+$/, ''))
    if (classified?.forge === 'github') return classified.url
  }
  return null
}

/** The last few lines of a tool's error output: where it says why. */
function lastLines(text: string, count = 3): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' ')
}
