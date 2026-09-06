import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WorkspaceSkill } from '../shared/electron-api'
import type { SkillTreeEntry } from '../main/skills/scan'
import type { ScanResult, ScannedSkill, SkillSource } from '../shared/skills'
import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'

// ── Seam: a skill source, end to end (T1 → T2 → T3 → T4 → T7, item MC-1932ff) ─
//
// Every task in this run owns one hop of one chain: T1 turns a repository tree
// into skills and writes them into a workspace, T2 picks the shape that list is
// browsed in, T3 opens a skill's files and resolves the links between them, T4
// re-reads a source and re-copies what the workspace holds, T7 keeps the retired
// skill-packs deep link landing on Skills. Each suite proves its own hop against
// inputs it supplies itself, and none of them can show that the hops meet:
//
//  * the scan suite asserts counts and grouping off recorded trees, but stops
//    before `sourceLayout()` and never renders a row;
//  * the surface suite renders every layout from hand-built scans, so nothing
//    there would notice if a real repository stopped producing the scan that
//    layout was written for;
//  * the install and sync suites drive their own `readFile`, so neither crosses
//    the IPC channel names the renderer actually calls, nor the file bytes a
//    real repository would hand back.
//
// So this suite composes the real halves: the real main-process service behind
// the real IPC registration, reached through the real preload passthrough by a
// real mounted surface, over recorded GitHub responses and a real workspace
// directory on disk. The only fake is the network — the fetcher below, which
// answers from `src/main/skills/__fixtures__` and refuses every other host.
//
// FIXTURE FIDELITY. The four trees are complete `git/trees?recursive=1`
// responses at pinned commits. The file bytes are the real bytes at those same
// commits, and `assertRecordedBytes()` re-derives each one's git blob SHA and
// checks it against the SHA the tree recorded — a fixture that drifted from the
// repository it claims to come from fails here rather than quietly passing.
// Only mattpocock/skills carries file bytes (its manifest, and two of its
// skills); every other path answers 404, which is what the scan's enrichment
// already treats as "keep the directory name", so the other sources list under
// their directory names by design rather than by accident.

const dom = installJsdomEnvironment()
const domWindow = dom.window as unknown as Record<string, unknown>

const FIXTURES = join(process.cwd(), 'src', 'main', 'skills', '__fixtures__')
const MANIFEST_PATH = '.claude-plugin/marketplace.json'
const PROTOTYPE_ID = 'skills/engineering/prototype'
const RESEARCH_ID = 'skills/engineering/research'

type RecordedTree = { repo: string; commitSha: string; truncated: boolean; tree: SkillTreeEntry[] }
type RecordedFiles = { repo: string; commitSha: string; files: Record<string, string> }

/** One state of one repository: the tree the scan reads, and the bytes behind it. */
type Revision = { commitSha: string; entries: SkillTreeEntry[]; files: Map<string, string> }

const temporaryDirs: string[] = []

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(path)
  return path
}

function recordedTree(name: string): RecordedTree {
  const tree = JSON.parse(readFileSync(join(FIXTURES, `${name}.tree.json`), 'utf8')) as RecordedTree
  assert.equal(tree.truncated, false, `${name} fixture must be a complete tree`)
  return tree
}

/** The git blob id for some bytes — `sha1("blob <len>\0" + bytes)`. */
function blobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8'), bytes]))
    .digest('hex')
}

/**
 * Every recorded byte must still be the byte the recorded tree names. Without
 * this the suite could run for years against a file somebody edited by hand and
 * report it as what GitHub returns.
 */
function assertRecordedBytes(tree: RecordedTree, files: Map<string, string>): void {
  const byPath = new Map(tree.tree.map((entry) => [entry.path, entry]))
  for (const [path, content] of files) {
    const entry = byPath.get(path)
    assert.ok(entry, `${tree.repo}:${path} is not in the recorded tree`)
    assert.equal(blobSha(content), entry.sha, `${tree.repo}:${path} bytes do not match the recorded blob SHA`)
  }
}

function loadRevision(treeName: string, extraFiles: Record<string, string> = {}): Revision {
  const tree = recordedTree(treeName)
  const files = new Map<string, string>(Object.entries(extraFiles))
  assertRecordedBytes(tree, files)
  return { commitSha: tree.commitSha, entries: tree.tree, files }
}

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** Every file under a directory, as sorted `/`-joined relative paths. */
function filesUnder(root: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...filesUnder(root, path))
    else found.push(path)
  }
  return found.sort()
}

// ── The repositories, as recorded ────────────────────────────────────────────

const prototypeFiles = JSON.parse(readFixture('mattpocock-skills.files.json')) as RecordedFiles

const REPOS = new Map<string, Revision[]>([
  ['mattpocock/skills', [loadRevision('mattpocock-skills', prototypeFiles.files)]],
  [
    'anthropics/skills',
    [loadRevision('anthropics-skills', { [MANIFEST_PATH]: readFixture('anthropics-skills.marketplace.json') })],
  ],
  ['browser-act/skills', [loadRevision('browser-act-skills')]],
  [
    'pbakaus/impeccable',
    [loadRevision('pbakaus-impeccable', { [MANIFEST_PATH]: readFixture('pbakaus-impeccable.marketplace.json') })],
  ],
])

