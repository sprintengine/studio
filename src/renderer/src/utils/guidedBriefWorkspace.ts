export type GuidedBriefHasUi = 'yes' | 'no'

export type GuidedBriefFilesystem = {
  ensureDir: (parentDir: string, name: string) => Promise<string>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
}

export type GuidedBriefScaffoldInput = {
  workspaceRoot: string
  idea: string
  hasUi: GuidedBriefHasUi
  filesystem: GuidedBriefFilesystem
}

export type GuidedBriefScaffoldResult = {
  productDirectoryPath: string
  mockupsDirectoryPath: string
  productVersionsDirectoryPath: string
  mockupsVersionsDirectoryPath: string
  ideaSeedPath: string
}

export type GuidedBriefSnapshotKind = 'product' | 'mockup'

export type GuidedBriefSnapshotInput = {
  workspaceRoot: string
  sourcePath: string
  kind: GuidedBriefSnapshotKind
  filesystem: GuidedBriefFilesystem
}

export type GuidedBriefSnapshot = {
  hash: string
  path: string
}

export type GuidedBriefAcceptedArtifact = GuidedBriefSnapshot & {
  title: string
}

export type GuidedBriefBuildHandoffInput = {
  workspaceRoot: string
  idea: string
  hasUi: GuidedBriefHasUi
  productBrief: GuidedBriefAcceptedArtifact
  uiDirection?: GuidedBriefAcceptedArtifact | null
  mockups?: GuidedBriefAcceptedArtifact[]
  confirmedDecisions?: string[]
  openQuestions?: string[]
  mvpScope?: string[]
  suggestedSprintEngineGoal?: string
  roster?: string[]
  risks?: string[]
  validationNotes?: string[]
  filesystem: GuidedBriefFilesystem
}

export type GuidedBriefBuildHandoffResult = {
  path: string
  content: string
}

export class GuidedBriefWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'missing-root'
      | 'missing-idea'
      | 'missing-source'
      | 'missing-crypto'
      | 'mockups-required'
  ) {
    super(code)
    this.name = 'GuidedBriefWorkspaceError'
  }
}

function trimRequired(value: string, code: GuidedBriefWorkspaceError['code']): string {
  const trimmed = value.trim()
  if (!trimmed) throw new GuidedBriefWorkspaceError(code)
  return trimmed
}

function pathSeparator(rootPath: string): '/' | '\\' {
  return rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/'
}

function joinWorkspacePath(rootPath: string, ...parts: string[]): string {
  const sep = pathSeparator(rootPath)
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
  const normalizedParts = parts
    .map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)
  return [normalizedRoot, ...normalizedParts].join(sep)
}

function projectPath(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function relativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, '')
  if (absolutePath === root) return ''
  const prefix = `${root}${pathSeparator(root)}`
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length).replace(/\\/g, '/')
  }
  return absolutePath.replace(/\\/g, '/')
}

function markdownList(values: string[] | undefined, fallback: string): string[] {
  const items = (values ?? []).map((value) => value.trim()).filter(Boolean)
  return items.length > 0 ? items.map((value) => `- ${value}`) : [`- ${fallback}`]
}

function artifactList(artifacts: GuidedBriefAcceptedArtifact[] | undefined, fallback: string): string[] {
  if (!artifacts?.length) return [`- ${fallback}`]
  return artifacts.map((artifact) => `- ${artifact.title}: \`${artifact.path}\` (${artifact.hash})`)
}

function normalizeAcceptedArtifact(workspaceRoot: string, artifact: GuidedBriefAcceptedArtifact): GuidedBriefAcceptedArtifact {
  return {
    ...artifact,
    path: relativeWorkspacePath(workspaceRoot, artifact.path),
  }
}

