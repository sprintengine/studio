import assert from 'node:assert/strict'
import {
  guidedBriefHandoffChecklist,
  guidedBriefPlanningDecisionNotes,
  guidedBriefPlanningValidationNotes,
  guidedBriefSprintEngineGoal,
} from './handoff'
import { joinWorkspacePath, basename } from './paths'
import { stripAnsiAndOverwrites } from './parseStream'
import {
  guidedBriefSkipToHandoffState,
  isMidStageGuidedRuntime,
  progressForStage,
  stepCounterLabel,
  type GuidedBriefRuntimeState,
} from './types'
import {
  applyDesignArtifactSelection,
  buildDesignArtifactIndex,
  classifyMockupFile,
  collectDesignArtifacts,
  findDesignArtifact,
  isHtmlDesignArtifact,
  previewKindForArtifact,
  type DesignArtifactEntry,
  type DesignArtifactFsPort,
  type DesignArtifactKind,
} from './designArtifacts'
import {
  browserOpenFailureMessage,
  htmlArtifactFrameSandbox,
} from './MockupPreviewPane'
import { nextDesignerStageForReadiness } from './useDesignerSession'

const guidedDefaults = {
  guidedRoleCliDefaults: {
    product: 'codex' as const,
    architect: 'codex' as const,
    frontend: 'codex' as const,
  },
  buildRoleCounts: {
    architect: 1,
    product: 1,
    frontend: 1,
    developer: 1,
    code_reviewer: 1,
    spec_reviewer: 1,
    performance: 0,
    cross_platform: 0,
    tester: 1,
    security: 0,
  },
  buildRoleCliDefaults: {
    architect: 'codex' as const,
    product: 'codex' as const,
    frontend: 'codex' as const,
    developer: 'codex' as const,
    code_reviewer: 'codex' as const,
    spec_reviewer: 'codex' as const,
    performance: 'codex' as const,
    cross_platform: 'codex' as const,
    tester: 'codex' as const,
    security: 'codex' as const,
  },
  buildCliPermissionPreset: 'default' as const,
  buildStartRunner: true,
  buildAutoApproveArtifacts: false,
}

assert.equal(joinWorkspacePath('/workspace', 'product', 'requirements.md'), '/workspace/product/requirements.md')
assert.equal(joinWorkspacePath('/workspace/', 'product'), '/workspace/product')
assert.equal(joinWorkspacePath('C:\\workspace', 'product', 'requirements.md'), 'C:\\workspace\\product\\requirements.md')
assert.equal(basename('/workspace/my-folder'), 'my-folder')
assert.equal(basename('C:\\workspace\\my-folder'), 'my-folder')

const strategistWorkingHasUi = progressForStage('strategist-working', 'yes')
assert.equal(strategistWorkingHasUi.total, 4)
assert.equal(strategistWorkingHasUi.active, 1)
assert.equal(strategistWorkingHasUi.done, 1)

const strategistReadyHasUi = progressForStage('strategist-ready', 'yes')
assert.equal(strategistReadyHasUi.active, 1, 'ready stays on the same active dash as working')

const designerWorkingHasUi = progressForStage('designer-working', 'yes')
assert.equal(designerWorkingHasUi.active, 2)

const handoffHasUi = progressForStage('handoff', 'yes')
assert.equal(handoffHasUi.active, 3)

const architectWorkingHasUi = progressForStage('architect-working', 'yes', {
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
})
assert.equal(architectWorkingHasUi.total, 5, 'architecture adds one progress dash')
assert.equal(architectWorkingHasUi.active, 2)
assert.match(
  stepCounterLabel('architect-ready', 'yes', {
    wantsProductDiscussion: true,
    wantsArchitectureDiscussion: true,
    wantsFrontendDiscussion: true,
  }),
  /Step 3 of 5 · plan ready/,
)

const strategistWorkingNoUi = progressForStage('strategist-working', 'no')
assert.equal(strategistWorkingNoUi.total, 3, 'no-UI flow has three progress dashes')
assert.equal(strategistWorkingNoUi.active, 1)

