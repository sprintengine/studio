import assert from 'node:assert/strict'
import type { GuidedBriefRuntimeState, Workspace } from '../../types/workspace'
import {
  createGuidedBriefSlice,
  hasGuidedBriefLayout,
  normalizeGuidedBriefState,
} from './guidedBriefSlice'

const guidedBriefInput = {
  workspaceRoot: 'C:\\repo',
  workspaceName: 'Guided workspace',
  idea: 'Build the thing',
  hasUi: 'yes',
  wantsProductDiscussion: false,
  wantsArchitectureDiscussion: true,
  wantsFrontendDiscussion: true,
  guidedRoleCliDefaults: {
    product: 'claude',
    architect: 'codex',
    frontend: 'my-custom-cli',
  },
  buildRoleCounts: {
    architect: 0,
    product: 2,
    frontend: 99,
    developer: 2.8,
    tester: -1,
  },
  buildRoleCliDefaults: {
    architect: 'claude',
    product: 'codex',
    frontend: 'claude',
    developer: 'claude',
    code_reviewer: 'codex',
    spec_reviewer: 'claude',
    tester: 'claude',
    security: 'my-custom-cli',
  },
  buildCliPermissionPreset: 'auto_workspace',
  buildStartRunner: false,
  buildAutoApproveArtifacts: true,
  stage: 'architect-ready',
  acceptedArchitecturePlan: {
    kind: 'product',
    title: 'Architecture plan',
    hash: 'plan-hash',
    path: 'product/.versions/plan.md',
  },
  acceptedMockups: [
    {
      kind: 'mockup',
      title: 'Main mockup',
      hash: 'mockup-hash',
      path: 'mockups/main.html',
    },
    { kind: 'mockup', title: 'Missing hash', path: 'mockups/bad.html' } as unknown as GuidedBriefRuntimeState['acceptedMockups'][number],
  ],
  activeMockupPath: 'mockups/main.html',
  acceptedProductBrief: null,
  acceptedUiDirection: null,
  strategistSessionId: 'strategist-session',
  architectSessionId: 'architect-session',
  designerSessionId: 'designer-session',
} satisfies Partial<GuidedBriefRuntimeState>

const normalized = normalizeGuidedBriefState(guidedBriefInput)
assert.ok(normalized, 'valid guided brief input should normalize')
assert.equal(normalized.stage, 'architect-ready')
assert.equal(normalized.guidedRoleCliDefaults.product, 'claude-code')
assert.equal(normalized.guidedRoleCliDefaults.architect, 'codex')
assert.equal(normalized.guidedRoleCliDefaults.frontend, 'my-custom-cli')
assert.equal(normalized.buildRoleCounts.architect, 1, 'architect role count is clamped to at least 1')
assert.equal(normalized.buildRoleCounts.frontend, 10, 'role counts are clamped to the maximum')
assert.equal(normalized.buildRoleCounts.developer, 2, 'role counts are floored to integers')
assert.equal(normalized.buildRoleCounts.tester, 0, 'non-architect roles clamp to zero')
assert.equal(normalized.buildRoleCliDefaults.developer, 'claude-code')
assert.equal(normalized.buildRoleCliDefaults.security, 'my-custom-cli', 'custom CLI defaults are preserved')
assert.equal(normalized.buildCliPermissionPreset, 'auto_workspace')
assert.equal(normalized.buildStartRunner, false)
assert.equal(normalized.buildAutoApproveArtifacts, true)
assert.deepEqual(normalized.acceptedArchitecturePlan, {
  kind: 'product',
  title: 'Architecture plan',
  hash: 'plan-hash',
  path: 'product/.versions/plan.md',
})
assert.equal(normalized.acceptedMockups.length, 1, 'invalid accepted artifacts are filtered')
assert.equal(normalized.activeMockupPath, 'mockups/main.html')
assert.equal(normalized.strategistSessionId, 'strategist-session')
assert.equal(normalized.architectSessionId, 'architect-session')
assert.equal(normalized.designerSessionId, 'designer-session')
assert.equal(normalized.preset, 'full-brief', 'missing preset defaults to full-brief')
assert.equal(normalized.activeDesignArtifactPath, null, 'missing activeDesignArtifactPath defaults to null')

const defaultAutomation = normalizeGuidedBriefState({
  workspaceRoot: '/repo',
  workspaceName: 'Manual by default',
  idea: 'Build carefully',
  hasUi: 'no',
})
assert.ok(defaultAutomation)
assert.equal(defaultAutomation.buildStartRunner, false)
assert.equal(defaultAutomation.buildAutoApproveArtifacts, false)
assert.equal(defaultAutomation.preset, 'full-brief', 'legacy state without preset normalizes to full-brief')
assert.equal(defaultAutomation.activeDesignArtifactPath, null)

