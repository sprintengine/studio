import type {
  DesignSystemSeedSource,
  GuidedBriefRecordedDecision,
  SprintEngineSourceBundleItem,
} from '../types/workspace'

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

// `product` → product/.versions/{hash}.md, `mockup` → mockups/.versions/{hash}.html,
// `overview` → product/.versions/{hash}.html (agent-produced HTML plan overview).
export type GuidedBriefSnapshotKind = 'product' | 'mockup' | 'overview'

export type GuidedBriefSnapshotInput = {
  workspaceRoot: string
  sourcePath: string
  kind: GuidedBriefSnapshotKind
  /** Human-readable filename prefix, e.g. `product-brief`. Bare hash when omitted. */
  slug?: string
  /** Override the `.versions` parent (e.g. `architecture` for the plan). */
  directory?: 'product' | 'mockups' | 'architecture'
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
  productBrief?: GuidedBriefAcceptedArtifact | null
  architecturePlan?: GuidedBriefAcceptedArtifact | null
  uiDirection?: GuidedBriefAcceptedArtifact | null
  mockups?: GuidedBriefAcceptedArtifact[]
  productOverview?: GuidedBriefAcceptedArtifact | null
  architectureOverview?: GuidedBriefAcceptedArtifact | null
  requireMockups?: boolean
  confirmedDecisions?: string[]
  // Real interview record from the specialist sessions. When present it is
  // the primary content of Confirmed Decisions; `confirmedDecisions` notes
  // remain as supplementary stage facts.
  recordedDecisions?: GuidedBriefRecordedDecision[]
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

export type GuidedBriefSprintEngineSourceBundleInput = {
  workspaceRoot: string
  handoffPath: string
  handoffContent: string
  productBrief?: GuidedBriefAcceptedArtifact | null
  architecturePlan?: GuidedBriefAcceptedArtifact | null
  uiDirection?: GuidedBriefAcceptedArtifact | null
  mockups?: GuidedBriefAcceptedArtifact[]
  productOverview?: GuidedBriefAcceptedArtifact | null
  architectureOverview?: GuidedBriefAcceptedArtifact | null
  readArtifact: (workspaceRoot: string, path: string) => Promise<string>
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

// Slug-prefixed names keep snapshots human-readable on disk
// (`product-brief-3fc8a1b2c4d5.md` instead of a bare 64-char hash). Legacy
// bare-hash snapshots from existing workspaces stay valid: consumers treat
// the stored path + hash as an opaque pair.
export function guidedBriefSnapshotSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function snapshotFileName(kind: GuidedBriefSnapshotKind, hash: string, slug?: string): string {
  const extension = kind === 'product' ? 'md' : 'html'
  return slug ? `${slug}-${hash.slice(0, 12)}.${extension}` : `${hash}.${extension}`
}

type GuidedBriefSnapshotDirectory = 'product' | 'mockups' | 'architecture'

function snapshotDirectory(
  kind: GuidedBriefSnapshotKind,
  directory?: GuidedBriefSnapshotDirectory,
): GuidedBriefSnapshotDirectory {
  return directory ?? (kind === 'mockup' ? 'mockups' : 'product')
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

// Design-system preset seed. Lives under `.guided-brief/` (app metadata,
// like the inspiration drop dir) so the design goal never ships inside the
// portable bundle at `design-system/`.
export const DESIGN_SYSTEM_IDEA_SEED_RELATIVE_PATH = '.guided-brief/idea-seed.md'

export function buildDesignSystemIdeaSeedMarkdown(
  idea: string,
  seedSource?: DesignSystemSeedSource | null,
): string {
  const trimmedIdea = trimRequired(idea, 'missing-idea')
  return [
    '# Design System Goal',
    '',
    '## User Goal',
    '',
    trimmedIdea,
    '',
    // The seed source is recorded here (app metadata, outside the portable
    // bundle) so the choice survives on disk and stays visible to the user;
    // the designer session's prompt carries the extraction instructions.
    ...(seedSource
      ? [
          '## Seed Source',
          '',
          seedSource.kind === 'brand-demo'
            ? '- Kind: built-in Multicode brand reference (demo)'
            : '- Kind: existing product folder',
          `- Path: \`${seedSource.path}\``,
          '',
        ]
      : []),
  ].join('\n')
}

export async function scaffoldDesignSystemWorkspaceSeed({
  workspaceRoot,
  idea,
  seedSource,
  filesystem,
}: {
  workspaceRoot: string
  idea: string
  seedSource?: DesignSystemSeedSource | null
  filesystem: GuidedBriefFilesystem
}): Promise<{ ideaSeedPath: string }> {
  const root = trimRequired(workspaceRoot, 'missing-root')
  await filesystem.ensureDir(root, '.guided-brief')
  const ideaSeedPath = joinWorkspacePath(root, '.guided-brief', 'idea-seed.md')
  await filesystem.writeFile(ideaSeedPath, buildDesignSystemIdeaSeedMarkdown(idea, seedSource))
  return { ideaSeedPath }
}

export async function scaffoldGuidedBriefWorkspace({
  workspaceRoot,
  idea,
  hasUi,
  filesystem,
}: GuidedBriefScaffoldInput): Promise<GuidedBriefScaffoldResult> {
  const root = trimRequired(workspaceRoot, 'missing-root')
  const productDirectoryPath = await filesystem.ensureDir(root, 'product')
  await filesystem.ensureDir(root, 'architecture')
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
  slug,
  directory,
  filesystem,
}: GuidedBriefSnapshotInput): Promise<GuidedBriefSnapshot> {
  const root = trimRequired(workspaceRoot, 'missing-root')
  const trimmedSource = trimRequired(sourcePath, 'missing-source')
  const content = await filesystem.readFile(trimmedSource)
  const hash = await sha256Hex(content)
  const resolvedDirectory = snapshotDirectory(kind, directory)
  const fileName = snapshotFileName(kind, hash, slug)
  const versionsDirectoryPath = await filesystem.ensureDir(
    await filesystem.ensureDir(root, resolvedDirectory),
    '.versions',
  )
  const relativePath = projectPath(resolvedDirectory, '.versions', fileName)
  const snapshotPath = joinWorkspacePath(root, relativePath)

  await filesystem.writeFile(joinWorkspacePath(versionsDirectoryPath, fileName), content)

  return {
    hash,
    path: relativeWorkspacePath(root, snapshotPath),
  }
}

function recordedDecisionLines(decisions: GuidedBriefRecordedDecision[] | undefined): string[] {
  if (!decisions?.length) return []
  const roleLabel: Record<GuidedBriefRecordedDecision['role'], string> = {
    product: 'product',
    architect: 'architecture',
    frontend: 'design',
  }
  return decisions.map((decision) => {
    const prefix = decision.question ? `${decision.question} — ` : ''
    return `- ${prefix}${decision.label} (${roleLabel[decision.role]})`
  })
}

export function buildGuidedBriefBuildHandoffMarkdown({
  idea,
  hasUi,
  productBrief,
  architecturePlan,
  uiDirection,
  mockups,
  productOverview,
  architectureOverview,
  requireMockups,
  confirmedDecisions,
  recordedDecisions,
  openQuestions,
  mvpScope,
  suggestedSprintEngineGoal,
  roster,
  risks,
  validationNotes,
}: Omit<GuidedBriefBuildHandoffInput, 'workspaceRoot' | 'filesystem'>): string {
  if (requireMockups && (!mockups || mockups.length === 0)) {
    throw new GuidedBriefWorkspaceError('mockups-required')
  }

  const trimmedIdea = trimRequired(idea, 'missing-idea')
  const goal = suggestedSprintEngineGoal?.trim()
    || (mockups?.length
      ? 'Build the accepted product brief and UI mockup into a production-ready application.'
      : hasUi === 'yes'
        ? 'Build the accepted Guided brief artifacts into a production-ready visual application.'
        : 'Build the accepted Guided brief artifacts into a production-ready script or service.')

  return [
    '# Guided App Brief Build Handoff',
    '',
    '## Idea',
    '',
    trimmedIdea,
    '',
    '## Accepted Artifacts',
    '',
    ...(productBrief ? [`- Product brief: \`${productBrief.path}\` (${productBrief.hash})`] : ['- Product brief: not requested.']),
    ...(productOverview ? [`- Product overview (HTML view of the brief, not a source of truth): \`${productOverview.path}\` (${productOverview.hash})`] : []),
    ...(architecturePlan ? [`- Architecture plan: \`${architecturePlan.path}\` (${architecturePlan.hash})`] : []),
    ...(architectureOverview ? [`- Architecture overview (HTML view of the plan, not a source of truth): \`${architectureOverview.path}\` (${architectureOverview.hash})`] : []),
    ...(uiDirection ? [`- UI direction: \`${uiDirection.path}\` (${uiDirection.hash})`] : []),
    ...artifactList(mockups, hasUi === 'yes' ? 'No accepted mockups recorded.' : 'No UI mockups required for this script or service.'),
    '',
    '## Confirmed Decisions',
    '',
    ...recordedDecisionLines(recordedDecisions),
    ...markdownList(confirmedDecisions, hasUi === 'yes' ? 'Application includes a visual UI.' : 'No visual UI is required.'),
    '',
    '## Open Questions',
    '',
    ...markdownList(openQuestions, 'None recorded.'),
    '',
    '## MVP Scope',
    '',
    ...markdownList(mvpScope, 'Implement only the accepted Guided brief artifacts without adding unapproved scope.'),
    '',
    '## Suggested Sprint Goal',
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
    productBrief: input.productBrief ? normalizeAcceptedArtifact(root, input.productBrief) : input.productBrief,
    architecturePlan: input.architecturePlan ? normalizeAcceptedArtifact(root, input.architecturePlan) : input.architecturePlan,
    uiDirection: input.uiDirection ? normalizeAcceptedArtifact(root, input.uiDirection) : input.uiDirection,
    mockups: input.mockups?.map((artifact) => normalizeAcceptedArtifact(root, artifact)),
    productOverview: input.productOverview ? normalizeAcceptedArtifact(root, input.productOverview) : input.productOverview,
    architectureOverview: input.architectureOverview
      ? normalizeAcceptedArtifact(root, input.architectureOverview)
      : input.architectureOverview,
  })

  await input.filesystem.writeFile(joinWorkspacePath(productDirectoryPath, 'build-handoff.md'), content)

  return {
    path: relativeWorkspacePath(root, handoffPath),
    content,
  }
}

export async function buildGuidedBriefSprintEngineSourceBundle({
  workspaceRoot,
  handoffPath,
  handoffContent,
  productBrief,
  architecturePlan,
  uiDirection,
  mockups = [],
  productOverview,
  architectureOverview,
  readArtifact,
}: GuidedBriefSprintEngineSourceBundleInput): Promise<SprintEngineSourceBundleItem[]> {
  const sourceBundle: SprintEngineSourceBundleItem[] = [
    {
      kind: productBrief ? 'generic_context' : 'product_plan',
      sourcePath: handoffPath,
      sourceRelativePath: handoffPath,
      sourceContent: handoffContent,
    },
  ]
  if (productBrief) {
    sourceBundle.push({
      kind: 'product_plan',
      sourcePath: productBrief.path,
      sourceRelativePath: productBrief.path,
      sourceContent: await readArtifact(workspaceRoot, productBrief.path),
    })
  }
  if (architecturePlan) {
    sourceBundle.push({
      kind: 'architect_plan',
      sourcePath: architecturePlan.path,
      sourceRelativePath: architecturePlan.path,
      sourceContent: await readArtifact(workspaceRoot, architecturePlan.path),
    })
  }
  if (uiDirection) {
    sourceBundle.push({
      kind: 'design_notes',
      sourcePath: uiDirection.path,
      sourceRelativePath: uiDirection.path,
      sourceContent: await readArtifact(workspaceRoot, uiDirection.path),
    })
  }
  for (const overview of [productOverview, architectureOverview]) {
    if (!overview) continue
    sourceBundle.push({
      kind: 'plan_overview',
      sourcePath: overview.path,
      sourceRelativePath: overview.path,
      sourceContent: await readArtifact(workspaceRoot, overview.path),
    })
  }
  for (const mockup of mockups) {
    sourceBundle.push({
      kind: 'html_mockup',
      sourcePath: mockup.path,
      sourceRelativePath: mockup.path,
      sourceContent: await readArtifact(workspaceRoot, mockup.path),
    })
  }
  return sourceBundle
}