const handoffNoUi = progressForStage('handoff', 'no')
assert.equal(handoffNoUi.active, 2, 'handoff is the second active dash in the no-UI flow')

assert.match(stepCounterLabel('strategist-working', 'yes'), /Step 2 of 4 · strategist working/)
assert.match(stepCounterLabel('strategist-ready', 'yes'), /Step 2 of 4 · brief ready/)
assert.match(stepCounterLabel('handoff', 'no'), /Step 3 of 3 · handoff/)

// Designer stage transitions: working and ready share the third dash in the
// has-UI flow, handoff moves to the fourth. In the no-UI flow designer is
// entirely skipped, so handoff sits on dash 2 of 3.
const designerReady = progressForStage('designer-ready', 'yes')
assert.equal(designerReady.total, 4)
assert.equal(designerReady.active, 2, 'designer-ready stays on the designer dash')

const handoffYes = progressForStage('handoff', 'yes')
assert.equal(handoffYes.active, 3, 'handoff is the fourth dash when there is a UI')

const designerWorkingNoUi = progressForStage('designer-working', 'no')
assert.equal(designerWorkingNoUi.total, 3, 'no-UI never grows past three dashes')
assert.equal(designerWorkingNoUi.active, 2, 'designer stage in a no-UI run is treated as handoff territory')

assert.match(stepCounterLabel('designer-working', 'yes'), /Step 3 of 4 · designer working/)
assert.match(stepCounterLabel('designer-ready', 'yes'), /Step 3 of 4 · mockups ready/)

const hasUiChecklist = guidedBriefHandoffChecklist({
  ...guidedDefaults,
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build a dashboard.',
  hasUi: 'yes',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
  stage: 'handoff',
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
  acceptedArchitecturePlan: { kind: 'product', title: 'Architecture plan', path: 'product/.versions/plan.md', hash: 'planhash' },
  acceptedUiDirection: { kind: 'product', title: 'UI direction', path: 'product/.versions/ui.md', hash: 'uihash' },
  acceptedMockups: [{ kind: 'mockup', title: 'Dashboard', path: 'mockups/.versions/app.html', hash: 'mockhash' }],
  activeMockupPath: 'mockups/app.html',
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
})
assert.deepEqual(
  hasUiChecklist.map((item) => item.label),
  ['Accepted brief', 'Architecture plan', 'UI direction', 'Dashboard', 'Build handoff'],
  'has-UI handoff lists brief, architecture plan, UI direction, mockups, and build handoff',
)

const noUiChecklist = guidedBriefHandoffChecklist({
  ...guidedDefaults,
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build a service.',
  hasUi: 'no',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: false,
  stage: 'handoff',
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
  acceptedArchitecturePlan: null,
  acceptedUiDirection: null,
  acceptedMockups: [{ kind: 'mockup', title: 'Ignored', path: 'mockups/.versions/app.html', hash: 'mockhash' }],
  activeMockupPath: null,
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
})
assert.deepEqual(
  noUiChecklist.map((item) => item.label),
  ['Accepted brief', 'Build handoff'],
  'no-UI handoff only lists brief and build handoff',
)

assert.equal(
  guidedBriefSprintEngineGoal('## Suggested Sprint Engine Goal\n\nShip the accepted build.\n\n## Risks\n\n- None', 'yes'),
  'Ship the accepted build.',
)

// stripAnsiAndOverwrites is the only parseStream export kept after the
// composer/transcript was removed — sessionAdapter still uses it for marker
// detection on the raw terminal stream.
assert.equal(
  stripAnsiAndOverwrites('\x1b[31mhello\x1b[0m world'),
  'hello world',
  'ANSI colour codes are stripped',
)
assert.equal(
  stripAnsiAndOverwrites('progress 1/3\rprogress 3/3'),
  'progress 3/3',
  'carriage-return overwrites collapse to the last write',
)
assert.equal(
  stripAnsiAndOverwrites('first\nsecond\n'),
  'first\nsecond\n',
  'real line breaks are preserved',
)
assert.equal(
  stripAnsiAndOverwrites('\x1b]0;Title\x07hi'),
  'hi',
  'OSC sequences (window title etc.) are stripped',
)
assert.equal(
  stripAnsiAndOverwrites('plain text \x07with bell'),
  'plain text with bell',
  'control characters are removed',
)

