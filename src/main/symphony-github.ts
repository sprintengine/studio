import { readFile, writeFile } from 'fs/promises'
import { getGitHubRepoRef, type GitHubRepoRef } from './git-github'

type SprintEngineTask = {
  id: string
  title: string
  description: string
  role: string
  status: string
  ownerAgentId: string | null
  dependsOn: string[]
  ownedPaths: string[]
  acceptanceCriteria: string[]
  implementationNotes: string[]
  evidence: {
    summary: string
    touchedFiles: string[]
    commandsRan: string[]
    results: string[]
  }
  notes: string[]
  startedAt: string | null
  completedAt: string | null
  source?: {
    type: 'github'
    externalId: string
    externalUrl: string
    repo: string
    title: string
    externalUpdatedAt: string
    syncedAt: string
    syncStatus: 'clean' | 'local_changed' | 'remote_changed' | 'conflict'
  }
  dispatch?: {
    mode: 'manual'
    status: 'todo' | 'ready'
    triagedBy: 'none' | 'user' | 'architect'
    readyAt?: string
  }
}

type SprintEngineState = {
  _notice?: unknown
  sprintengine?: Record<string, unknown>
  tasks?: SprintEngineTask[]
  agents?: Record<string, unknown>
  events?: unknown[]
  artifacts?: unknown[]
  roles?: Record<string, unknown>
  [key: string]: unknown
}

export type SymphonyGitHubIssue = {
  number: number
  title: string
  body: string
  htmlUrl: string
  updatedAt: string
}

type GitHubIssueApiRecord = {
  number?: unknown
  title?: unknown
  body?: unknown
  html_url?: unknown
  updated_at?: unknown
  pull_request?: unknown
}

export type SymphonyGitHubSyncInput = {
  repoRoot: string
  statePath: string
  token?: string | null
}

export type SymphonyGitHubSyncResult =
  | {
      ok: true
      repo: GitHubRepoRef
      fetched: number
      created: number
      updated: number
      tasks: SprintEngineTask[]
    }
  | { ok: false; message: string }

export async function syncGitHubIssuesIntoSprintEngineTasks(
  input: SymphonyGitHubSyncInput
): Promise<SymphonyGitHubSyncResult> {
  try {
    const repo = await getGitHubRepoRef(input.repoRoot)
    if (!repo) return { ok: false, message: 'No GitHub origin remote was found for this repository.' }

    const token = input.token?.trim() || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
    const issues = await fetchOpenGitHubIssues(repo, token)
    const state = await readSprintEngineState(input.statePath)
    const result = upsertGitHubIssues(state, repo, issues, new Date().toISOString())
    await writeSprintEngineState(input.statePath, state)

    return {
      ok: true,
      repo,
      fetched: issues.length,
      created: result.created,
      updated: result.updated,
      tasks: result.tasks,
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function fetchOpenGitHubIssues(repo: GitHubRepoRef, token: string): Promise<SymphonyGitHubIssue[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=open&per_page=100`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'multicode-symphony-poc',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, { headers })
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'GitHub issue sync failed. Check that the token has Issues read access for this repository.'
      : `GitHub issue sync failed with HTTP ${response.status}.`
    throw new Error(message)
  }

  const payload = await response.json()
  if (!Array.isArray(payload)) throw new Error('GitHub issue sync returned an unexpected response shape.')

  return payload.flatMap((record): SymphonyGitHubIssue[] => {
    const issue = record as GitHubIssueApiRecord
    if (issue.pull_request) return []
    if (
      typeof issue.number !== 'number'
      || typeof issue.title !== 'string'
      || typeof issue.html_url !== 'string'
      || typeof issue.updated_at !== 'string'
    ) {
      return []
    }

    return [{
      number: issue.number,
      title: issue.title,
      body: typeof issue.body === 'string' ? issue.body : '',
      htmlUrl: issue.html_url,
      updatedAt: issue.updated_at,
    }]
  })
}

async function readSprintEngineState(statePath: string): Promise<SprintEngineState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath, 'utf8'))
  } catch (error) {
    throw new Error(`Sprint Engine state must be JSON for Symphony GitHub sync: ${errorMessage(error)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sprint Engine state has an unexpected shape.')
  }
  const state = parsed as SprintEngineState
  if (!Array.isArray(state.tasks)) state.tasks = []
  if (!state.sprintengine || typeof state.sprintengine !== 'object') state.sprintengine = {}
  if (!state.agents || typeof state.agents !== 'object') state.agents = {}
  if (!Array.isArray(state.events)) state.events = []
  if (!Array.isArray(state.artifacts)) state.artifacts = []
  if (!state.roles || typeof state.roles !== 'object') state.roles = {}
  return state
}

async function writeSprintEngineState(statePath: string, state: SprintEngineState): Promise<void> {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function upsertGitHubIssues(
  state: SprintEngineState,
  repo: GitHubRepoRef,
  issues: SymphonyGitHubIssue[],
  syncedAt: string
): { created: number; updated: number; tasks: SprintEngineTask[] } {
  const tasks = state.tasks ?? []
  let created = 0
  let updated = 0
  const repoKey = `${repo.owner}/${repo.repo}`

  for (const issue of issues) {
    const externalId = String(issue.number)
    const existing = tasks.find((task) =>
      task.source?.type === 'github'
      && task.source.externalId === externalId
      && task.source.repo === repoKey
    )

    if (existing) {
      existing.source = {
        type: 'github',
        externalId,
        externalUrl: issue.htmlUrl,
        repo: repoKey,
        title: issue.title,
        externalUpdatedAt: issue.updatedAt,
        syncedAt,
        syncStatus: 'clean',
      }
      updated += 1
      continue
    }

    const task = buildTaskForGitHubIssue(issue, repoKey, syncedAt, tasks)
    tasks.push(task)
    created += 1
  }

  state.tasks = tasks
  return { created, updated, tasks }
}

function buildTaskForGitHubIssue(
  issue: SymphonyGitHubIssue,
  repo: string,
  syncedAt: string,
  existingTasks: SprintEngineTask[]
): SprintEngineTask {
  return {
    id: nextImportedTaskId(existingTasks, issue.number),
    title: issue.title,
    description: issue.body,
    role: 'developer',
    status: 'todo',
    ownerAgentId: null,
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    startedAt: null,
    completedAt: null,
    source: {
      type: 'github',
      externalId: String(issue.number),
      externalUrl: issue.htmlUrl,
      repo,
      title: issue.title,
      externalUpdatedAt: issue.updatedAt,
      syncedAt,
      syncStatus: 'clean',
    },
    dispatch: {
      mode: 'manual',
      status: 'todo',
      triagedBy: 'none',
    },
  }
}

function nextImportedTaskId(tasks: SprintEngineTask[], issueNumber: number): string {
  const used = new Set(tasks.map((task) => task.id))
  const preferred = `GH-${issueNumber}`
  if (!used.has(preferred)) return preferred

  let index = 1
  while (used.has(`${preferred}-${index}`)) index += 1
  return `${preferred}-${index}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
