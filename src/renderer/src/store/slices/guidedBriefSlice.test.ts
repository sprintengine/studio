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
    frontend: 'claude',
    developer: 'invalid',
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
    security: 'invalid',
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
    { kind: 'mockup', title: 'Missing hash', path: 'mockups/bad.html' },
  ],
  activeMockupPath: 'mockups/main.html',
  strategistSessionId: 'strategist-session',
  architectSessionId: 'architect-session',
  designerSessionId: 'designer-session',
} satisfies Partial<GuidedBriefRuntimeState>

const normalized = normalizeGuidedBriefState(guidedBriefInput)
assert.ok(normalized, 'valid guided brief input should normalize')
assert.equal(normalized.stage, 'architect-ready')
assert.equal(normalized.guidedRoleCliDefaults.product, 'claude')
assert.equal(normalized.guidedRoleCliDefaults.architect, 'codex')
assert.equal(normalized.guidedRoleCliDefaults.frontend, 'claude')
assert.equal(normalized.buildRoleCounts.architect, 1, 'architect role count is clamped to at least 1')
assert.equal(normalized.buildRoleCounts.frontend, 10, 'role counts are clamped to the maximum')
assert.equal(normalized.buildRoleCounts.developer, 2, 'role counts are floored to integers')
assert.equal(normalized.buildRoleCounts.tester, 0, 'non-architect roles clamp to zero')
assert.equal(normalized.buildRoleCliDefaults.developer, 'claude')
assert.equal(normalized.buildRoleCliDefaults.security, 'codex', 'invalid CLI defaults fall back')
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
slice.setGuidedBriefState('workspace-1', guidedBriefInput as GuidedBriefRuntimeState)

assert.equal(carrier.workspaces[0].mode, 'guided-brief')
assert.ok(carrier.workspaces[0].guidedBriefState)
assert.equal(carrier.workspaces[0].guidedBriefState?.acceptedArchitecturePlan?.hash, 'plan-hash')
assert.equal(carrier.workspaces[0].guidedBriefState?.buildAutoApproveArtifacts, true)
assert.equal(
  hasGuidedBriefLayout(carrier.workspaces[0].layoutModel),
  true,
  'setGuidedBriefState should ensure the guided-brief layout'
)
