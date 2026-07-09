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
  guidedBriefSteps,
  isMidStageGuidedRuntime,
  progressForStage,
  stepCounterLabel,
  type GuidedBriefRuntimeState,
} from './types'
import {
  applyDesignArtifactSelection,
  buildDesignArtifactIndex,
  buildScaffoldBaseline,
  classifyMockupFile,
  collectDesignArtifacts,
  designArtifactRootsForPreset,
  designSystemBundleFileCount,
  EMPTY_DESIGN_ARTIFACT_INDEX,
  findDesignArtifact,
  isHtmlDesignArtifact,
  isNewOrModifiedSinceBaseline,
  parseScaffoldBaseline,
  previewKindForArtifact,
  serializeScaffoldBaseline,
  type DesignArtifactEntry,
  type DesignArtifactFsPort,
  type DesignArtifactKind,
  type ScaffoldBaseline,
} from './designArtifacts'
import {
  buildComponentGalleryModel,
  componentSectionCountLabel,
  componentTitleFromMarkdown,
  galleryComponentTitle,
  humanizeComponentName,
} from './componentGallery'
import {
  browserOpenFailureMessage,
  htmlArtifactFrameSandbox,
  humanizeFileTitle,
  htmlPreviewTitle,
  pageTitleFromHtml,
  resolveHtmlArtifactView,
} from './MockupPreviewPane'
import { nextDesignerStageForReadiness } from './useDesignerSession'
import {
  agentInitials,
  bubbleDotTone,
  bubbleNeedsAttention,
  bubbleStatusLine,
  canvasScreensFromIndex,
  INLINE_SCREEN_SWITCHER_MAX,
  screenSwitcherMode,
} from './CanvasStudio/canvasStudioModel'

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

// Labeled step rail: same stage order as the progress helpers, with labels
// and done/active/upcoming states. Both stages of a family map to one step.
const fullBriefSteps = guidedBriefSteps('architect-working', 'yes', {
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
})
assert.deepEqual(
  fullBriefSteps.map((step) => step.label),
  ['Strategy', 'Architecture', 'Design', 'Build'],
  'full brief rail labels all four stations',
)
assert.deepEqual(
  fullBriefSteps.map((step) => step.state),
  ['done', 'active', 'upcoming', 'upcoming'],
  'steps before the active family are done, after it upcoming',
)
const readySteps = guidedBriefSteps('architect-ready', 'yes', {
  wantsProductDiscussion: true,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
})
assert.deepEqual(
  readySteps.map((step) => step.state),
  fullBriefSteps.map((step) => step.state),
  'working and ready stages of one family share a rail state',
)
const designPresetSteps = guidedBriefSteps('designer-working', 'yes', {
  wantsProductDiscussion: false,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: true,
})
assert.deepEqual(
  designPresetSteps.map((step) => step.label),
  ['Design', 'Build'],
  'the frontend-design preset rail shows only its own stations',
)
assert.deepEqual(designPresetSteps.map((step) => step.state), ['active', 'upcoming'])
// The design-system preset is a studio, not a pipeline: one station, no
// Sprint Engine build tail (its release action is a separate epic task).
const designSystemSteps = guidedBriefSteps('designer-working', 'yes', {
  wantsProductDiscussion: false,
  wantsArchitectureDiscussion: false,
  wantsFrontendDiscussion: true,
  preset: 'design-system',
})
assert.deepEqual(
  designSystemSteps.map((step) => step.label),
  ['Design system'],
  'the design-system preset rail is the single authoring station',
)
assert.deepEqual(designSystemSteps.map((step) => step.state), ['active'])
const designSystemReadySteps = guidedBriefSteps('designer-ready', 'yes', { preset: 'design-system' })
assert.deepEqual(
  designSystemReadySteps.map((step) => step.state),
  ['active'],
  'designer-ready keeps the design-system station active (authoring continues in place)',
)
const handoffSteps = guidedBriefSteps('handoff', 'no', { wantsProductDiscussion: true })
assert.equal(handoffSteps[handoffSteps.length - 1].label, 'Build')
assert.equal(handoffSteps[handoffSteps.length - 1].state, 'active')

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
    'Create or validate UI direction during sprint planning because the guided frontend stage was skipped.',
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