/**
 * A later state of a repository, derived by editing the named skills' entry
 * documents. Each edited file's tree entry is re-derived from the new bytes, so
 * a derived revision is as internally consistent as a recorded one, and its
 * commit id is one nothing recorded — it can never be mistaken for a real head.
 *
 * Derived rather than recorded because a repository has one head at a time:
 * "the source moved" is not something a second recording can supply.
 */
function withEditedEntryDocuments(
  revision: Revision,
  skillIds: readonly string[],
  marker: string,
): Revision {
  const files = new Map(revision.files)
  const edited = new Map<string, string>()
  for (const skillId of skillIds) {
    const path = `${skillId}/SKILL.md`
    const next = `${files.get(path) ?? ''}\n<!-- ${marker} -->\n`
    files.set(path, next)
    edited.set(path, next)
  }
  const entries = revision.entries.map((entry) => {
    const next = edited.get(entry.path)
    return next === undefined ? entry : { ...entry, sha: blobSha(next), size: Buffer.byteLength(next) }
  })
  return { commitSha: blobSha(`${marker}:${revision.commitSha}`), entries, files }
}

/**
 * A second state of mattpocock/skills: the prototype's entry document is
 * edited, and the `research` skill is gone. Both halves of what a sync has to
 * survive.
 */
function nextMattpocockRevision(head: Revision): Revision {
  const edited = withEditedEntryDocuments(head, [PROTOTYPE_ID], 'edited upstream')
  const files = new Map(edited.files)
  for (const path of [...files.keys()]) {
    if (path.startsWith(`${RESEARCH_ID}/`)) files.delete(path)
  }
  const entries = edited.entries.filter(
    (entry) => entry.path !== RESEARCH_ID && !entry.path.startsWith(`${RESEARCH_ID}/`),
  )
  return { commitSha: edited.commitSha, entries, files }
}

/**
 * A state in which `research` is back, at the bytes it was recorded with. A
 * skill leaving a repository and returning is ordinary, and the cross-source
 * work below needs a mattpocock skill whose bytes exist to install — the second
 * state dropped the only one besides `prototype`, and `prototype` is the name
 * the collision case reserves.
 */
function withResearchRestored(recorded: Revision, current: Revision): Revision {
  const files = new Map(current.files)
  for (const [path, content] of recorded.files) {
    if (path.startsWith(`${RESEARCH_ID}/`)) files.set(path, content)
  }
  const restored = recorded.entries.filter(
    (entry) => entry.path === RESEARCH_ID || entry.path.startsWith(`${RESEARCH_ID}/`),
  )
  return {
    commitSha: blobSha(`research-restored:${current.commitSha}`),
    entries: [...current.entries, ...restored],
    files,
  }
}

/** Push a derived state onto a repository's history, and return it. */
function publishRevision(repo: string, revision: Revision): Revision {
  const revisions = REPOS.get(repo)
  assert.ok(revisions, `${repo} is not one of the recorded repositories`)
  revisions.push(revision)
  return revision
}

// ── The network, answered from the fixtures ──────────────────────────────────

const requestedUrls: string[] = []

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 })
}

function headOf(repo: string): Revision | null {
  const revisions = REPOS.get(repo)
  return revisions && revisions.length > 0 ? revisions[revisions.length - 1] : null
}

function revisionOf(repo: string, commitSha: string): Revision | null {
  return REPOS.get(repo)?.find((revision) => revision.commitSha === commitSha) ?? null
}

/**
 * The fixture network. It speaks the two hosts the scan is allowed to reach and
 * nothing else; an unknown path is a 404, never an invented success.
 */
async function fixtureFetch(url: string): Promise<Response> {
  requestedUrls.push(url)
  const parsed = new URL(url)

  if (parsed.hostname === 'api.github.com') {
    const segments = parsed.pathname.split('/').filter(Boolean)
    const repo = `${segments[1]}/${segments[2]}`
    if (!headOf(repo)) return notFound()
    if (segments.length === 3) return jsonResponse({ default_branch: 'main' })
    if (segments[3] === 'commits') return jsonResponse({ sha: headOf(repo)?.commitSha })
    if (segments[3] === 'git' && segments[4] === 'trees') {
      const revision = revisionOf(repo, decodeURIComponent(segments[5]))
      return revision ? jsonResponse({ truncated: false, tree: revision.entries }) : notFound()
    }
    return notFound()
  }

  if (parsed.hostname === 'raw.githubusercontent.com') {
    const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const revision = revisionOf(`${segments[0]}/${segments[1]}`, segments[2])
    const content = revision?.files.get(segments.slice(3).join('/'))
    return content === undefined ? notFound() : new Response(content, { status: 200 })
  }

  throw new Error(`the seam fetcher was asked for a host it does not serve: ${parsed.hostname}`)
}