// Multicode Design preset round-trips, and the selected design artifact path is
// preserved. An unknown preset value falls back to full-brief.
const designPreset = normalizeGuidedBriefState({
  workspaceRoot: '/repo/design',
  workspaceName: 'Design studio',
  idea: 'A calm onboarding flow',
  hasUi: 'yes',
  preset: 'frontend-design',
  activeDesignArtifactPath: 'mockups/app.html',
})
assert.ok(designPreset, 'frontend-design preset input should normalize')
assert.equal(designPreset.preset, 'frontend-design')
assert.equal(designPreset.activeDesignArtifactPath, 'mockups/app.html')

const bogusPreset = normalizeGuidedBriefState({
  workspaceRoot: '/repo/bogus',
  workspaceName: 'Bogus preset',
  idea: 'idea',
  hasUi: 'no',
  preset: 'nonsense' as unknown as GuidedBriefRuntimeState['preset'],
})
assert.ok(bogusPreset)
assert.equal(bogusPreset.preset, 'full-brief', 'unknown preset values fall back to full-brief')

const carrier = {
  workspaces: [
    {
      id: 'workspace-1',
      mode: 'standard',
      layoutModel: { global: {}, layout: { type: 'row', children: [] } },
      guidedBriefState: null,
    } as unknown as Workspace,
  ],
}
const slice = createGuidedBriefSlice((mutator) => { mutator(carrier) })
slice.setGuidedBriefState('workspace-1', guidedBriefInput as unknown as GuidedBriefRuntimeState)

assert.equal(carrier.workspaces[0].mode, 'guided-brief')
assert.ok(carrier.workspaces[0].guidedBriefState)
assert.equal(carrier.workspaces[0].guidedBriefState?.acceptedArchitecturePlan?.hash, 'plan-hash')
assert.equal(carrier.workspaces[0].guidedBriefState?.buildAutoApproveArtifacts, true)
assert.equal(
  hasGuidedBriefLayout(carrier.workspaces[0].layoutModel),
  true,
  'setGuidedBriefState should ensure the guided-brief layout'
)

// Registry-keyed roles survive guided-brief state normalization. A
// workspace that ships a custom Sprint Engine role (e.g. `marketer` from
// `.sprintengine/roles/marketer.json`) must keep its roster-table count
// and CLI default so the Sprint Engine workspace creation step seats the
// real custom-role agent — bundled-only filtering would silently drop it.
const customRoleGuidedBrief: Partial<GuidedBriefRuntimeState> = {
  workspaceRoot: '/repo/custom',
  workspaceName: 'Custom role brief',
  idea: 'Run a launch sprint with a marketer',
  hasUi: 'yes',
  buildRoleCounts: {
    architect: 0, // forced to 1
    product: 1,
    frontend: 1,
    developer: 1,
    marketer: 2,
    growth_engineer: 1,
    '': 4, // blank role id dropped
    '   ': 1, // whitespace-only role id dropped
  } as unknown as GuidedBriefRuntimeState['buildRoleCounts'],
  buildRoleCliDefaults: {
    architect: 'codex',
    product: 'codex',
    marketer: 'claude',
    growth_engineer: 'my-custom-cli',
    '': 'claude',
  } as unknown as GuidedBriefRuntimeState['buildRoleCliDefaults'],
}
const customRoleNormalized = normalizeGuidedBriefState(customRoleGuidedBrief)
assert.ok(customRoleNormalized, 'guided brief input with custom roles should normalize')
assert.equal(customRoleNormalized.buildRoleCounts.architect, 1, 'architect minimum survives missing input')
assert.equal(customRoleNormalized.buildRoleCounts.marketer, 2, 'registry-keyed marketer count is preserved')
assert.equal(customRoleNormalized.buildRoleCounts.growth_engineer, 1, 'registry-keyed growth_engineer count is preserved')
assert.equal(customRoleNormalized.buildRoleCounts[''], undefined, 'blank role id is dropped')
assert.equal(customRoleNormalized.buildRoleCounts['   '], undefined, 'whitespace-only role id is dropped')
assert.equal(customRoleNormalized.buildRoleCliDefaults.marketer, 'claude-code', 'legacy Claude CLI defaults are canonicalized')
assert.equal(customRoleNormalized.buildRoleCliDefaults.growth_engineer, 'my-custom-cli', 'custom CLI ids are preserved')
assert.equal(customRoleNormalized.buildRoleCliDefaults[''], undefined, 'blank CLI default key is dropped')
