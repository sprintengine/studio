// ReviewBrief — the guide agent's walkthrough of a ReviewChangeSet. The guide
// explains and organizes; it never judges, so there is deliberately NO
// finding/severity/suggested-patch shape anywhere in these contracts. This
// module owns the types, the standalone shape validator, and the cross-object
// `checkBriefMatchesChangeSet` consistency check.

import {
  ReviewAnchor,
  LineExtent,
  isAnchorWithinExtent,
  validateAnchor,
} from './anchors'
import { ChangeSetFile, ReviewChangeSet } from './changeset'
import {
  checkBoundedString,
  checkEnum,
  checkOptionalString,
  checkStringArray,
  describeValue,
  isNonEmptyString,
  isNonNegativeInt,
  isPlainObject,
} from './guards'

export const BRIEF_SCHEMA_VERSION = 1

export const OVERVIEW_COMPLEXITIES = ['low', 'medium', 'high'] as const
export type OverviewComplexity = (typeof OVERVIEW_COMPLEXITIES)[number]

export const READING_NOTES = ['read-closely', 'mechanical-skim'] as const
export type ReadingNote = (typeof READING_NOTES)[number]

// Explanation kinds only — no issue/severity kinds. An `explain`/`context`/
// `knowledge` annotation narrates; it never flags.
export const ANNOTATION_KINDS = ['explain', 'context', 'knowledge'] as const
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

export const CHANGE_MAP_NODE_KINDS = ['data', 'api', 'ui', 'job', 'test', 'config', 'other'] as const
export type ChangeMapNodeKind = (typeof CHANGE_MAP_NODE_KINDS)[number]

// Readability backstops for the Overview change map (MC-1685).
export const CHANGE_MAP_MAX_NODES = 14
export const CHANGE_MAP_MAX_EDGES = 20
const NODE_LABEL_MAX = 40
const NODE_SUBLABEL_MAX = 48
const EDGE_LABEL_MAX = 16
const HOVER_TIP_MAX = 200
const FILE_WHY_MAX = 200

export interface KnowledgeRef {
  note: string
  reason: string
}

export interface ReviewAnnotation {
  id: string
  path: string
  anchor: ReviewAnchor
  kind: AnnotationKind
  title: string
  summary: string
  detail?: string
  hoverTip: string // ONE sentence (<= 200 chars)
  knowledgeRefs?: string[]
}

export interface ReviewStep {
  id: string
  order: number
  title: string
  narrative: string
  files: Array<{ path: string; why: string; readingNote?: ReadingNote }>
  annotations: ReviewAnnotation[]
}

export interface ChangeMapNode {
  id: string
  label: string // <= 40 chars
  sublabel?: string // <= 48 chars
  stepId: string // must reference a brief step
  kind: ChangeMapNodeKind
}

export interface ChangeMapEdge {
  from: string
  to: string
  label?: string // <= 16 chars
}

export interface ChangeMap {
  nodes: ChangeMapNode[]
  edges: ChangeMapEdge[]
  deployNote?: string
}

export interface ReviewBrief {
  schemaVersion: 1
  changeSetId: string // must equal the ReviewChangeSet.id it walks through
  headSha?: string
  generatedAt: string
  overview: {
    intent: string
    blastRadius: string
    readingGuide: string
    // The guide's reading-effort judgment. Optional because a brief can exist
    // without a guide having judged anything: the renderer synthesizes a degraded
    // model from a change set alone (MC-1815), and that model states no complexity
    // rather than inventing one. A guide's own brief still carries it — the
    // walkthrough simply omits the signal when nobody produced it.
    complexity?: OverviewComplexity
  }
  steps: ReviewStep[]
  changeMap?: ChangeMap
  knowledgeRefs: KnowledgeRef[]
  coverage: {
    assignedPaths: string[]
    unassignedPaths: string[]
  }
}

export type BriefValidation = { ok: true; value: ReviewBrief } | { ok: false; errors: string[] }
export type BriefMatchResult = { ok: true } | { ok: false; errors: string[] }