// Mid-stage close gate: confirmation should fire only after the strategist
// session has been launched and before the build is handed off. Idle state
// and the no-runtime case keep the pre-runtime close behaviour intact.
const baseRuntime: GuidedBriefRuntimeState = {
  ...guidedDefaults,
  workspaceRoot: '/workspace',
  workspaceName: 'Workspace',
  idea: 'Build something.',
  hasUi: 'yes',
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: true,
  stage: 'strategist-working',
  acceptedProductBrief: null,
  acceptedArchitecturePlan: null,
  acceptedUiDirection: null,
  acceptedMockups: [],
  activeMockupPath: null,
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
}

assert.equal(isMidStageGuidedRuntime(null), false, 'no runtime → no confirmation')
assert.equal(isMidStageGuidedRuntime(baseRuntime), true, 'strategist-working triggers confirmation')
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'strategist-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'architect-working' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'architect-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'designer-working' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'designer-ready' }), true)
assert.equal(isMidStageGuidedRuntime({ ...baseRuntime, stage: 'handoff' }), true, 'handoff confirms until Start the build')

const skippedRuntime = guidedBriefSkipToHandoffState({
  ...baseRuntime,
  strategistSessionId: 'strategist-session',
  designerSessionId: 'designer-session',
})
assert.equal(skippedRuntime.stage, 'handoff', 'skip moves directly to handoff/roster')
assert.equal(skippedRuntime.wantsProductDiscussion, false, 'unaccepted product stage no longer blocks Start the build')
assert.equal(skippedRuntime.wantsArchitectureDiscussion, false, 'unaccepted architecture stage no longer blocks Start the build')
assert.equal(skippedRuntime.wantsFrontendDiscussion, false, 'unaccepted frontend stage no longer requires mockups')
assert.equal(skippedRuntime.strategistSessionId, null, 'skip detaches the strategist PTY')
assert.equal(skippedRuntime.designerSessionId, null, 'skip detaches the designer PTY')
assert.deepEqual(
  guidedBriefPlanningDecisionNotes(skippedRuntime),
  [
    'Application includes a visual UI.',
    'Product strategy discussion was not requested or was skipped before roster selection.',
    'Architecture discussion was not requested or was skipped before roster selection.',
    'Frontend design and mockup discussion was not requested or was skipped before roster selection.',
  ],
)
assert.deepEqual(
  guidedBriefPlanningValidationNotes(skippedRuntime),
  [
    'Validate implementation against any accepted Guided brief artifact snapshot hashes.',
    'Resolve missing product or architecture decisions before broad implementation work.',
    'Create or validate UI direction during Sprint Engine planning because the guided frontend stage was skipped.',
  ],
)

const skippedAfterBrief = guidedBriefSkipToHandoffState({
  ...baseRuntime,
  acceptedProductBrief: { kind: 'product', title: 'Product brief', path: 'product/.versions/brief.md', hash: 'briefhash' },
})
assert.equal(skippedAfterBrief.wantsProductDiscussion, true, 'accepted product brief remains required and available')
assert.equal(skippedAfterBrief.wantsFrontendDiscussion, false, 'missing frontend artifacts are still treated as skipped')

// --- Design artifact index (T2) -------------------------------------------

// Classification is by extension and case-insensitive; unsupported types are ignored.
assert.equal(classifyMockupFile('app.html'), 'page')
assert.equal(classifyMockupFile('INDEX.HTM'), 'page')
assert.equal(classifyMockupFile('styles.css'), 'stylesheet')
assert.equal(classifyMockupFile('panel.js'), 'script')
assert.equal(classifyMockupFile('data.json'), 'script')
assert.equal(classifyMockupFile('logo.svg'), 'image')
assert.equal(classifyMockupFile('photo.JPEG'), 'image')
assert.equal(classifyMockupFile('notes.txt'), null, 'unsupported extensions are ignored')
assert.equal(classifyMockupFile('Makefile'), null, 'extensionless files are ignored')