// Preview/Source toggle (T4): opt-in Source mode on the shared HtmlArtifactFrame.
// Default off (Design Wizard usage) never shows the toggle and always renders the
// iframe with its preview controls; the view mode is forced to preview even if a
// stale 'source' value is passed. Opting in exposes the toggle and lets Source
// swap the iframe for raw HTML text while hiding the preview-only controls.
const defaultView = resolveHtmlArtifactView(false, 'preview')
assert.equal(defaultView.showToggle, false, 'toggle is hidden when Source view is not opted in')
assert.equal(defaultView.mode, 'preview', 'default is the rendered preview')
assert.equal(defaultView.showsRenderedFrame, true, 'default renders the sandboxed iframe')
assert.equal(defaultView.showsSource, false, 'default never shows raw source')
assert.equal(defaultView.showsPreviewControls, true, 'default keeps the preview toolbar controls')

assert.equal(
  resolveHtmlArtifactView(false, 'source').mode,
  'preview',
  'a stale source mode is forced back to preview when the toggle is off',
)
assert.equal(resolveHtmlArtifactView(false, 'source').showsSource, false)

const previewOptedIn = resolveHtmlArtifactView(true, 'preview')
assert.equal(previewOptedIn.showToggle, true, 'opting in exposes the Preview/Source toggle')
assert.equal(previewOptedIn.showsRenderedFrame, true, 'preview mode still renders the iframe')
assert.equal(previewOptedIn.showsSource, false)
assert.equal(previewOptedIn.showsPreviewControls, true, 'preview mode keeps viewport/zoom/allow-scripts')

const sourceOptedIn = resolveHtmlArtifactView(true, 'source')
assert.equal(sourceOptedIn.showToggle, true)
assert.equal(sourceOptedIn.mode, 'source')
assert.equal(sourceOptedIn.showsRenderedFrame, false, 'source mode unmounts the iframe (no script execution)')
assert.equal(sourceOptedIn.showsSource, true, 'source mode shows the raw HTML text')
assert.equal(
  sourceOptedIn.showsPreviewControls,
  false,
  'source mode hides the preview-only controls that shape the iframe',
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
    statPath: async (path) => ({
      modifiedAt: path.endsWith('app.html') ? '2026-06-07T09:30:00.000Z' : '2026-06-07T10:00:00.000Z',
      modifiedAtMs: path.endsWith('app.html') ? 1780824600000 : 1780826400000,
      sizeBytes: 128,
    }),
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
  assert.equal(
    findDesignArtifact(index, 'mockups/app.html')?.modifiedAt,
    '2026-06-07T09:30:00.000Z',
    'design artifact rows carry filesystem modified time when available',
  )

  // Empty workspace → empty, not a fabricated success.
  const emptyIndex = await collectDesignArtifacts('/empty', {
    readdir: async () => [],
    pathExists: async () => false,
  })
  assert.equal(emptyIndex.count, 0, 'no files on disk yields an empty index')

  console.log('designArtifacts: ok')
}

