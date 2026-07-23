import assert from 'node:assert/strict'

import {
  declareSprintProject,
  rebaseSprintRepos,
  resolveDefaultSprintProject,
  sprintRepoDeclarations,
  sprintRepoIdFor,
  sprintRepoRootFor,
  validateSprintProjectSelection,
  type SprintDeclaredRepo,
} from './sprintProjectSelection'

const PROJECTS = [
  { folderPath: '/work/multicode', displayName: 'multicode' },
  { folderPath: '/work/multiauth', displayName: 'multiauth' },
  { folderPath: '/work/multicode-mobile', displayName: 'multicode-mobile' },
]

// A probe that says yes to a fixed set of paths and no to everything else —
// the same shape the wizard hands over (`window.api.pathExists`).
function probeFor(existing: string[]) {
  const set = new Set(existing)
  return { pathExists: async (path: string) => set.has(path) }
}

const GIT_PROJECTS = probeFor([
  ...PROJECTS.map((project) => project.folderPath),
  ...PROJECTS.map((project) => `${project.folderPath}/.git`),
  '/work/not-a-repo',
  '/work/multicode/packages/sdk',
  '/work/multicode/packages/sdk/.git',
  '/work',
  '/work/.git',
])

// ---- Default project: the wizard opens on the project you were last in. ----
{
  assert.equal(
    resolveDefaultSprintProject({
      projects: PROJECTS,
      activeFolderPath: '/work/multiauth',
      recentFolders: ['/work/multicode'],
    }),
    '/work/multiauth',
    'the active workspace project wins over recents',
  )

  assert.equal(
    resolveDefaultSprintProject({
      projects: PROJECTS,
      activeFolderPath: null,
      recentFolders: ['/work/nowhere', '/work/multicode-mobile', '/work/multiauth'],
    }),
    '/work/multicode-mobile',
    'with no active workspace the most recent KNOWN project wins',
  )

  assert.equal(
    resolveDefaultSprintProject({
      projects: PROJECTS,
      activeFolderPath: null,
      recentFolders: [],
    }),
    '/work/multicode',
    'with no recents at all the first known project is offered rather than an empty field',
  )

  assert.equal(
    resolveDefaultSprintProject({ projects: [], activeFolderPath: null, recentFolders: ['/work/x'] }),
    null,
    'a machine with no open projects seeds nothing',
  )
}

// ---- Handles and roots. ----
{
  assert.equal(sprintRepoIdFor('/work/multicode-mobile', new Set()), 'multicode-mobile')
  assert.equal(
    sprintRepoIdFor('/elsewhere/multiauth', new Set(['multiauth'])),
    'multiauth-2',
    'a taken handle is disambiguated, not dropped',
  )
  assert.equal(
    sprintRepoIdFor('/work/primary', new Set()),
    'primary-2',
    '`primary` is reserved for the run own project',
  )
  assert.equal(sprintRepoIdFor('/work/---', new Set()), null, 'a name with no legal handle is refused')

  assert.equal(
    sprintRepoRootFor('/work/multicode', '/work/multiauth'),
    '../multiauth',
    'a project beside the primary is declared relative to it',
  )
  assert.equal(
    sprintRepoRootFor('/work/a/multicode', '/work/b/c/multiauth'),
    '../../b/c/multiauth',
    'a deeper neighbour walks up and back down',
  )
  assert.equal(
    sprintRepoRootFor('C:/work/multicode', 'D:/other/multiauth'),
    'D:/other/multiauth',
    'with no shared ancestor the absolute path is declared instead',
  )
}