// buildDesignArtifactIndex groups by canonical order and sorts by relative path.
const sampleEntries: DesignArtifactEntry[] = [
  { name: 'b.html', relativePath: 'mockups/b.html', absolutePath: '/ws/mockups/b.html', kind: 'page', typeLabel: 'HTML' },
  { name: 'a.html', relativePath: 'mockups/a.html', absolutePath: '/ws/mockups/a.html', kind: 'page', typeLabel: 'HTML' },
  { name: 'styles.css', relativePath: 'mockups/styles.css', absolutePath: '/ws/mockups/styles.css', kind: 'stylesheet', typeLabel: 'CSS' },
]
const sampleIndex = buildDesignArtifactIndex(sampleEntries)
assert.deepEqual(sampleIndex.groups.map((group) => group.id), ['pages', 'stylesheets'], 'only non-empty groups appear, in canonical order')
assert.deepEqual(
  sampleIndex.groups[0].entries.map((entry) => entry.relativePath),
  ['mockups/a.html', 'mockups/b.html'],
  'entries within a group are sorted by relative path',
)
assert.equal(sampleIndex.count, 3)
assert.deepEqual(
  sampleIndex.entries.map((entry) => entry.relativePath),
  ['mockups/a.html', 'mockups/b.html', 'mockups/styles.css'],
  'flat entries follow group order then path order',
)

assert.equal(buildDesignArtifactIndex([]).count, 0, 'an empty input yields an empty index')
assert.deepEqual(buildDesignArtifactIndex([]).groups, [], 'an empty index exposes no groups')

assert.equal(isHtmlDesignArtifact(sampleEntries[0]), true)
assert.equal(isHtmlDesignArtifact(sampleEntries[2]), false)
assert.equal(findDesignArtifact(sampleIndex, 'mockups/a.html')?.name, 'a.html')
assert.equal(findDesignArtifact(sampleIndex, 'mockups/missing.html'), null)
assert.equal(findDesignArtifact(sampleIndex, null), null)

// Selection persistence (the product integration path in GuidedBriefFlow uses
// this exact helper via onChange/setGuidedBriefState). Selecting an HTML page
// writes activeDesignArtifactPath and mirrors activeMockupPath; selecting a
// non-page writes only activeDesignArtifactPath and leaves activeMockupPath.
const baseSelectionState = { activeDesignArtifactPath: null as string | null, activeMockupPath: 'mockups/old.html' as string | null }
const htmlSelection = applyDesignArtifactSelection(baseSelectionState, sampleEntries[0])
assert.equal(htmlSelection.activeDesignArtifactPath, 'mockups/b.html', 'html selection writes activeDesignArtifactPath')
assert.equal(htmlSelection.activeMockupPath, 'mockups/b.html', 'html selection mirrors activeMockupPath')
const cssSelection = applyDesignArtifactSelection(baseSelectionState, sampleEntries[2])
assert.equal(cssSelection.activeDesignArtifactPath, 'mockups/styles.css', 'non-page selection writes activeDesignArtifactPath')
assert.equal(cssSelection.activeMockupPath, 'mockups/old.html', 'non-page selection leaves activeMockupPath untouched')
assert.equal(baseSelectionState.activeDesignArtifactPath, null, 'selection does not mutate the input state')