function validateOverview(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!isNonEmptyString(value.intent)) errors.push(`${path}.intent must be a non-empty string.`)
  if (!isNonEmptyString(value.blastRadius)) errors.push(`${path}.blastRadius must be a non-empty string.`)
  if (!isNonEmptyString(value.readingGuide)) errors.push(`${path}.readingGuide must be a non-empty string.`)
  // Absent is legal (a brief with no guide judgment); a value that is present must
  // still be one of the three, so a smuggled "severe" is rejected as before.
  if (value.complexity !== undefined) {
    checkEnum(value.complexity, OVERVIEW_COMPLEXITIES, `${path}.complexity`, errors)
  }
}

function validateAnnotation(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`)
  if (!isNonEmptyString(value.path)) errors.push(`${path}.path must be a non-empty string.`)
  validateAnchor(value.anchor, `${path}.anchor`, errors)
  checkEnum(value.kind, ANNOTATION_KINDS, `${path}.kind`, errors)
  if (!isNonEmptyString(value.title)) errors.push(`${path}.title must be a non-empty string.`)
  if (!isNonEmptyString(value.summary)) errors.push(`${path}.summary must be a non-empty string.`)
  checkOptionalString(value.detail, `${path}.detail`, errors)
  checkBoundedString(value.hoverTip, HOVER_TIP_MAX, `${path}.hoverTip`, errors)
  if (value.knowledgeRefs !== undefined) checkStringArray(value.knowledgeRefs, `${path}.knowledgeRefs`, errors)
}

function validateStep(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id must be a non-empty string.`)
  if (!isNonNegativeInt(value.order)) errors.push(`${path}.order must be a non-negative integer; got ${describeValue(value.order)}.`)
  if (!isNonEmptyString(value.title)) errors.push(`${path}.title must be a non-empty string.`)
  if (!isNonEmptyString(value.narrative)) errors.push(`${path}.narrative must be a non-empty string.`)

  if (!Array.isArray(value.files)) {
    errors.push(`${path}.files must be an array.`)
  } else {
    value.files.forEach((file, index) => {
      const filePath = `${path}.files[${index}]`
      if (!isPlainObject(file)) {
        errors.push(`${filePath} must be an object.`)
        return
      }
      if (!isNonEmptyString(file.path)) errors.push(`${filePath}.path must be a non-empty string.`)
      checkBoundedString(file.why, FILE_WHY_MAX, `${filePath}.why`, errors)
      if (file.readingNote !== undefined) checkEnum(file.readingNote, READING_NOTES, `${filePath}.readingNote`, errors)
    })
  }

  if (!Array.isArray(value.annotations)) {
    errors.push(`${path}.annotations must be an array.`)
  } else {
    value.annotations.forEach((annotation, index) => validateAnnotation(annotation, `${path}.annotations[${index}]`, errors))
  }
}