// ── The suite ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const workspaceRoot = temporaryDir('multicode-seam-skills-ws-')
  const userDataDir = temporaryDir('multicode-seam-skills-userdata-')

  const { createSkillsService } = await import('../main/skills')
  const { createAgentCapabilityService, createFsSkillDirectoryReader, createWorkspaceSkillsService } =
    await import('../main/workspace-skills-service')
  const { createCapabilityWatcher } = await import('../main/capability-watcher')
  const { createAgentSkillInstaller } = await import('../main/agent-skill-installer')
  const { createMcpServerResolver } = await import('../main/mcp-config-readers/resolve-servers')
  const { registerSkillsIpc } = await import('../main/ipc/skills-ipc')
  const { registerWorkspaceSkillsIpc } = await import('../main/ipc/workspace-skills-ipc')
  const { skillsApi } = await import('../preload/api/skills')
  const { workspaceSkillsApi } = await import('../preload/api/workspace-skills')
  const { ipcMain } = await import('electron')

  const service = createSkillsService(userDataDir, {
    resolveToken: async () => '',
    // The two agent CLIs this machine is pretending to have. Real detection
    // probes binaries, which a test machine cannot be asked to have installed.
    listHarnesses: async () => ['claude', 'agents'],
    builtinSkillsRoot: () => join(process.cwd(), 'resources', 'skills'),
    connectorSkillsRoot: () => null,
    listWorkspaceRoots: () => [],
    github: { fetcher: (url) => fixtureFetch(url) },
  })

  // The real registrations, on the stub `electron` that wires `ipcMain.handle`
  // to `ipcRenderer.invoke`: a channel the preload spells differently from the
  // one main registers fails here rather than in production.
  registerSkillsIpc(ipcMain, service)
  // No plugins in this seam: it exercises the skill-source half, and an empty
  // registry is what "this machine has no CLI installed" resolves to.
  const capabilityWatcher = createCapabilityWatcher({ listPlugins: () => [], lookupManifest: () => undefined })
  registerWorkspaceSkillsIpc(ipcMain, {
    workspaceSkills: createWorkspaceSkillsService(),
    agentCapabilities: createAgentCapabilityService({
      reader: createFsSkillDirectoryReader(),
      listPlugins: () => [],
      lookupManifest: () => undefined,
      mcpResolver: createMcpServerResolver(),
      freshness: capabilityWatcher,
    }),
    capabilityWatcher,
    agentSkillInstaller: createAgentSkillInstaller({ listPlugins: () => [] }),
  })
  domWindow.api = withInertPreloadFallback({ platform: 'darwin', ...skillsApi, ...workspaceSkillsApi })

  await testScanBrowseReadInstallSync(workspaceRoot)
  await testCrossSourceCollisionKeepsItsOwnBytes()
  await testLayoutBoundaries()
  await testRetiredSkillPacksDeepLinkStillOpensSkills()

  // Everything this suite did, across every source, stayed inside the two hosts
  // the source policy allows. Checked once at the end so a section added later
  // is covered by it without having to remember to be.
  assert.ok(requestedUrls.length > 0)
  for (const url of requestedUrls) {
    const host = new URL(url).hostname
    assert.ok(
      host === 'api.github.com' || host === 'raw.githubusercontent.com',
      `the run reached a host outside the allowlist: ${host}`,
    )
  }

  console.log('all skill-source seam tests passed')
}

// --- 1932/1933/1934/1935: the chain, through the mounted surface -------------

