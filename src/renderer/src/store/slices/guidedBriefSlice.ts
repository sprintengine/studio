import type { IJsonModel } from 'flexlayout-react'
import type {
  GuidedBriefRuntimeState,
  SprintEngineRoleCliDefaults,
  SprintEngineRoleCounts,
  SprintEngineRoleId,
  Workspace,
  WorkspaceId,
} from '../../types/workspace'

const GUIDED_BRIEF_LAYOUT_COMPONENT = 'guided-brief'

export const guidedBriefLayoutModel = (): IJsonModel => ({
  global: { tabSetEnableDrop: true, tabEnableClose: false },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        weight: 100,
        children: [
          { type: 'tab', name: 'Guided Brief', component: GUIDED_BRIEF_LAYOUT_COMPONENT },
        ],
      },
    ],
  },
})

function modelContainsComponent(value: unknown, component: string): boolean {
  if (!value) return false
  if (Array.isArray(value)) {
    return value.some((entry) => modelContainsComponent(entry, component))
  }
  if (typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  if (record.component === component) return true

  return Object.values(record).some((entry) => modelContainsComponent(entry, component))
}

export function hasGuidedBriefLayout(model: unknown): boolean {
  return modelContainsComponent(model, GUIDED_BRIEF_LAYOUT_COMPONENT)
}

export function ensureGuidedBriefLayoutModel(model: IJsonModel | undefined): IJsonModel {
  return model && hasGuidedBriefLayout(model) ? model : guidedBriefLayoutModel()
}

export const defaultGuidedBriefBuildRoleCounts = (
  hasUi: GuidedBriefRuntimeState['hasUi'] = 'yes'
): SprintEngineRoleCounts => ({
  architect: 1,
  product: 1,
  frontend: hasUi === 'yes' ? 1 : 0,
  developer: 1,
  code_reviewer: 1,
  spec_reviewer: 1,
  performance: 0,
  tester: 1,
  security: 0,
})

// Local copies of the Sprint Engine role-count / CLI-default normalizers so
// the guided-brief slice is self-contained pending the agents/run-state slice
// extractions in T18/T19. Logic is identical to workspaceStore.ts; the
// duplication will be removed when those slices land.
const defaultSprintEngineRoleCliDefaultsForGuidedBrief = (): Required<SprintEngineRoleCliDefaults> => ({
  architect: 'claude',
  product: 'claude',
  frontend: 'claude',
  developer: 'claude',
  code_reviewer: 'claude',
  spec_reviewer: 'claude',
  performance: 'claude',
  tester: 'claude',
  security: 'claude',
})

function clampGuidedBriefRoleCount(role: SprintEngineRoleId, raw: number): number {
  // Architect always seats at least one agent; other roles may be zero.
  // Counts are floored to integers and capped at the same upper bound the
  // roster table enforces so guided-brief can't slip past that ceiling.
  const minimum = role === 'architect' ? 1 : 0
  return Math.max(minimum, Math.min(10, Math.floor(raw)))
}

function isValidGuidedBriefRoleId(value: unknown): value is SprintEngineRoleId {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeRoleCountsForGuidedBrief(
  input: unknown,
  fallback: SprintEngineRoleCounts
): SprintEngineRoleCounts {
  const candidate: Record<SprintEngineRoleId, unknown> = input && typeof input === 'object'
    ? (input as Record<SprintEngineRoleId, unknown>)
    : {}
  const next: SprintEngineRoleCounts = { ...fallback }
  // Apply fallback's bundled-role entries (so missing keys keep the sensible
  // defaults) and then merge in any registry-keyed role ids the user picked
  // in the roster table. Blank/invalid role keys and non-finite values are
  // discarded so workspace creation never sees malformed counts.
  for (const role of Object.keys(fallback) as SprintEngineRoleId[]) {
    next[role] = clampGuidedBriefRoleCount(role, fallback[role] ?? 0)
  }
  for (const role of Object.keys(candidate)) {
    if (!isValidGuidedBriefRoleId(role)) continue
    const value = candidate[role]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    next[role] = clampGuidedBriefRoleCount(role, value)
  }
  // Architect minimum is enforced even when input omitted the role entirely.
  if ((next.architect ?? 0) < 1) next.architect = 1
  return next
}

function normalizeRoleCliDefaultsForGuidedBrief(
  input: SprintEngineRoleCliDefaults | null | undefined
): Required<SprintEngineRoleCliDefaults> {
  const defaults = defaultSprintEngineRoleCliDefaultsForGuidedBrief()
  // Start from the bundled defaults so guided-brief always has a CLI for the
  // canonical roles, then merge in any valid registry-keyed CLI selections
  // (e.g. `marketer: 'claude'`). Invalid CLI values and blank role keys are
  // dropped silently so workspace creation never sees malformed defaults.
  const next: Required<SprintEngineRoleCliDefaults> = { ...defaults }
  if (input && typeof input === 'object') {
    for (const role of Object.keys(input)) {
      if (!isValidGuidedBriefRoleId(role)) continue
      const value = (input as Record<SprintEngineRoleId, unknown>)[role]
      if (value === 'claude' || value === 'claude') {
        next[role] = value
      }
    }
  }
  return next
}

function normalizeGuidedBriefAcceptedArtifact(
  input: unknown
): GuidedBriefRuntimeState['acceptedProductBrief'] {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<NonNullable<GuidedBriefRuntimeState['acceptedProductBrief']>>
  if (
    (candidate.kind !== 'product' && candidate.kind !== 'mockup')
    || typeof candidate.title !== 'string'
    || typeof candidate.hash !== 'string'
    || typeof candidate.path !== 'string'
  ) {
    return null
  }
  return {
    kind: candidate.kind,
    title: candidate.title,
    hash: candidate.hash,
    path: candidate.path,
  }
}

export function normalizeGuidedBriefState(input: unknown): GuidedBriefRuntimeState | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<GuidedBriefRuntimeState>
  if (
    typeof candidate.workspaceRoot !== 'string'
    || !candidate.workspaceRoot.trim()
    || typeof candidate.workspaceName !== 'string'
    || !candidate.workspaceName.trim()
    || typeof candidate.idea !== 'string'
    || !candidate.idea.trim()
    || (candidate.hasUi !== 'yes' && candidate.hasUi !== 'no')
  ) {
    return null
  }
  const stage = (
    candidate.stage === 'strategist-working'
    || candidate.stage === 'strategist-ready'
    || candidate.stage === 'architect-working'
    || candidate.stage === 'architect-ready'
    || candidate.stage === 'designer-working'
    || candidate.stage === 'designer-ready'
    || candidate.stage === 'handoff'
  )
    ? candidate.stage
    : 'strategist-working'
  const wantsProductDiscussion = typeof candidate.wantsProductDiscussion === 'boolean'
    ? candidate.wantsProductDiscussion
    : true
  const wantsArchitectureDiscussion = typeof candidate.wantsArchitectureDiscussion === 'boolean'
    ? candidate.wantsArchitectureDiscussion
    : false
  const wantsFrontendDiscussion = typeof candidate.wantsFrontendDiscussion === 'boolean'
    ? candidate.wantsFrontendDiscussion && candidate.hasUi === 'yes'
    : candidate.hasUi === 'yes'
  const roleCliDefaults = normalizeRoleCliDefaultsForGuidedBrief(candidate.guidedRoleCliDefaults)
  const buildRoleCliDefaults = normalizeRoleCliDefaultsForGuidedBrief(candidate.buildRoleCliDefaults)
  const buildRoleCounts = normalizeRoleCountsForGuidedBrief(
    candidate.buildRoleCounts,
    defaultGuidedBriefBuildRoleCounts(candidate.hasUi)
  )
  const buildCliPermissionPreset = candidate.buildCliPermissionPreset === 'default'
    || candidate.buildCliPermissionPreset === 'auto_workspace'
    || candidate.buildCliPermissionPreset === 'bypass_all'
    ? candidate.buildCliPermissionPreset
    : 'default'

  return {
    workspaceRoot: candidate.workspaceRoot,
    workspaceName: candidate.workspaceName,
    idea: candidate.idea,
    hasUi: candidate.hasUi,
    wantsProductDiscussion,
    wantsArchitectureDiscussion,
    wantsFrontendDiscussion,
    guidedRoleCliDefaults: {
      product: roleCliDefaults.product ?? 'claude',
      architect: roleCliDefaults.architect ?? 'claude',
      frontend: roleCliDefaults.frontend ?? 'claude',
    },
    buildRoleCounts,
    buildRoleCliDefaults,
    buildCliPermissionPreset,
    buildStartRunner: typeof candidate.buildStartRunner === 'boolean'
      ? candidate.buildStartRunner
      : true,
    buildAutoApproveArtifacts: typeof candidate.buildAutoApproveArtifacts === 'boolean'
      ? candidate.buildAutoApproveArtifacts
      : false,
    stage,
    acceptedProductBrief: normalizeGuidedBriefAcceptedArtifact(candidate.acceptedProductBrief),
    acceptedArchitecturePlan: normalizeGuidedBriefAcceptedArtifact(candidate.acceptedArchitecturePlan),
    acceptedUiDirection: normalizeGuidedBriefAcceptedArtifact(candidate.acceptedUiDirection),
    acceptedMockups: Array.isArray(candidate.acceptedMockups)
      ? candidate.acceptedMockups
        .map(normalizeGuidedBriefAcceptedArtifact)
        .filter((artifact): artifact is GuidedBriefRuntimeState['acceptedMockups'][number] => artifact != null)
      : [],
    activeMockupPath: typeof candidate.activeMockupPath === 'string' ? candidate.activeMockupPath : null,
    strategistSessionId:
      typeof candidate.strategistSessionId === 'string' && candidate.strategistSessionId.trim()
        ? candidate.strategistSessionId
        : null,
    architectSessionId:
      typeof candidate.architectSessionId === 'string' && candidate.architectSessionId.trim()
        ? candidate.architectSessionId
        : null,
    designerSessionId:
      typeof candidate.designerSessionId === 'string' && candidate.designerSessionId.trim()
        ? candidate.designerSessionId
        : null,
  }
}

export interface GuidedBriefSliceActions {
  setGuidedBriefState: (
    workspaceId: WorkspaceId,
    guidedBriefState: GuidedBriefRuntimeState | null
  ) => void
}

type GuidedBriefSliceCarrier = { workspaces: Workspace[] }
type GuidedBriefSliceSet = (mutator: (state: GuidedBriefSliceCarrier) => void) => void

export function createGuidedBriefSlice(set: GuidedBriefSliceSet): GuidedBriefSliceActions {
  return {
    setGuidedBriefState: (workspaceId, guidedBriefState) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        ws.guidedBriefState = normalizeGuidedBriefState(guidedBriefState)
        if (ws.guidedBriefState) {
          ws.mode = 'guided-brief'
          ws.layoutModel = ensureGuidedBriefLayoutModel(ws.layoutModel)
        }
      }),
  }
}