// Preview kind dispatch (T3) — drives DesignArtifactPreviewPane.
function previewEntry(relativePath: string, kind: DesignArtifactKind): DesignArtifactEntry {
  const name = relativePath.split('/').at(-1) ?? relativePath
  return { name, relativePath, absolutePath: `/ws/${relativePath}`, kind, typeLabel: 'X' }
}
assert.equal(previewKindForArtifact(previewEntry('mockups/app.html', 'page')), 'html')
assert.equal(previewKindForArtifact(previewEntry('mockups/app.htm', 'page')), 'html')
assert.equal(previewKindForArtifact(previewEntry('product/ui-direction.md', 'notes')), 'markdown', 'notes always render as markdown')
assert.equal(previewKindForArtifact(previewEntry('.guided-brief/inspiration/spec.md', 'inspiration')), 'markdown', 'markdown inspiration renders as markdown')
assert.equal(previewKindForArtifact(previewEntry('mockups/logo.svg', 'image')), 'image')
assert.equal(previewKindForArtifact(previewEntry('.guided-brief/inspiration/ref.png', 'inspiration')), 'image', 'image inspiration renders as image')
assert.equal(previewKindForArtifact(previewEntry('mockups/styles.css', 'stylesheet')), 'source')
assert.equal(previewKindForArtifact(previewEntry('mockups/data.json', 'script')), 'source')
assert.equal(previewKindForArtifact(previewEntry('mockups/panel.js', 'script')), 'source')
assert.equal(previewKindForArtifact(previewEntry('.guided-brief/inspiration/notes.txt', 'inspiration')), 'source', 'text inspiration renders as source')
assert.equal(previewKindForArtifact(previewEntry('.guided-brief/inspiration/clip.mp4', 'inspiration')), 'unsupported', 'unknown types are unsupported')

// Designer readiness transition (T11 race fix). nextDesignerStageForReadiness is
// the functional patch the GuidedBriefFlow effect passes to onChange. It must
// advance only the stage and preserve fields set by concurrent effects, which is
// exactly what the old stale whole-runtime spread clobbered (stranding the
// workspace in designer-working).
const designerWorkingState: GuidedBriefRuntimeState = {
  ...guidedDefaults,
  workspaceRoot: '/design',
  workspaceName: 'Studio',
  idea: 'Onboarding flow',
  hasUi: 'yes',
  preset: 'frontend-design',
  wantsProductDiscussion: false,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: true,
  stage: 'designer-working',
  acceptedProductBrief: null,
  acceptedArchitecturePlan: null,
  acceptedUiDirection: null,
  acceptedMockups: [],
  activeMockupPath: null,
  activeDesignArtifactPath: null,
  strategistSessionId: null,
  architectSessionId: null,
  designerSessionId: null,
}

assert.equal(
  nextDesignerStageForReadiness(designerWorkingState, false).stage,
  'designer-working',
  'no readiness signal leaves the stage unchanged',
)

// Simulate the batched commit as sequential functional updaters merging onto the
// latest committed state: session id assigned, active mockup selected, then
// readiness flips. All three concurrent changes must survive.
let mergedDesignerState = designerWorkingState
mergedDesignerState = { ...mergedDesignerState, designerSessionId: 'designer-1' }
mergedDesignerState = { ...mergedDesignerState, activeMockupPath: 'mockups/app.html' }
mergedDesignerState = nextDesignerStageForReadiness(mergedDesignerState, true)
assert.equal(mergedDesignerState.stage, 'designer-ready', 'readiness advances the designer stage')
assert.equal(
  mergedDesignerState.designerSessionId,
  'designer-1',
  'readiness patch preserves the concurrently-assigned designer session id',
)
assert.equal(
  mergedDesignerState.activeMockupPath,
  'mockups/app.html',
  'readiness patch preserves the concurrently-selected active mockup',
)
assert.equal(
  nextDesignerStageForReadiness({ ...mergedDesignerState, stage: 'handoff' }, true).stage,
  'handoff',
  'readiness only advances from designer-working, never regresses a later stage',
)

// HTML preview sandboxing (T12): scripts are off by default and the interactive
// toggle must not combine allow-scripts with same-origin privileges.
assert.equal(htmlArtifactFrameSandbox(false), '', 'scripts-off preview keeps every sandbox restriction enabled')
assert.equal(htmlArtifactFrameSandbox(true), 'allow-scripts', 'interactive preview grants scripts only')
assert.equal(
  htmlArtifactFrameSandbox(true).includes('allow-same-origin'),
  false,
  'interactive preview never grants same-origin privileges to generated HTML',
)