async function testScanBrowseReadInstallSync(workspaceRoot: string): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { SkillsCatalogue } = await import(
    '../renderer/src/components/workspace/globalSurface/extensions/skills/SkillsCatalogue'
  )
  const { useSkillSources } = await import(
    '../renderer/src/components/workspace/globalSurface/extensions/skills/useSkillSources'
  )
  const { renderSkillInvocation, skillInstalledForHarness } = await import(
    '../renderer/src/utils/skillInvocation'
  )

  const api = domWindow.api as {
    skillsAddSource: (input: { repo: string }) => Promise<{ ok: boolean; message?: string }>
    skillsGetScan: (input: { sourceId: string }) => Promise<{ ok: boolean; scan: ScanResult }>
    workspaceSkillsList: (input: { workspaceRoot: string }) => Promise<{
      ok: boolean
      skills: WorkspaceSkill[]
    }>
  }

  // Add every source the way the Add-a-source modal does — one scan each.
  for (const repo of REPOS.keys()) {
    const added = await api.skillsAddSource({ repo })
    assert.ok(added.ok, `${repo} could not be added: ${added.message ?? ''}`)
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  // The door's half of the surface, played by the smallest host that can: the
  // open tab and the search live above the catalogue (source-tabs ruling,
  // 2026-09-05) because the chosen source survives a switch to Plugins.
  function Host(): JSX.Element {
    const sources = useSkillSources(workspaceRoot)
    const [tabId, setTabId] = React.useState<string | null>(null)
    const [query, setQuery] = React.useState('')
    return (
      <SkillsCatalogue
        sources={sources}
        workspaceRoot={workspaceRoot}
        activeTabId={tabId}
        onSelectTab={(next) => {
          setTabId(next)
          setQuery('')
        }}
        query={query}
        onQueryChange={setQuery}
        add={{ onAddFromFile: () => {}, onAddFromGitHub: () => {} }}
        addNotice={null}
        onDismissAddNotice={() => {}}
        onUseSkillInNewAgent={() => {}}
      />
    )
  }

  const settle = async (rounds = 6): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  const markup = (): string => container.innerHTML
  /** Let a real round trip finish — install and sync read and write real files. */
  const settleUntil = async (what: string, ready: () => boolean): Promise<void> => {
    for (let round = 0; round < 200; round += 1) {
      if (ready()) return
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
    }
    assert.fail(`${what} never finished: ${visibleText(markup())}`)
  }
  const buttons = (): HTMLButtonElement[] =>
    [...container.querySelectorAll('button')] as unknown as HTMLButtonElement[]
  const buttonWith = (text: string): HTMLButtonElement => {
    const found = buttons().find((button) => (button.textContent ?? '').includes(text))
    assert.ok(found, `no button reading "${text}" is on screen`)
    return found
  }
  const buttonLabelled = (label: string): HTMLButtonElement => {
    const found = container.querySelector(`[aria-label="${label}"]`)
    assert.ok(found, `no control labelled "${label}" is on screen`)
    return found as unknown as HTMLButtonElement
  }
  const click = async (button: HTMLButtonElement): Promise<void> => {
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle(3)
  }
  /** Open a source by its TAB — the sources are the tab row now, not a rail. */
  const openSource = async (tabName: string): Promise<void> => {
    const tab = [...container.querySelectorAll('[role="tab"]')].find((candidate) =>
      (candidate.textContent ?? '').startsWith(tabName),
    )
    assert.ok(tab, `no tab for "${tabName}" is on screen`)
    await click(tab as unknown as HTMLButtonElement)
  }
  /** Narrow the open tab to one skill, so a paged source can be acted on. */
  const filterTo = async (needle: string): Promise<void> => {
    const field = container.querySelector('input[type="search"]') as unknown as HTMLInputElement
    assert.ok(field, 'the tab has a search field')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(field, needle)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await settle(3)
  }

  await act(async () => {
    root.render(<Host />)
  })
  await settle()

  // ── Each repository shape, scan input through to the rendered layout ──────

  const scanOf = async (sourceId: string): Promise<ScanResult> => {
    const result = await api.skillsGetScan({ sourceId })
    assert.ok(result.ok, `${sourceId} has no scan`)
    return result.scan
  }

  // Every source lists in FULL now, one page of twelve at a time, under the
  // headings its own folders give it. The four `sourceLayout()` shapes decided
  // how much of a source to put on screen at once, which is the pager's job
  // since the source-tabs ruling (2026-09-05); what survives of that rule is
  // the grouping, and each repository's own shape of it is what this walks.

  // 41 skills in six folders: six headings, and a pager that says 41.
  const mattpocock = await scanOf('github:mattpocock/skills')
  assert.equal(mattpocock.skills.length, 41)
  assert.equal(mattpocock.groupingSignal, 'folders')
  await openSource('mattpocock/skills')
  assert.ok(markup().includes('>Engineering<'), 'the repository’s folders are the headings')
  assert.ok(markup().includes('Showing 1–12 of 41'), 'and one pager walks the whole source')

  // 17 skills the repository's own manifest authors three groups for — the
  // manifest wins over the (flat) folders, and drops the template the manifest
  // does not list.
  const anthropics = await scanOf('github:anthropics/skills')
  assert.equal(anthropics.skills.length, 17)
  assert.equal(anthropics.groupingSignal, 'manifest')
  assert.deepEqual(anthropics.groups, ['document-skills', 'example-skills', 'claude-api'])
  await openSource('anthropics/skills')
  assert.ok(markup().includes('>Document skills<'), 'the manifest’s groups are the headings')
  assert.ok(markup().includes('Showing 1–12 of 17'))
  // The third group is on page 2 — the pager walks the source, so a group that
  // does not fit is reached rather than hidden.
  await click(buttonLabelled('Page 2'))
  assert.ok(markup().includes('>Claude api<'), 'and page 2 carries the group page 1 ran out of room for')

  // 103 skills: listed like any other source, twelve at a time, rather than
  // withheld behind a search box until it is asked.
  const browserAct = await scanOf('github:browser-act/skills')
  assert.equal(browserAct.skills.length, 103)
  await openSource('browser-act/skills')
  assert.ok(markup().includes('Showing 1–12 of 103'))
  assert.equal(markup().includes('Pick a category, or search.'), false)

  // One skill across 3,143 tree entries, mirrored per harness and collapsed to
  // one: a source of one is one row and one page.
  const impeccable = await scanOf('github:pbakaus/impeccable')
  assert.equal(impeccable.skills.length, 1)
  await openSource('pbakaus/impeccable')
  assert.ok(markup().includes('Showing 1–1 of 1'))
  assert.ok(markup().includes('>impeccable<'))

  // The skills Multicode ships, read off disk by the same service, under the
  // name the product goes by.
  const builtin = await scanOf('builtin')
  assert.equal(builtin.skills.length, 12)
  await openSource('SprintEngine Studio')
  assert.ok(markup().includes('Showing 1–12 of 12'), 'the bundled source lists its skills too')

  // ── The reader: a multi-file skill, and the links between its files ────────

  await openSource('mattpocock/skills')
  await filterTo('prototype')
  const prototype = mattpocock.skills.find((skill) => skill.id === PROTOTYPE_ID)
  assert.ok(prototype, 'the prototype skill is in the scan')
  assert.deepEqual(
    prototype.files.map((file) => file.path),
    ['LOGIC.md', 'SKILL.md', 'UI.md', 'agents/openai.yaml'],
    'the whole skill directory is the skill — companions and subdirectory alike',
  )
  // Its entry document was fetched at scan time, so the row states what the
  // frontmatter says rather than the directory name.
  assert.equal(prototype.name, 'prototype')
  assert.ok(prototype.description.startsWith('Build a throwaway prototype'))

  await click(buttonWith('prototype'))
  await settleUntil('the entry document read', () => markup().includes('Pick a branch'))
  assert.ok(markup().includes('aria-label="Files in this skill"'), 'the reader lists the files')
  for (const path of ['SKILL.md', 'LOGIC.md', 'UI.md', 'agents/openai.yaml']) {
    assert.ok(markup().includes(`>${path}<`), `${path} reached the reader's file list`)
  }
  assert.ok(markup().includes('>Entry<'), 'and SKILL.md is marked as the one an agent reads first')

  // The entry document's own bytes, rendered: its two relative links point at
  // files this skill actually ships, so both are live targets in the reader.
  const documentMarkup = markup()
  assert.equal(
    documentMarkup.includes('is not one of this skill'),
    false,
    'no link in the real SKILL.md is dead',
  )
  for (const target of ['LOGIC.md', 'UI.md']) {
    const anchor = documentMarkup.indexOf(`>${target}</button>`)
    assert.ok(anchor > 0, `${target} renders as a control that opens it in the reader`)
  }
  // Following the link inside the document — not the file-list row beside it —
  // opens that file in place, without leaving the skill.
  const linkInDocument = buttons().find(
    (button) =>
      (button.textContent ?? '').trim() === 'LOGIC.md'
      && button.closest('nav[aria-label="Files in this skill"]') === null,
  )
  assert.ok(linkInDocument, 'the entry document carries LOGIC.md as a link, not as prose')
  await click(linkInDocument)
  await settleUntil(
    'the companion document read',
    () => markup().includes('A tiny interactive terminal app'),
  )

  // ── Install: the whole directory, into every harness dir ──────────────────

  // One control per row (the ruling's row idiom), so a row installs itself:
  // the batch checkbox column and its footer "Install 2" are gone.
  await openSource('mattpocock/skills')
  await filterTo('prototype')
  await click(buttonLabelled('Install prototype'))
  await settleUntil('the prototype install', () => markup().includes('Installed 1 skill.'))
  await filterTo('research')
  await click(buttonLabelled('Install research'))
  await settleUntil('the research install', () => markup().includes('Installed 1 skill.'))

  const installed = (harness: string, ...rest: string[]): string =>
    join(workspaceRoot, harness, 'skills', ...rest)
  for (const harness of ['.claude', '.agents']) {
    for (const path of ['SKILL.md', 'LOGIC.md', 'UI.md', join('agents', 'openai.yaml')]) {
      assert.ok(
        existsSync(installed(harness, 'prototype', path)),
        `${harness}/skills/prototype/${path} was not written`,
      )
    }
    assert.equal(
      readFileSync(installed(harness, 'prototype', 'agents', 'openai.yaml'), 'utf8'),
      prototypeFiles.files[`${PROTOTYPE_ID}/agents/openai.yaml`],
      `${harness} received the repository's own bytes, in its own subdirectory`,
    )
  }
  // Both rows say so. A page holds twelve of the source's 41, so each is
  // checked where it is: on the tab filtered to it.
  for (const dirName of ['prototype', 'research']) {
    await filterTo(dirName)
    assert.ok(markup().includes('>Installed<'), `the ${dirName} row says it is installed`)
  }
  // A skill nobody installed keeps its one control, which is the offer.
  await filterTo('qa')
  assert.ok(container.querySelector('[aria-label="Install qa"]'), 'an uninstalled row still offers Install')
  await filterTo('')

  // The installed copy is the one the agent-facing inventory reads, so a skill
  // installed from a source is a skill an agent can be handed.
  const inventory = await api.workspaceSkillsList({ workspaceRoot })
  assert.ok(inventory.ok)
  const research = inventory.skills.find((skill) => skill.id === 'research')
  assert.ok(research, 'the installed skill is listed by the workspace inventory')
  assert.deepEqual(research.harnesses.sort(), ['agents', 'claude'])
  assert.equal(research.installState, 'installed')
  assert.equal(research.source, 'custom')

  // And it is invocable through the path an agent is handed: because the copy
  // landed in the harness dir Claude Code reads, the invocation is that CLI's
  // native form rather than the plain-prompt fallback.
  const claudeIntegration = {
    support: 'native' as const,
    harnessId: 'claude',
    invocation: { explicitTemplate: '/{{skillId}}' },
  }
  assert.equal(skillInstalledForHarness(research, claudeIntegration), true)
  assert.equal(
    renderSkillInvocation({
      skill: research,
      integration: claudeIntegration,
      nativeInstalled: skillInstalledForHarness(research, claudeIntegration),
    }),
    '/research',
  )
  // FINDING T9-F1, re-checked after provenance landed and still open: a source
  // skill whose directory name collides with one Multicode ships is reported as
  // `source: 'builtin'`, because the inventory keys provenance on the directory
  // name alone. `prototype` is such a name, and the bytes on disk are
  // mattpocock's. Install now writes a marker that says so — the disagreement
  // below is the defect, pinned so that fixing the inventory to read the marker
  // fails this line rather than passing silently.
  const inventoryPrototype = inventory.skills.find((skill) => skill.id === 'prototype')
  assert.ok(inventoryPrototype)
  assert.equal(inventoryPrototype.source, 'builtin', 'observed today: the collision is reported as builtin')
  const { readSkillProvenance } = await import('../main/skills/install')
  const prototypeProvenance = await readSkillProvenance(installed('.claude', 'prototype'))
  assert.equal(
    prototypeProvenance?.sourceId,
    'github:mattpocock/skills',
    'the copy on disk records the source it actually came from',
  )
  assert.notEqual(
    inventoryPrototype.source,
    'custom',
    'T9-F1 is open: the inventory still ignores the marker beside the bytes it is describing',
  )

  // ── Sync: the source moves, and the workspace moves with it ───────────────

  const head = headOf('mattpocock/skills')
  assert.ok(head)
  publishRevision('mattpocock/skills', nextMattpocockRevision(head))

  await click(buttonWith('Sync'))
  await settleUntil('the sync', () => markup().includes('Synced ·'))

  const synced = await scanOf('github:mattpocock/skills')
  assert.equal(synced.skills.length, 40, 'the refreshed list is the repository as it is now')
  assert.equal(
    synced.skills.some((skill) => skill.id === RESEARCH_ID),
    false,
    'a skill removed upstream leaves the source listing',
  )
  assert.ok(
    markup().includes('Synced · 1 removed upstream · 1 installed skill updated'),
    `the sync line states what changed, in counts: ${visibleText(markup())}`,
  )

  // Re-copied, not merely re-listed: the bytes under both harness dirs are the
  // ones the new commit carries.
  for (const harness of ['.claude', '.agents']) {
    const onDisk = readFileSync(installed(harness, 'prototype', 'SKILL.md'), 'utf8')
    assert.ok(onDisk.includes('<!-- edited upstream -->'), `${harness} still holds the pre-sync bytes`)
  }
  // The skill that disappeared upstream keeps the copy the workspace already
  // had. Dropping out of a listing is not a reason to take a working skill away
  // from the agents reading it.
  assert.ok(
    existsSync(installed('.claude', 'research', 'SKILL.md')),
    'an upstream removal must not delete an installed skill',
  )

  // One tree request per scan — the property that makes a repository of any
  // size one call, and this suite offline. (The host allowlist is checked once
  // for the whole run, at the end of `main`.)
  const treeRequests = requestedUrls.filter((url) => url.includes('/git/trees/'))
  assert.equal(treeRequests.length, 5, 'four sources scanned, and one re-scanned by the sync')

  await act(async () => {
    root.unmount()
  })
  container.remove()
}