function validateKnowledgeRefs(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`)
    return
  }
  value.forEach((ref, index) => {
    const refPath = `${path}[${index}]`
    if (!isPlainObject(ref)) {
      errors.push(`${refPath} must be an object.`)
      return
    }
    if (!isNonEmptyString(ref.note)) errors.push(`${refPath}.note must be a non-empty string.`)
    if (!isNonEmptyString(ref.reason)) errors.push(`${refPath}.reason must be a non-empty string.`)
  })
}

function validateCoverage(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  checkStringArray(value.assignedPaths, `${path}.assignedPaths`, errors)
  checkStringArray(value.unassignedPaths, `${path}.unassignedPaths`, errors)
}

// ChangeMap shape + readability rules. The stepId->step reference is checked in
// validateReviewBrief where the step ids are in scope. MC-1685 (T8) renders this
// map and may extend the rules here.
function validateChangeMap(value: unknown, path: string, stepIds: Set<string>, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object.`)
    return
  }
  const nodeIds = new Set<string>()
  if (!Array.isArray(value.nodes)) {
    errors.push(`${path}.nodes must be an array.`)
  } else {
    if (value.nodes.length > CHANGE_MAP_MAX_NODES) {
      errors.push(`${path}.nodes must have ${CHANGE_MAP_MAX_NODES} nodes or fewer; got ${value.nodes.length}.`)
    }
    value.nodes.forEach((node, index) => {
      const nodePath = `${path}.nodes[${index}]`
      if (!isPlainObject(node)) {
        errors.push(`${nodePath} must be an object.`)
        return
      }
      if (!isNonEmptyString(node.id)) {
        errors.push(`${nodePath}.id must be a non-empty string.`)
      } else if (nodeIds.has(node.id)) {
        errors.push(`${nodePath}.id duplicates an earlier node id ${describeValue(node.id)}.`)
      } else {
        nodeIds.add(node.id)
      }
      checkBoundedString(node.label, NODE_LABEL_MAX, `${nodePath}.label`, errors)
      if (node.sublabel !== undefined) checkBoundedString(node.sublabel, NODE_SUBLABEL_MAX, `${nodePath}.sublabel`, errors)
      checkEnum(node.kind, CHANGE_MAP_NODE_KINDS, `${nodePath}.kind`, errors)
      if (!isNonEmptyString(node.stepId)) {
        errors.push(`${nodePath}.stepId must be a non-empty string.`)
      } else if (!stepIds.has(node.stepId)) {
        errors.push(`${nodePath}.stepId ${describeValue(node.stepId)} does not reference a brief step.`)
      }
    })
  }

  if (!Array.isArray(value.edges)) {
    errors.push(`${path}.edges must be an array.`)
  } else {
    if (value.edges.length > CHANGE_MAP_MAX_EDGES) {
      errors.push(`${path}.edges must have ${CHANGE_MAP_MAX_EDGES} edges or fewer; got ${value.edges.length}.`)
    }
    value.edges.forEach((edge, index) => {
      const edgePath = `${path}.edges[${index}]`
      if (!isPlainObject(edge)) {
        errors.push(`${edgePath} must be an object.`)
        return
      }
      for (const end of ['from', 'to'] as const) {
        if (!isNonEmptyString(edge[end])) {
          errors.push(`${edgePath}.${end} must be a non-empty string.`)
        } else if (!nodeIds.has(edge[end] as string)) {
          errors.push(`${edgePath}.${end} ${describeValue(edge[end])} does not reference a change-map node.`)
        }
      }
      if (edge.label !== undefined) checkBoundedString(edge.label, EDGE_LABEL_MAX, `${edgePath}.label`, errors)
    })
  }

  checkOptionalString(value.deployNote, `${path}.deployNote`, errors)
}

export function validateReviewBrief(input: unknown): BriefValidation {
  if (!isPlainObject(input)) return { ok: false, errors: ['brief must be an object.'] }
  const errors: string[] = []

  if (input.schemaVersion !== BRIEF_SCHEMA_VERSION) {
    errors.push(`brief.schemaVersion must be ${BRIEF_SCHEMA_VERSION}; got ${describeValue(input.schemaVersion)}.`)
  }
  if (!isNonEmptyString(input.changeSetId)) errors.push('brief.changeSetId must be a non-empty string.')
  checkOptionalString(input.headSha, 'brief.headSha', errors)
  if (!isNonEmptyString(input.generatedAt)) errors.push('brief.generatedAt must be a non-empty string.')

  validateOverview(input.overview, 'brief.overview', errors)

  const stepIds = new Set<string>()
  if (!Array.isArray(input.steps)) {
    errors.push('brief.steps must be an array.')
  } else {
    input.steps.forEach((step, index) => {
      validateStep(step, `brief.steps[${index}]`, errors)
      const id = isPlainObject(step) ? step.id : undefined
      if (typeof id === 'string') {
        if (stepIds.has(id)) errors.push(`brief.steps[${index}].id duplicates an earlier step id ${describeValue(id)}.`)
        else stepIds.add(id)
      }
    })
  }

  validateKnowledgeRefs(input.knowledgeRefs, 'brief.knowledgeRefs', errors)
  validateCoverage(input.coverage, 'brief.coverage', errors)

  if (input.changeMap !== undefined) validateChangeMap(input.changeMap, 'brief.changeMap', stepIds, errors)

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ReviewBrief }
}