async function testCollectDesignSystemBundleArtifacts(): Promise<void> {
  const dirs: Record<string, { name: string; isDir: boolean }[]> = {
    '/ds/design-system': [
      { name: 'design-system.json', isDir: false },
      { name: 'USAGE.md', isDir: false },
      { name: 'AGENTS.md', isDir: false },
      { name: 'foundations', isDir: true },
      { name: 'components', isDir: true },
      { name: 'scripts', isDir: true },
    ],
    '/ds/design-system/foundations': [
      { name: 'tokens.tokens.json', isDir: false },
      { name: 'tokens.css', isDir: false },
      { name: 'principles.md', isDir: false },
    ],
    '/ds/design-system/components': [{ name: 'button', isDir: true }],
    '/ds/design-system/components/button': [
      { name: 'component.html', isDir: false },
      { name: 'component.css', isDir: false },
      { name: 'component.md', isDir: false },
    ],
    '/ds/design-system/scripts': [
      { name: 'build-tokens.mjs', isDir: false }, // plumbing → unclassified
      { name: 'lint.mjs', isDir: false },
    ],
  }
  const ports: DesignArtifactFsPort = {
    readdir: async (path) => dirs[path] ?? [],
    pathExists: async () => false,
  }

  // With the default (shared-root) roots, the bundle tree stays out of the
  // index — full-brief and frontend-design workspaces are untouched by the
  // design-system preset.
  const defaultIndex = await collectDesignArtifacts('/ds', ports)
  assert.equal(defaultIndex.count, 0, 'bundle files are not indexed without the design-system roots')

  const index = await collectDesignArtifacts('/ds', ports, {
    roots: designArtifactRootsForPreset('design-system'),
  })
  assert.deepEqual(
    index.groups.find((group) => group.id === 'pages')?.entries.map((entry) => entry.relativePath),
    ['design-system/components/button/component.html'],
    'bundle component demos are pages (they drive designer readiness)',
  )
  assert.deepEqual(
    index.groups.find((group) => group.id === 'notes')?.entries.map((entry) => entry.relativePath),
    [
      'design-system/AGENTS.md',
      'design-system/components/button/component.md',
      'design-system/foundations/principles.md',
      'design-system/USAGE.md',
    ],
    'bundle markdown (contracts, principles, component docs) lands in notes',
  )
  assert.deepEqual(
    index.groups.find((group) => group.id === 'scripts')?.entries.map((entry) => entry.relativePath),
    ['design-system/design-system.json', 'design-system/foundations/tokens.tokens.json'],
    'manifest and token source are data entries; generator .mjs files stay unclassified',
  )
  assert.deepEqual(
    index.groups.find((group) => group.id === 'stylesheets')?.entries.map((entry) => entry.relativePath),
    [
      'design-system/components/button/component.css',
      'design-system/foundations/tokens.css',
    ],
    'bundle css (source and derived) is previewable',
  )

  console.log('designArtifacts design-system bundle: ok')
}

// --- Run-scoped discovery (MC-1502) ----------------------------------------

// Per-preset root selection: the design-system studio owns only the bundle and
// inspiration trees; the shared-root presets keep mockups + ui-direction.
{
  const designSystemRoots = designArtifactRootsForPreset('design-system')
  assert.deepEqual(
    designSystemRoots,
    { mockups: false, uiDirection: false, inspiration: true, designSystemBundle: true },
    'design-system preset drops mockups/ and product/ui-direction.md from its roots',
  )
  const fullBriefRoots = designArtifactRootsForPreset('full-brief')
  assert.deepEqual(
    fullBriefRoots,
    { mockups: true, uiDirection: true, inspiration: true, designSystemBundle: false },
    'full-brief keeps the shared roots and never indexes the bundle tree',
  )
  assert.deepEqual(
    designArtifactRootsForPreset('frontend-design'),
    fullBriefRoots,
    'frontend-design shares the full-brief roots',
  )
}