// --- T13/T14: what a sync may overwrite is what that source installed --------

/**
 * Two sources shipping a directory of the same name is ordinary — Multicode's
 * own `prototype` and mattpocock's are the pair that broke this — and before
 * install recorded provenance, syncing either one replaced the other's bytes on
 * disk. This walks that collision through the same real IPC the chain above
 * uses, in a workspace of its own so the state is the one being described:
 *
 *  1. a workspace holding Multicode's `prototype`, and nothing from mattpocock;
 *  2. mattpocock moves and is synced — its own `prototype` changed upstream,
 *     and the bytes on disk must not move, because that copy is not its;
 *  3. the user installs a mattpocock skill, mattpocock moves again, and that
 *     one *is* re-copied — the protection must not have closed the feature.
 */
async function testCrossSourceCollisionKeepsItsOwnBytes(): Promise<void> {
  const { skillDirName } = await import('../shared/skills')
  const { readSkillProvenance, SKILL_PROVENANCE_FILE } = await import('../main/skills/install')

  const api = domWindow.api as {
    skillsGetScan: (input: { sourceId: string }) => Promise<{ ok: boolean; scan: ScanResult }>
    skillsInstall: (input: {
      sourceId: string
      skillId: string
      workspaceRoot: string
    }) => Promise<{ ok: boolean; message?: string }>
    skillsSyncSource: (input: { sourceId: string; workspaceRoot: string }) => Promise<{
      ok: boolean
      message?: string
      refreshed: number
      failures: { skillId: string; message: string }[]
    }>
  }

  const workspaceRoot = temporaryDir('multicode-seam-skills-collision-')
  const installedPath = (harness: string, ...rest: string[]): string =>
    join(workspaceRoot, harness, 'skills', ...rest)
  const HARNESS_DIRS = ['.claude', '.agents'] as const
  const bytesAt = (harness: string, ...rest: string[]): string =>
    readFileSync(installedPath(harness, ...rest), 'utf8')

  const scanOf = async (sourceId: string): Promise<ScanResult> => {
    const result = await api.skillsGetScan({ sourceId })
    assert.ok(result.ok, `${sourceId} has no scan`)
    return result.scan
  }
  const idOfSkillNamed = (scan: ScanResult, dirName: string): string => {
    const found = scan.skills.find((skill) => skillDirName(skill.id) === dirName)
    assert.ok(found, `no skill installs as "${dirName}" in this source`)
    return found.id
  }
  const install = async (sourceId: string, skillId: string): Promise<void> => {
    const result = await api.skillsInstall({ sourceId, skillId, workspaceRoot })
    assert.ok(result.ok, `${sourceId}:${skillId} could not be installed: ${result.message ?? ''}`)
  }
  const sync = async (): Promise<{ refreshed: number; failures: { skillId: string }[] }> => {
    const result = await api.skillsSyncSource({ sourceId: 'github:mattpocock/skills', workspaceRoot })
    assert.ok(result.ok, `the sync failed: ${result.message ?? ''}`)
    // A failed copy is not a protected copy. Reading the failures here keeps a
    // "bytes unchanged" pass from ever meaning "the fetch 404ed".
    assert.deepEqual(result.failures, [], 'no copy this sync attempted failed')
    return result
  }

  // ── 1. The workspace holds Multicode's own `prototype` ────────────────────

  const builtinScan = await scanOf('builtin')
  await install('builtin', idOfSkillNamed(builtinScan, 'prototype'))

  const shippedRoot = join(process.cwd(), 'resources', 'skills', 'prototype')
  /**
   * Every file of the installed copy, against the directory Multicode ships —
   * the marker aside, which install writes and the source never had. Compares
   * the whole directory rather than the entry document alone: mattpocock's
   * prototype ships files Multicode's does not, so a partial overwrite shows up
   * as an extra file even when SKILL.md happens to match.
   */
  const shippedFiles = filesUnder(shippedRoot)
  assert.ok(shippedFiles.length > 1, 'the shipped prototype is more than one file, so a partial copy is visible')
  const assertHoldsShippedPrototype = (harness: string, when: string): void => {
    assert.deepEqual(
      filesUnder(installedPath(harness, 'prototype')).filter((path) => path !== SKILL_PROVENANCE_FILE),
      shippedFiles,
      `${harness}/skills/prototype holds exactly the shipped directory ${when}`,
    )
    for (const path of shippedFiles) {
      assert.equal(
        bytesAt(harness, 'prototype', ...path.split('/')),
        readFileSync(join(shippedRoot, ...path.split('/')), 'utf8'),
        `${harness}/skills/prototype/${path} ${when}`,
      )
    }
  }
  for (const harness of HARNESS_DIRS) assertHoldsShippedPrototype(harness, 'as installed')
  assert.equal(
    (await readSkillProvenance(installedPath('.claude', 'prototype')))?.sourceId,
    'builtin',
    'and the copy records which source wrote it',
  )
  // mattpocock ships a `prototype` too — without that, nothing below collides.
  const mattpocockScan = await scanOf('github:mattpocock/skills')
  const mattpocockPrototype = idOfSkillNamed(mattpocockScan, 'prototype')

  // ── 2. mattpocock moves; the directory it does not own does not move ───────

  const head = headOf('mattpocock/skills')
  const recorded = REPOS.get('mattpocock/skills')?.[0]
  assert.ok(head && recorded)
  // `research` returns upstream (installable in step 3), and `prototype`'s entry
  // document changes — so a sync that wrongly claimed that directory would show
  // in the bytes rather than being silently identical to what is already there.
  publishRevision(
    'mattpocock/skills',
    withEditedEntryDocuments(
      withResearchRestored(recorded, head),
      [PROTOTYPE_ID],
      'a source that does not own it',
    ),
  )

  // A directory nothing claims: the shape every copy installed before markers
  // existed has, and the shape a hand-made skill has. Sync cannot tell which
  // source it came from, so it must not assume it came from this one.
  const unclaimed = '<!-- a copy no marker claims -->\n'
  for (const harness of HARNESS_DIRS) {
    mkdirSync(installedPath(harness, 'research'), { recursive: true })
    writeFileSync(installedPath(harness, 'research', 'SKILL.md'), unclaimed, 'utf8')
  }

  const crossSourceSync = await sync()
  assert.equal(
    crossSourceSync.refreshed,
    0,
    'a source refreshes nothing when no installed directory is one it wrote',
  )
  for (const harness of HARNESS_DIRS) {
    assert.equal(
      bytesAt(harness, 'research', 'SKILL.md'),
      unclaimed,
      `${harness} kept the unclaimed copy — a name match is not ownership`,
    )
  }
  const refreshedList = await scanOf('github:mattpocock/skills')
  assert.ok(
    refreshedList.skills.some((skill) => skill.id === mattpocockPrototype),
    'mattpocock still lists a prototype — the sync passed over an installed name it was offering',
  )
  for (const harness of HARNESS_DIRS) assertHoldsShippedPrototype(harness, 'after another source synced')
  assert.equal(
    (await readSkillProvenance(installedPath('.claude', 'prototype')))?.sourceId,
    'builtin',
    'and the marker still names the source that installed it',
  )

  // ── 3. The same source, over its own copy: still refreshed ────────────────

  // Installing is what claims a directory — the way out of the unclaimed state
  // above, and the state a plain install leaves behind either way.
  const researchId = idOfSkillNamed(refreshedList, 'research')
  await install('github:mattpocock/skills', researchId)
  const installedResearch = bytesAt('.claude', 'research', 'SKILL.md')
  assert.notEqual(installedResearch, unclaimed, 'an explicit install does replace what it installs over')
  assert.equal(
    (await readSkillProvenance(installedPath('.claude', 'research')))?.sourceId,
    'github:mattpocock/skills',
    'the copy the user chose is claimed by the source they chose it from',
  )

  // Both move this time: the one this source owns, and the one it does not.
  const moved = headOf('mattpocock/skills')
  assert.ok(moved)
  publishRevision(
    'mattpocock/skills',
    withEditedEntryDocuments(moved, [RESEARCH_ID, PROTOTYPE_ID], 'moved again'),
  )
  const sameSourceSync = await sync()
  assert.equal(sameSourceSync.refreshed, 1, 'the copy this source installed is the one it re-copies')
  for (const harness of HARNESS_DIRS) {
    assert.ok(
      bytesAt(harness, 'research', 'SKILL.md').includes('<!-- moved again -->'),
      `${harness} took the new bytes of the skill this source owns`,
    )
    assertHoldsShippedPrototype(harness, 'through a sync that did copy')
  }
  assert.equal(
    installedResearch.includes('<!-- moved again -->'),
    false,
    'and the pre-sync bytes really were different, so the check above proves a write',
  )

  // ── The marker is an install artefact, not a skill file ───────────────────
  //
  // It is written into the copy and never back into the source, so it cannot
  // reach the file list the reader renders or the files a later install reads.
  const prototypeFileList = mattpocockScan.skills.find((skill) => skill.id === mattpocockPrototype)?.files ?? []
  assert.equal(
    prototypeFileList.some((file) => file.path === SKILL_PROVENANCE_FILE),
    false,
    'no source lists the marker among its own files',
  )
}