// The 1-based line extent a changeset file describes on one side, taken from the
// union of its hunks. null when the side has no lines (binary / pure rename), so
// any anchor into it fails the extent check rather than silently passing.
function fileExtent(file: ChangeSetFile, side: 'new' | 'old'): LineExtent | null {
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (const hunk of file.hunks) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart
    const count = side === 'new' ? hunk.newLines : hunk.oldLines
    if (count <= 0) continue
    if (start < min) min = start
    const end = start + count - 1
    if (end > max) max = end
  }
  return max === 0 ? null : { min, max }
}

// Cross-check a brief against the changeset it walks. Enforces id match, every
// referenced path existing in the changeset, every anchor sitting inside its
// file's line extent, and honest coverage: each non-binary changed file assigned
// to exactly one step OR listed in unassignedPaths (never silently dropped, never
// double-assigned). Assumes both objects already passed their own validators.
export function checkBriefMatchesChangeSet(brief: ReviewBrief, changeset: ReviewChangeSet): BriefMatchResult {
  const errors: string[] = []

  if (brief.changeSetId !== changeset.id) {
    errors.push(`brief.changeSetId ${describeValue(brief.changeSetId)} does not match changeset.id ${describeValue(changeset.id)}.`)
  }

  const filesByPath = new Map(changeset.files.map((file) => [file.path, file]))

  // Path existence + double-assignment across steps.
  const assignmentCount = new Map<string, number>()
  brief.steps.forEach((step, stepIndex) => {
    step.files.forEach((file, fileIndex) => {
      if (!filesByPath.has(file.path)) {
        errors.push(`brief.steps[${stepIndex}].files[${fileIndex}].path ${describeValue(file.path)} is not in the changeset.`)
      }
      assignmentCount.set(file.path, (assignmentCount.get(file.path) ?? 0) + 1)
    })
    // Annotation path existence + anchor within extent.
    step.annotations.forEach((annotation, annIndex) => {
      const annPath = `brief.steps[${stepIndex}].annotations[${annIndex}]`
      const target = filesByPath.get(annotation.path)
      if (!target) {
        errors.push(`${annPath}.path ${describeValue(annotation.path)} is not in the changeset.`)
        return
      }
      const extent = fileExtent(target, annotation.anchor.side)
      if (!extent || !isAnchorWithinExtent(annotation.anchor, extent)) {
        const range = extent ? `${extent.min}-${extent.max}` : 'none'
        errors.push(`${annPath}.anchor lines ${annotation.anchor.startLine}-${annotation.anchor.endLine} fall outside the ${annotation.anchor.side}-side extent (${range}) of ${describeValue(annotation.path)}.`)
      }
    })
  })

  for (const [path, count] of assignmentCount) {
    if (count > 1) errors.push(`brief: path ${describeValue(path)} is assigned to ${count} steps; every file belongs to exactly one step.`)
  }

  // Coverage arrays must reflect the assignments, and every non-binary changed
  // file must be accounted for (assigned or explicitly unassigned).
  const assignedSet = new Set(assignmentCount.keys())
  const unassignedSet = new Set(brief.coverage.unassignedPaths)

  for (const path of brief.coverage.assignedPaths) {
    if (!assignedSet.has(path)) errors.push(`brief.coverage.assignedPaths lists ${describeValue(path)}, which no step assigns.`)
  }
  for (const path of assignedSet) {
    if (!brief.coverage.assignedPaths.includes(path)) errors.push(`brief.coverage.assignedPaths is missing assigned path ${describeValue(path)}.`)
    if (unassignedSet.has(path)) errors.push(`brief: path ${describeValue(path)} is both assigned and listed in unassignedPaths.`)
  }
  for (const file of changeset.files) {
    if (file.binary) continue
    if (!assignedSet.has(file.path) && !unassignedSet.has(file.path)) {
      errors.push(`brief: changed file ${describeValue(file.path)} is neither assigned to a step nor listed in coverage.unassignedPaths.`)
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