// Baseline diff decisions: new / modified (mtime or size) / untouched, and the
// no-baseline (legacy run) passthrough.
{
  const baseline: ScaffoldBaseline = {
    version: 1,
    files: { 'mockups/legacy.html': { mtimeMs: 1000, size: 42 } },
  }
  assert.equal(
    isNewOrModifiedSinceBaseline(baseline, 'mockups/new.html', { modifiedAtMs: 5000, sizeBytes: 10 }),
    true,
    'a file absent from the baseline is new',
  )
  assert.equal(
    isNewOrModifiedSinceBaseline(baseline, 'mockups/legacy.html', { modifiedAtMs: 9999, sizeBytes: 42 }),
    true,
    'an mtime change marks a baseline file as modified',
  )
  assert.equal(
    isNewOrModifiedSinceBaseline(baseline, 'mockups/legacy.html', { modifiedAtMs: 1000, sizeBytes: 43 }),
    true,
    'a size change marks a baseline file as modified even when mtime is unchanged (git checkout)',
  )
  assert.equal(
    isNewOrModifiedSinceBaseline(baseline, 'mockups/legacy.html', { modifiedAtMs: 1000, sizeBytes: 42 }),
    false,
    'an untouched baseline file stays hidden',
  )
  assert.equal(
    isNewOrModifiedSinceBaseline(baseline, 'mockups/legacy.html', null),
    false,
    'a baseline file with unavailable stats counts as untouched, not run output',
  )
  assert.equal(
    isNewOrModifiedSinceBaseline(null, 'mockups/legacy.html', null),
    true,
    'no baseline (legacy run) means no filtering',
  )
}

// Baseline serialization round-trip and strict parse.
{
  const baseline: ScaffoldBaseline = {
    version: 1,
    files: { 'mockups/a.html': { mtimeMs: 1, size: 2 } },
  }
  assert.deepEqual(parseScaffoldBaseline(serializeScaffoldBaseline(baseline)), baseline)
  assert.equal(parseScaffoldBaseline('not json'), null, 'malformed JSON parses to null (no filtering)')
  assert.equal(parseScaffoldBaseline('{"version":2,"files":{}}'), null, 'unknown versions are rejected')
  assert.equal(
    parseScaffoldBaseline('{"version":1,"files":{"a":{"mtimeMs":"soon","size":1}}}'),
    null,
    'shape drift inside files is rejected',
  )
}