// ---- Validation mirrors the engine rules, before init runs. ----
async function testValidation(): Promise<void> {
  const rejection = async (candidate: string, primary: string | null = '/work/multicode') =>
    (await validateSprintProjectSelection(
      { primaryFolderPath: primary, candidateFolderPath: candidate, alreadyDeclared: [] },
      GIT_PROJECTS,
    ))?.reason ?? null

  assert.equal(await rejection('/work/multiauth'), null, 'a git project beside the primary is accepted')

  assert.match(
    (await rejection('/work/multicode')) ?? '',
    /already runs in/,
    'the primary project itself is refused',
  )
  assert.match(
    (await rejection('/work/multicode/packages/sdk')) ?? '',
    /inside this sprint's project/,
    'a nested path is refused with the reason',
  )
  assert.match(
    (await rejection('/work')) ?? '',
    /contains this sprint's project/,
    'a folder that holds the primary is refused',
  )
  assert.match(
    (await rejection('/work/not-a-repo')) ?? '',
    /not a git project/,
    'a folder that is not a git project is refused with the reason',
  )
  assert.match(
    (await rejection('/work/vanished')) ?? '',
    /no folder at/,
    'a path that is not on disk is refused',
  )
  assert.match(
    (await rejection('/work/multiauth', null)) ?? '',
    /Choose the project this sprint runs in first/,
    'nothing can be declared before a primary project exists',
  )
  // A shared name prefix is not containment: `multicode-mobile` sits BESIDE
  // `multicode`, and a plain `startsWith` would have refused it.
  assert.equal(
    await rejection('/work/multicode-mobile'),
    null,
    'a neighbour whose name starts with the primary name is still a separate project',
  )

  const declared: SprintDeclaredRepo[] = [
    { id: 'multiauth', root: '../multiauth', folderPath: '/work/multiauth', displayName: 'multiauth' },
  ]
  const duplicate = await validateSprintProjectSelection(
    { primaryFolderPath: '/work/multicode', candidateFolderPath: '/work/multiauth', alreadyDeclared: declared },
    GIT_PROJECTS,
  )
  assert.match(duplicate?.reason ?? '', /already on this sprint/, 'the same project cannot be declared twice')
}

// ---- Declaring mints the engine payload; a rejection changes nothing. ----
async function testDeclare(): Promise<void> {
  const ok = await declareSprintProject(
    {
      primaryFolderPath: '/work/multicode',
      candidateFolderPath: '/work/multicode-mobile',
      displayName: 'multicode-mobile',
      alreadyDeclared: [],
    },
    GIT_PROJECTS,
  )
  assert.ok('repo' in ok, 'a valid project is declared')
  if ('repo' in ok) {
    assert.deepEqual(ok.repo, {
      id: 'multicode-mobile',
      root: '../multicode-mobile',
      folderPath: '/work/multicode-mobile',
      displayName: 'multicode-mobile',
    })
  }

  const refused = await declareSprintProject(
    {
      primaryFolderPath: '/work/multicode',
      candidateFolderPath: '/work/not-a-repo',
      alreadyDeclared: [],
    },
    GIT_PROJECTS,
  )
  assert.ok('rejection' in refused, 'an invalid project yields a reason, never a declaration')
}

// ---- What creation sends. ----
{
  const repos: SprintDeclaredRepo[] = [
    { id: 'multiauth', root: '../multiauth', folderPath: '/work/multiauth', displayName: 'multiauth' },
    { id: 'mobile', root: '../multicode-mobile', folderPath: '/work/multicode-mobile', displayName: 'mobile' },
  ]
  assert.deepEqual(
    sprintRepoDeclarations(repos, true),
    [
      { id: 'multiauth', root: '../multiauth' },
      { id: 'mobile', root: '../multicode-mobile' },
    ],
    'only the engine fields are declared',
  )
  assert.deepEqual(
    sprintRepoDeclarations(repos, false),
    [],
    'without worktrees nothing is declared — the engine refuses that pair',
  )
}

// ---- Switching the primary project moves the others with it. ----
{
  const repos: SprintDeclaredRepo[] = [
    { id: 'multiauth', root: '../multiauth', folderPath: '/work/multiauth', displayName: 'multiauth' },
    { id: 'sdk', root: '../multicode/packages/sdk', folderPath: '/work/multicode/packages/sdk', displayName: 'sdk' },
  ]
  const rebased = rebaseSprintRepos(repos, '/work/a/multicode')
  assert.deepEqual(
    rebased.map((repo) => repo.root),
    ['../../multiauth', '../../multicode/packages/sdk'],
    'roots are rewritten against the new primary',
  )

  assert.deepEqual(
    rebaseSprintRepos(repos, '/work/multiauth').map((repo) => repo.id),
    ['sdk'],
    'a project that becomes the primary drops out of the extras',
  )
  assert.deepEqual(
    rebaseSprintRepos(repos, '/work/multicode').map((repo) => repo.id),
    ['multiauth'],
    'a project the new primary contains is no longer a separate project',
  )
  assert.deepEqual(rebaseSprintRepos(repos, null), [], 'with no primary there is nothing to declare against')
}

async function main(): Promise<void> {
  await testValidation()
  await testDeclare()
  console.log('sprintProjectSelection tests passed')
}

void main()