async function sha256Hex(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new GuidedBriefWorkspaceError('missing-crypto')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function snapshotFileName(kind: GuidedBriefSnapshotKind, hash: string): string {
  return `${hash}.${kind === 'product' ? 'md' : 'html'}`
}

export function buildGuidedBriefIdeaSeedMarkdown(idea: string, hasUi: GuidedBriefHasUi): string {
  const trimmedIdea = trimRequired(idea, 'missing-idea')
  return [
    '# Idea Seed',
    '',
    '## User Idea',
    '',
    trimmedIdea,
    '',
    '## App Surface',
    '',
    hasUi === 'yes' ? '- User confirmed this app needs a visual UI.' : '- User confirmed this is a script or service with no visual UI.',
    '',
  ].join('\n')
}

export async function scaffoldGuidedBriefWorkspace({
  workspaceRoot,
  idea,
  hasUi,
  filesystem,
}: GuidedBriefScaffoldInput): Promise<GuidedBriefScaffoldResult> {
  const root = trimRequired(workspaceRoot, 'missing-root')
  const productDirectoryPath = await filesystem.ensureDir(root, 'product')
  const mockupsDirectoryPath = await filesystem.ensureDir(root, 'mockups')
  const productVersionsDirectoryPath = await filesystem.ensureDir(productDirectoryPath, '.versions')
  const mockupsVersionsDirectoryPath = await filesystem.ensureDir(mockupsDirectoryPath, '.versions')
  const ideaSeedPath = joinWorkspacePath(root, 'product', 'idea-seed.md')

  await filesystem.writeFile(ideaSeedPath, buildGuidedBriefIdeaSeedMarkdown(idea, hasUi))

  return {
    productDirectoryPath,
    mockupsDirectoryPath,
    productVersionsDirectoryPath,
    mockupsVersionsDirectoryPath,
    ideaSeedPath,
  }
}

export async function snapshotGuidedBriefArtifact({
  workspaceRoot,
  sourcePath,
  kind,
  filesystem,
}: GuidedBriefSnapshotInput): Promise<GuidedBriefSnapshot> {
  const root = trimRequired(workspaceRoot, 'missing-root')
  const trimmedSource = trimRequired(sourcePath, 'missing-source')
  const content = await filesystem.readFile(trimmedSource)
  const hash = await sha256Hex(content)
  const versionsDirectoryPath = await filesystem.ensureDir(
    await filesystem.ensureDir(root, kind === 'product' ? 'product' : 'mockups'),
    '.versions',
  )
  const relativePath = projectPath(kind === 'product' ? 'product' : 'mockups', '.versions', snapshotFileName(kind, hash))
  const snapshotPath = joinWorkspacePath(root, relativePath)

  await filesystem.writeFile(joinWorkspacePath(versionsDirectoryPath, snapshotFileName(kind, hash)), content)

  return {
    hash,
    path: relativeWorkspacePath(root, snapshotPath),
  }
}

export function buildGuidedBriefBuildHandoffMarkdown({
  idea,
  hasUi,
  productBrief,
  uiDirection,
  mockups,
  confirmedDecisions,
  openQuestions,
  mvpScope,
  suggestedSprintEngineGoal,
  roster,
  risks,
  validationNotes,
}: Omit<GuidedBriefBuildHandoffInput, 'workspaceRoot' | 'filesystem'>): string {
  if (hasUi === 'yes' && (!mockups || mockups.length === 0)) {
    throw new GuidedBriefWorkspaceError('mockups-required')
  }

  const trimmedIdea = trimRequired(idea, 'missing-idea')
  const goal = suggestedSprintEngineGoal?.trim()
    || (hasUi === 'yes'
      ? 'Build the accepted product brief and UI mockup into a production-ready application.'
      : 'Build the accepted product brief into a production-ready script or service.')

  return [
    '# Guided App Brief Build Handoff',
    '',
    '## Idea',
    '',
    trimmedIdea,
    '',
    '## Accepted Artifacts',
    '',
    `- Product brief: \`${productBrief.path}\` (${productBrief.hash})`,
    ...(uiDirection ? [`- UI direction: \`${uiDirection.path}\` (${uiDirection.hash})`] : []),
    ...artifactList(mockups, hasUi === 'yes' ? 'No accepted mockups recorded.' : 'No UI mockups required for this script or service.'),
    '',
    '## Confirmed Decisions',
    '',
    ...markdownList(confirmedDecisions, hasUi === 'yes' ? 'Application includes a visual UI.' : 'No visual UI is required.'),
    '',
    '## Open Questions',
    '',
    ...markdownList(openQuestions, 'None recorded.'),
    '',
    '## MVP Scope',
    '',
    ...markdownList(mvpScope, 'Implement the accepted product brief without adding unapproved scope.'),
    '',
    '## Suggested Sprint Engine Goal',
    '',
    goal,
    '',
    '## Roster',
    '',
    ...markdownList(roster, hasUi === 'yes' ? 'product, architect, frontend, developer, tester, code_reviewer, spec_reviewer' : 'product, architect, developer, tester, code_reviewer, spec_reviewer'),
    '',
    '## Risks',
    '',
    ...markdownList(risks, 'No additional risks recorded during guided brief acceptance.'),
    '',
    '## Validation Notes',
    '',
    ...markdownList(validationNotes, 'Validate against the accepted artifact hashes before implementation starts.'),
    '',
  ].join('\n')
}

export async function writeGuidedBriefBuildHandoff(input: GuidedBriefBuildHandoffInput): Promise<GuidedBriefBuildHandoffResult> {
  const root = trimRequired(input.workspaceRoot, 'missing-root')
  const productDirectoryPath = await input.filesystem.ensureDir(root, 'product')
  const handoffPath = joinWorkspacePath(root, 'product', 'build-handoff.md')
  const content = buildGuidedBriefBuildHandoffMarkdown({
    ...input,
    productBrief: normalizeAcceptedArtifact(root, input.productBrief),
    uiDirection: input.uiDirection ? normalizeAcceptedArtifact(root, input.uiDirection) : input.uiDirection,
    mockups: input.mockups?.map((artifact) => normalizeAcceptedArtifact(root, artifact)),
  })

  await input.filesystem.writeFile(joinWorkspacePath(productDirectoryPath, 'build-handoff.md'), content)

  return {
    path: relativeWorkspacePath(root, handoffPath),
    content,
  }
}