async function testRunScopedDiscovery(): Promise<void> {
  // Seeded design-system run: the seed repo has its own mockups/*.html and a
  // product/ui-direction.md; the wizard bundle and an inspiration drop exist too.
  const dirs: Record<string, { name: string; isDir: boolean }[]> = {
    '/seeded/mockups': [
      { name: 'legacy-a.html', isDir: false },
      { name: 'legacy-b.html', isDir: false },
    ],
    '/seeded/design-system': [
      { name: 'design-system.json', isDir: false },
      { name: 'USAGE.md', isDir: false },
    ],
    '/seeded/.guided-brief/inspiration': [{ name: 'ref.png', isDir: false }],
  }
  const stats: Record<string, { modifiedAtMs: number; sizeBytes: number }> = {
    '/seeded/mockups/legacy-a.html': { modifiedAtMs: 100, sizeBytes: 10 },
    '/seeded/mockups/legacy-b.html': { modifiedAtMs: 200, sizeBytes: 20 },
    '/seeded/product/ui-direction.md': { modifiedAtMs: 300, sizeBytes: 30 },
    '/seeded/design-system/design-system.json': { modifiedAtMs: 400, sizeBytes: 40 },
    '/seeded/design-system/USAGE.md': { modifiedAtMs: 500, sizeBytes: 50 },
    '/seeded/.guided-brief/inspiration/ref.png': { modifiedAtMs: 600, sizeBytes: 60 },
  }
  const ports: DesignArtifactFsPort = {
    readdir: async (path) => dirs[path] ?? [],
    pathExists: async (path) => path in stats,
    statPath: async (path) => {
      const stat = stats[path]
      if (!stat) throw new Error(`missing stat: ${path}`)
      return { modifiedAt: new Date(stat.modifiedAtMs).toISOString(), ...stat }
    },
  }

  const designSystemIndex = await collectDesignArtifacts('/seeded', ports, {
    roots: designArtifactRootsForPreset('design-system'),
  })
  assert.equal(
    designSystemIndex.entries.some((entry) => entry.relativePath.startsWith('mockups/')),
    false,
    'a seeded design-system run indexes zero repo mockups',
  )
  assert.equal(
    designSystemIndex.entries.some((entry) => entry.relativePath === 'product/ui-direction.md'),
    false,
    'the seed repo ui-direction.md is source material, not a run artifact',
  )
  assert.equal(
    designSystemBundleFileCount(designSystemIndex),
    2,
    'the bundle count equals the files under design-system/',
  )
  assert.equal(designSystemIndex.count, 3, 'inspiration is listed in the index')
  assert.ok(
    designSystemBundleFileCount(designSystemIndex) < designSystemIndex.count,
    'inspiration files are never counted as bundle content',
  )

  // frontend-design run over the same seeded repo, with a scaffold baseline:
  // pre-existing untouched files disappear, a modified pre-existing file and a
  // post-scaffold file appear, and a deleted baseline file never surfaces.
  const baseline: ScaffoldBaseline = {
    version: 1,
    files: {
      'mockups/legacy-a.html': { mtimeMs: 100, size: 10 },
      'mockups/legacy-b.html': { mtimeMs: 200, size: 20 },
      'mockups/deleted.html': { mtimeMs: 250, size: 25 },
      'product/ui-direction.md': { mtimeMs: 300, size: 30 },
    },
  }
  dirs['/seeded/mockups'].push({ name: 'fresh.html', isDir: false })
  stats['/seeded/mockups/fresh.html'] = { modifiedAtMs: 900, sizeBytes: 90 }
  stats['/seeded/mockups/legacy-b.html'] = { modifiedAtMs: 950, sizeBytes: 21 } // agent modified it

  const filteredIndex = await collectDesignArtifacts('/seeded', ports, {
    roots: designArtifactRootsForPreset('frontend-design'),
    baseline,
  })
  assert.deepEqual(
    filteredIndex.groups.find((group) => group.id === 'pages')?.entries.map((entry) => entry.relativePath),
    ['mockups/fresh.html', 'mockups/legacy-b.html'],
    'baseline filtering keeps only files written or modified after scaffold',
  )
  assert.equal(
    filteredIndex.entries.some((entry) => entry.relativePath === 'product/ui-direction.md'),
    false,
    'an untouched pre-existing ui-direction.md is filtered by the baseline',
  )

  // Same run without a baseline file (existing pre-MC-1502 workspace): no
  // filtering, no crash — every discovered file appears as before.
  const unfilteredIndex = await collectDesignArtifacts('/seeded', ports, {
    roots: designArtifactRootsForPreset('frontend-design'),
  })
  assert.deepEqual(
    unfilteredIndex.groups.find((group) => group.id === 'pages')?.entries.map((entry) => entry.relativePath),
    ['mockups/fresh.html', 'mockups/legacy-a.html', 'mockups/legacy-b.html'],
    'a run without a baseline keeps the unfiltered index',
  )
  assert.equal(
    unfilteredIndex.entries.some((entry) => entry.relativePath === 'product/ui-direction.md'),
    true,
    'ui-direction.md stays indexed when no baseline exists',
  )

  // buildScaffoldBaseline records exactly the current shared-root files.
  const built = await buildScaffoldBaseline('/seeded', {
    readdir: async (path) => dirs[path] ?? [],
    pathExists: async (path) => path in stats,
    statPath: async (path) => {
      const stat = stats[path]
      if (!stat) throw new Error(`missing stat: ${path}`)
      return { modifiedAt: new Date(stat.modifiedAtMs).toISOString(), ...stat }
    },
  })
  assert.deepEqual(built, {
    version: 1,
    files: {
      'mockups/legacy-a.html': { mtimeMs: 100, size: 10 },
      'mockups/legacy-b.html': { mtimeMs: 950, size: 21 },
      'mockups/fresh.html': { mtimeMs: 900, size: 90 },
      'product/ui-direction.md': { mtimeMs: 300, size: 30 },
    },
  }, 'the baseline records path + mtime + size for every file under the shared roots')

  console.log('run-scoped discovery: ok')
}