assert.match(
  browserOpenFailureMessage('mockups/app.html', 'missing'),
  /missing on disk/,
  'browser-open missing-file errors are distinguishable',
)
assert.match(
  browserOpenFailureMessage('mockups/app.html', 'handler', new Error('No handler for file URL')),
  /No handler for file URL/,
  'browser-open platform handler failures include the thrown detail',
)

async function testCollectDesignArtifacts(): Promise<void> {
  // In-memory filesystem mirroring how collectDesignArtifacts walks the tree:
  // readdir(dir) returns its entries (missing dirs → []), and pathExists is
  // only queried for product/ui-direction.md.
  const dirs: Record<string, { name: string; isDir: boolean }[]> = {
    '/ws/mockups': [
      { name: 'app.html', isDir: false },
      { name: 'styles.css', isDir: false },
      { name: 'data.json', isDir: false },
      { name: 'logo.svg', isDir: false },
      { name: 'notes.txt', isDir: false }, // unsupported → ignored
      { name: '.hidden.html', isDir: false }, // dotfile → skipped
      { name: 'dashboard', isDir: true },
    ],
    '/ws/mockups/dashboard': [
      { name: 'index.html', isDir: false },
      { name: 'panel.js', isDir: false },
    ],
    '/ws/.guided-brief/inspiration': [
      { name: 'ref.png', isDir: false },
      { name: 'moodboard', isDir: true },
    ],
    '/ws/.guided-brief/inspiration/moodboard': [{ name: 'shot.jpg', isDir: false }],
  }
  const existingFiles = new Set(['/ws/product/ui-direction.md'])
  const ports: DesignArtifactFsPort = {
    readdir: async (path) => dirs[path] ?? [],
    pathExists: async (path) => existingFiles.has(path),
  }

  const index = await collectDesignArtifacts('/ws', ports)

  assert.deepEqual(
    index.groups.map((group) => group.id),
    ['pages', 'stylesheets', 'scripts', 'assets', 'notes', 'inspiration'],
    'all populated groups appear in canonical order',
  )
  assert.equal(index.count, 9, 'unsupported and dotfiles are excluded from the count')
  assert.deepEqual(
    index.groups.find((group) => group.id === 'pages')?.entries.map((entry) => entry.relativePath),
    ['mockups/app.html', 'mockups/dashboard/index.html'],
    'pages include nested html via recursion, sorted by path',
  )
  assert.deepEqual(
    index.groups.find((group) => group.id === 'scripts')?.entries.map((entry) => entry.relativePath),
    ['mockups/dashboard/panel.js', 'mockups/data.json'],
    'js and json land in scripts, sorted by path',
  )
  assert.deepEqual(
    index.groups.find((group) => group.id === 'notes')?.entries.map((entry) => entry.relativePath),
    ['product/ui-direction.md'],
    'ui-direction.md appears as a note when present',
  )
  assert.deepEqual(
    index.groups.find((group) => group.id === 'inspiration')?.entries.map((entry) => entry.relativePath),
    ['.guided-brief/inspiration/moodboard/shot.jpg', '.guided-brief/inspiration/ref.png'],
    'inspiration includes any file type, recursively, sorted by path',
  )
  assert.equal(
    findDesignArtifact(index, 'product/ui-direction.md')?.typeLabel,
    'Markdown',
    'notes carry a Markdown type label',
  )

  // Empty workspace → empty, not a fabricated success.
  const emptyIndex = await collectDesignArtifacts('/empty', {
    readdir: async () => [],
    pathExists: async () => false,
  })
  assert.equal(emptyIndex.count, 0, 'no files on disk yields an empty index')

  console.log('designArtifacts: ok')
}

void testCollectDesignArtifacts().catch((error) => {
  console.error(error)
  process.exit(1)
})