/** The visible text of the surface, for a failure message worth reading. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600)
}

// --- 1933 D4: the layout thresholds, at their edges --------------------------

async function testLayoutBoundaries(): Promise<void> {
  const { sourceLayout } = await import('../shared/skills')
  const { deriveSourceView } = await import(
    '../renderer/src/components/workspace/globalSurface/extensions/skills/skillsSurfaceModel'
  )

  const source: SkillSource = {
    id: 'github:example/skills',
    kind: 'github',
    name: 'skills',
    repo: 'example/skills',
    monogram: 'ES',
    blurb: '',
    commitSha: 'a'.repeat(40),
    scannedAt: '2026-07-28T00:00:00Z',
  }

  const scanOf = (count: number, groupCount: number): ScanResult => {
    const groups = Array.from({ length: groupCount }, (_, index) => `group-${index}`)
    const skills: ScannedSkill[] = Array.from({ length: count }, (_, index) => ({
      id: groupCount > 0 ? `skills/${groups[index % groupCount]}/skill-${index}` : `skills/skill-${index}`,
      name: `skill-${index}`,
      description: '',
      group: groupCount > 0 ? groups[index % groupCount] : '',
      files: [{ path: 'SKILL.md', size: 100, blobSha: 'b'.repeat(40), isEntry: true }],
      allowedTools: [],
      hasExecutables: false,
    }))
    return {
      skills,
      groups,
      groupingSignal: groupCount > 0 ? 'folders' : 'none',
      fileCount: count,
      commitSha: source.commitSha,
    }
  }

  const viewKind = (scan: ScanResult): string =>
    deriveSourceView({ source, scan, installedDirNames: new Set(), activeGroup: null, query: '' }).kind

  // Ungrouped: one list stays browsable to 24, and past it the page is
  // search-first (D4 — the gap the backlog table left undefined).
  for (const [count, layout] of [
    [24, 'flat'],
    [25, 'search'],
  ] as const) {
    const scan = scanOf(count, 0)
    assert.equal(sourceLayout(scan), layout, `${count} ungrouped skills is the ${layout} layout`)
    assert.equal(viewKind(scan), layout, `and the surface renders it as ${layout}`)
  }

  // Grouped: the groups do the narrowing, so a grouped source stays browsable
  // to 60 and turns search-first at 61.
  for (const [count, layout] of [
    [60, 'grouped'],
    [61, 'search'],
  ] as const) {
    const scan = scanOf(count, 4)
    assert.equal(sourceLayout(scan), layout, `${count} grouped skills is the ${layout} layout`)
    assert.equal(viewKind(scan), layout, `and the surface renders it as ${layout}`)
  }
}

// --- 1936: the retired skill-packs deep link still opens Skills --------------

async function testRetiredSkillPacksDeepLinkStillOpensSkills(): Promise<void> {
  const { createSettingsSlice, defaultAppSettings } = await import(
    '../renderer/src/store/slices/settingsSlice'
  )
  const { EXTENSIONS_BROWSE_DEEPLINK } = await import('../renderer/src/components/settings/extensionsRoute')
  const { consumePendingExtensionsSurfaceTarget } = await import(
    '../renderer/src/components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
  )

  const carrier = {
    workspaces: [],
    appSettings: defaultAppSettings(),
    settingsOverlay: { open: false, initialTab: null as string | null, checkForUpdatesRequestId: null },
    activeGlobalSurface: null as string | null,
    activeModalSurface: null as string | null,
    sidebarSection: 'home' as string,
  }
  const slice = createSettingsSlice(((mutator: (state: unknown) => void) => mutator(carrier)) as never)

  // Skill packs are gone (T7 swept them, and this suite's `window.api` carries
  // no `skillPack*` member at all), but the deep links that named them are on
  // disk in older installs. Each must still land somewhere real.
  // The target names one of the door's three VIEWS since the source-tabs
  // ruling (2026-09-05); `browse` named a half of a surface that no longer
  // exists, and the catalogue it meant is Plugins.
  for (const [tab, expected] of [
    ['skill-packs', 'skills'],
    [EXTENSIONS_BROWSE_DEEPLINK, 'plugins'],
  ] as const) {
    carrier.activeModalSurface = null
    carrier.activeGlobalSurface = null
    carrier.settingsOverlay = { open: false, initialTab: null, checkForUpdatesRequestId: null }
    consumePendingExtensionsSurfaceTarget()

    slice.openSettingsOverlay({ initialTab: tab })

    assert.equal(carrier.activeGlobalSurface, 'extensions', `${tab} opens the Plugins door`)
    assert.equal(carrier.settingsOverlay.open, false, `${tab} does not open a settings tab that no longer exists`)
    assert.deepEqual(
      consumePendingExtensionsSurfaceTarget(),
      { view: expected },
      `${tab} lands on the view it was asking for`,
    )
  }

  const api = domWindow.api as Record<string, unknown>
  assert.equal('skillPackList' in api, false, 'the retired skill-pack preload surface is gone')
}

main()
  .then(() => {
    for (const path of temporaryDirs) rmSync(path, { recursive: true, force: true })
    process.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    for (const path of temporaryDirs) rmSync(path, { recursive: true, force: true })
    process.exit(1)
  })