// ---------------------------------------------------------------------------
// Canvas-first studio shell (MC-1510): the switcher/bubble decisions the
// CanvasStudio renders from are pure, so they are asserted here rather than in
// the DOM.
// ---------------------------------------------------------------------------
function testCanvasStudioModel() {
  // Screen switcher: ≤6 screens ride inline in the pill; 7+ collapse to the
  // drawer. The boundary sits exactly at INLINE_SCREEN_SWITCHER_MAX.
  assert.equal(INLINE_SCREEN_SWITCHER_MAX, 6, 'inline switcher caps at 6 screens')
  assert.equal(screenSwitcherMode(0), 'inline', 'no screens stays inline')
  assert.equal(screenSwitcherMode(6), 'inline', '6 screens ride inline in the pill')
  assert.equal(screenSwitcherMode(7), 'drawer', '7 screens collapse to the drawer')

  // Screens are the real HTML pages (the `pages` group), in index order; other
  // groups (styles, notes) never appear in the switcher.
  const index = {
    groups: [
      {
        id: 'pages' as const,
        label: 'Pages',
        entries: [
          { name: 'onboarding.html', relativePath: 'mockups/onboarding.html', absolutePath: '/w/mockups/onboarding.html', kind: 'page' as const, typeLabel: 'HTML' },
          { name: 'jobs.html', relativePath: 'mockups/jobs.html', absolutePath: '/w/mockups/jobs.html', kind: 'page' as const, typeLabel: 'HTML' },
        ],
      },
      {
        id: 'stylesheets' as const,
        label: 'Styles',
        entries: [
          { name: 'app.css', relativePath: 'mockups/app.css', absolutePath: '/w/mockups/app.css', kind: 'stylesheet' as const, typeLabel: 'CSS' },
        ],
      },
    ],
    entries: [],
    count: 3,
  }
  assert.deepEqual(
    canvasScreensFromIndex(index),
    [
      { id: 'mockups/onboarding.html', name: 'onboarding.html', path: 'mockups/onboarding.html' },
      { id: 'mockups/jobs.html', name: 'jobs.html', path: 'mockups/jobs.html' },
    ],
    'only HTML pages become canvas screens, in index order, carrying the demoted path',
  )
  assert.deepEqual(
    canvasScreensFromIndex({ groups: [], entries: [], count: 0 }),
    [],
    'an index with no pages yields no screens',
  )

  // Preview title helpers (MC-1505): the page's <title> leads, a raw
  // date-prefixed filename never becomes a primary label.
  assert.equal(pageTitleFromHtml('<html><head><title>Onboarding</title></head></html>'), 'Onboarding')
  assert.equal(
    pageTitleFromHtml('<title>\n  Dashboard\n  overview  </title>'),
    'Dashboard overview',
    'title text is whitespace-collapsed',
  )
  assert.equal(pageTitleFromHtml('<TITLE>Cased</TITLE>'), 'Cased', 'the title tag match is case-insensitive')
  assert.equal(pageTitleFromHtml('<title></title>'), null, 'an empty title is treated as absent')
  assert.equal(pageTitleFromHtml('<div>no title here</div>'), null, 'no title tag yields null')

  assert.equal(
    humanizeFileTitle('2026-07-06-panel-header-normalization.html'),
    'Panel header normalization',
    'a leading ISO date prefix is stripped so it never reads as a primary label',
  )
  assert.equal(humanizeFileTitle('mockups/app_shell.html'), 'App shell', 'the basename is humanized')
  assert.equal(humanizeFileTitle('tokens.tokens.json'), 'Tokens.tokens', 'only the final extension is dropped')
  assert.equal(humanizeFileTitle('2026-07-06-.html'), '2026-07-06-.html', 'a name that is only a date keeps its raw basename')

  assert.equal(
    htmlPreviewTitle('mockups/app.html', '<title>Home</title>'),
    'Home',
    'a document title wins over the filename',
  )
  assert.equal(
    htmlPreviewTitle('mockups/app-shell.html', null),
    'App shell',
    'before content loads, the humanized filename is the fallback title',
  )
  assert.equal(
    htmlPreviewTitle('mockups/app-shell.html', '<div>no title</div>'),
    'App shell',
    'a document with no title falls back to the humanized filename',
  )

  // Collapsed bubble status line + dot tone come from the same live stage status
  // (MC-1503) the header chip shows — the stage-ready flip wins over live status.
  assert.equal(bubbleStatusLine('working', false), 'Working', 'working reads as Working')
  assert.equal(
    bubbleStatusLine('needs-input', false),
    'Waiting for your input',
    'a pending question reads as waiting',
  )
  assert.equal(bubbleStatusLine('idle', true), 'Ready for review', 'the ready flip wins over idle')
  assert.equal(bubbleStatusLine(undefined, false), 'Idle', 'an absent session rests at Idle')
  assert.equal(bubbleDotTone('needs-input', false), 'var(--tone-warn)', 'waiting dot is warn-toned')
  assert.equal(bubbleDotTone('idle', true), 'var(--tone-good)', 'ready dot is good-toned')

  // Only a live pending question pulls the eye (attention ring).
  assert.equal(bubbleNeedsAttention('needs-input'), true, 'a pending question needs attention')
  assert.equal(bubbleNeedsAttention('working'), false, 'a working agent does not')
  assert.equal(bubbleNeedsAttention(undefined), false, 'an absent session does not')

  // Avatar initials: two words → first letters; one word → first two letters.
  assert.equal(agentInitials('Frontend Designer'), 'FD', 'two words take their initials')
  assert.equal(agentInitials('Architect'), 'AR', 'one word takes its first two letters')

  console.log('canvas-first studio model: ok')
}

// ---------------------------------------------------------------------------
// Live component gallery (MC-1509): the gallery re-derives its sections from the
// run-scoped design index, so the grouping/keying/counting decisions are pure
// and asserted here rather than in the DOM.
// ---------------------------------------------------------------------------
function testComponentGalleryModel() {
  assert.equal(humanizeComponentName('button'), 'Button', 'a single word is sentence-cased')
  assert.equal(humanizeComponentName('task-card'), 'Task card', 'kebab dir names become sentence case')
  assert.equal(humanizeComponentName('empty_state'), 'Empty state', 'snake dir names become sentence case')

  assert.equal(componentTitleFromMarkdown('# Button\n\nThe action control.'), 'Button', 'title is the first h1')
  assert.equal(
    componentTitleFromMarkdown('intro\n\n#  Task card  \nbody'),
    'Task card',
    'a later h1 is found and trimmed',
  )
  assert.equal(componentTitleFromMarkdown('## Anatomy\nno h1 here'), null, 'no h1 yields no title')
  assert.equal(componentTitleFromMarkdown(''), null, 'empty markdown yields no title')

  function dsEntry(relativePath: string, kind: DesignArtifactKind, modifiedAtMs: number): DesignArtifactEntry {
    const name = relativePath.split('/').at(-1) ?? relativePath
    return { name, relativePath, absolutePath: `/ds/${relativePath}`, kind, typeLabel: 'X', modifiedAtMs }
  }

  const index = buildDesignArtifactIndex([
    dsEntry('design-system/components/button/component.html', 'page', 100),
    dsEntry('design-system/components/button/component.md', 'notes', 90),
    dsEntry('design-system/components/button/component.css', 'stylesheet', 80),
    // badge exists (css + md) but has no component.html yet → building.
    dsEntry('design-system/components/badge/component.md', 'notes', 70),
    dsEntry('design-system/components/badge/component.css', 'stylesheet', 60),
    dsEntry('design-system/glyphs/search.svg', 'image', 50),
    dsEntry('design-system/glyphs/close.svg', 'image', 40),
    dsEntry('design-system/foundations/tokens.tokens.json', 'script', 30),
    dsEntry('design-system/foundations/tokens.css', 'stylesheet', 20),
    dsEntry('design-system/foundations/principles.md', 'notes', 10),
  ])
  const model = buildComponentGalleryModel(index)

  assert.deepEqual(
    model.components.map((component) => component.name),
    ['badge', 'button'],
    'components are the distinct component directories, sorted by name',
  )
  assert.deepEqual(
    model.components.map((component) => component.state),
    ['building', 'ready'],
    'a directory without component.html is building; one with it is ready',
  )
  assert.equal(model.builtCount, 1)
  assert.equal(model.buildingCount, 1)
  assert.equal(componentSectionCountLabel(model), '1 built · 1 building', 'the count is honest about both states')

  const button = model.components.find((component) => component.name === 'button')
  assert.ok(button)
  assert.equal(button?.htmlRelativePath, 'design-system/components/button/component.html')
  assert.equal(button?.htmlAbsolutePath, '/ds/design-system/components/button/component.html')
  assert.equal(
    button?.renderKey,
    'design-system/components/button/component.html::100',
    'the render key is path+mtime so only a changed html re-renders the card',
  )
  assert.equal(button?.mdKey, 'design-system/components/button/component.md::90')

  const badge = model.components.find((component) => component.name === 'badge')
  assert.equal(badge?.htmlRelativePath, null, 'a building component has no html to render')
  assert.equal(badge?.renderKey, 'design-system/components/badge::building', 'building cards get a stable non-mtime key')

  // Title resolves from component.md when read, else the sentence-case dir name.
  assert.equal(galleryComponentTitle(button!, '# Primary button\n'), 'Primary button', 'a read md heading wins')
  assert.equal(galleryComponentTitle(button!, undefined), 'Button', 'an unread md falls back to the dir name')

  assert.deepEqual(
    model.glyphs.map((glyph) => glyph.name),
    ['close', 'search'],
    'glyphs are the svgs under glyphs/, sorted by path, extension stripped',
  )
  assert.equal(model.glyphs[0].key, 'design-system/glyphs/close.svg::40', 'glyph reads are cached by path+mtime')

  assert.deepEqual(
    model.foundations.map((foundation) => foundation.id),
    ['tokens', 'principles'],
    'foundations expose the tokens source and the principles doc',
  )
  assert.equal(
    model.foundations[0].relativePath,
    'design-system/foundations/tokens.tokens.json',
    'the editable token source is preferred over the derived css',
  )
  assert.equal(model.isEmpty, false)

  // An empty bundle yields the designed empty state, never a fabricated card.
  const empty = buildComponentGalleryModel(EMPTY_DESIGN_ARTIFACT_INDEX)
  assert.equal(empty.isEmpty, true, 'no bundle files → empty gallery')
  assert.equal(empty.components.length, 0)
  assert.equal(componentSectionCountLabel(empty), '0')

  // A tokens.css-only bundle (no editable source) still surfaces the tokens card.
  const cssOnly = buildComponentGalleryModel(
    buildDesignArtifactIndex([dsEntry('design-system/foundations/tokens.css', 'stylesheet', 5)]),
  )
  assert.deepEqual(cssOnly.foundations.map((foundation) => foundation.relativePath), [
    'design-system/foundations/tokens.css',
  ], 'the derived tokens.css is the fallback link when no source exists')

  console.log('component gallery model: ok')
}

void testCollectDesignArtifacts()
  .then(() => testCollectDesignSystemBundleArtifacts())
  .then(() => testRunScopedDiscovery())
  .then(() => testCanvasStudioModel())
  .then(() => testComponentGalleryModel())
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
