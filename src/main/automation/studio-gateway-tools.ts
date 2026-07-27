import { resolve } from 'path'
import {
  SPRINTENGINE_MUTATING_TOOL_NAMES,
  SPRINTENGINE_TOOL_DEFINITIONS,
} from '../../shared/sprintengineToolNames.generated'
import {
  checkBriefMatchesChangeSet,
  validateReviewBrief,
  type ReviewChangeSet,
} from '../../shared/review'
import { homePathLeak } from '../../shared/review/pathSafety'
import type { SprintEngineMcpHubService } from '../sprintengine-mcp-hub'
import { createReviewChangeSetService, reviewChangeSetDir } from '../review/changeset-service'
import { enumerateReviews } from '../review/review-index'
import {
  readBriefFromDir,
  writeBriefAtomic,
  type BriefRunEvent,
} from '../review/brief-run-service'
import type {
  McpConnectionContext,
  McpToolRegistration,
  McpToolResult,
} from './mcp-socket-server'

const APP_MUTATION_TOOLS = new Set([
  'agent.launch',
  'automation.create',
  'automation.run',
  'backlog.assign',
  'backlog.repair',
  'backlog.update',
  'backlog.work',
  'roadmap.add_step',
  'roadmap.approve',
  'roadmap.merge',
  'roadmap.pause',
  'roadmap.remove_step',
  'roadmap.reorder',
  'roadmap.resume',
  'roadmap.skip',
  'sprint.artifact.approve',
  'sprint.artifact.request_changes',
  'sprint.cancel',
  'sprint.create',
  'sprint.pr.create',
  'sprint.pr.status',
  'sprint.resume',
  'sprint.set_mode',
  'sprint.task.comment',
  'sprint.task.create',
  'sprint.task.resolve_input',
  'sprint.task.set_status',
  'sprint.task.update',
  'workspace.create',
  // The one review tool that writes: it persists brief.json. The three review
  // reads (list/get-changeset/get-brief) are not mutations.
  'review_submit_brief',
])
const RUN_MUTATION_TOOLS = new Set<string>(SPRINTENGINE_MUTATING_TOOL_NAMES)

export function createStudioGatewayTools(options: {
  appTools: McpToolRegistration[]
  sprintEngineMcpHub: Pick<SprintEngineMcpHubService, 'callRunTool'>
  reviewTools?: McpToolRegistration[]
}): McpToolRegistration[] {
  const names = new Set<string>()
  const merged: McpToolRegistration[] = []
  for (const registration of options.appTools) addUnique(registration)
  for (const registration of options.reviewTools ?? []) addUnique(registration)
  for (const definition of SPRINTENGINE_TOOL_DEFINITIONS) {
    addUnique({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema as unknown as Record<string, unknown>,
      handler: (args, context) => callRunTool(
        options.sprintEngineMcpHub,
        definition.name,
        args,
        context ?? { metadata: { kind: 'external-local' } }
      ),
    })
  }
  return merged

  function addUnique(registration: McpToolRegistration): void {
    if (names.has(registration.name)) {
      throw new Error(`Duplicate SprintEngine Studio MCP tool registration: ${registration.name}`)
    }
    names.add(registration.name)
    merged.push(registration)
  }
}

export function isStudioGatewayMutation(toolName: string): boolean {
  return APP_MUTATION_TOOLS.has(toolName) || RUN_MUTATION_TOOLS.has(toolName)
}

// Environment the review tools cannot derive from their arguments: which projects
// are open (the trust boundary for a caller-named projectRoot), the home dir (the
// outgoing-payload leak guard), and the sink for the brief-landed event. Injected
// so the tool code stays free of the workspace store, os, and BrowserWindow, and
// so contract tests drive each one directly.
export interface ReviewGatewayBackends {
  /**
   * Whether the `review` capability module is enabled right now. Resolved per
   * call, never captured, so switching the module off in Settings takes effect
   * on the next tool call rather than at the next app start.
   */
  isReviewModuleEnabled: () => boolean
  /** Absolute folder paths of the projects currently open in the app. */
  listOpenProjectRoots: () => string[]
  /** The user's home directory, for the outgoing-payload leak guard. */
  homeDir: () => string
  /**
   * Emit a BriefRunEvent on the review brief-run channel (broadcast to windows).
   * A submitted brief emits phase 'done' so an open Reviews door reloads it with
   * no app restart — the same event the companion path already emits.
   */
  emitBriefRunEvent: (event: BriefRunEvent) => void
}

// A review id is the on-disk directory name; it must satisfy the same constraint
// changeset-service enforces so a crafted value can never escape the review root.
const REVIEW_ID_PATTERN = /^[A-Za-z0-9._-]+$/

// The one sentence a disabled Review module answers with (owner ruling, MC-1805).
const REVIEW_MODULE_DISABLED =
  'The Review module is disabled. Enable it in Settings → Modules to use review tools.'

const REVIEW_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    reviewId: { type: 'string', description: 'Review id from review_list_pending.' },
    projectRoot: {
      type: 'string',
      description: 'Absolute path to the project the review lives under; must be a project open in this app.',
    },
  },
  required: ['reviewId', 'projectRoot'],
  additionalProperties: false,
} as const

// The review tools on the Studio gateway (plan §3.3). Every tool addresses a review
// by {reviewId, projectRoot}; projectRoot is normalised and confirmed against the
// app's open project roots before any file is touched, so a raw absolute path from
// an agent is never trusted. review_submit_brief is the enforcement point — it runs
// the shape validator (whose annotation-kind enum is the no-verdicts firewall), the
// changeset cross-check loaded server-side, then the home-path leak guard, and only
// then writes and announces. The reads never leak an absolute machine path.
export function createReviewGatewayTools(backends: ReviewGatewayBackends): McpToolRegistration[] {
  const changeSets = createReviewChangeSetService()

  function openRoots(): string[] {
    return backends
      .listOpenProjectRoots()
      .filter((root) => typeof root === 'string' && root.length > 0)
      .map((root) => resolve(root))
  }

  // Confirm a caller-named {reviewId, projectRoot} and resolve the on-disk review
  // directory. Errors never echo an absolute path, so a bad guess cannot probe the
  // machine's layout.
  function resolveReviewDir(
    args: Record<string, unknown>
  ): { reviewDir: string; projectRoot: string; reviewId: string } | McpToolResult {
    const { reviewId, projectRoot } = args
    if (typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId)) {
      return toolError('invalid_arguments', '"reviewId" must be a review id (letters, digits, dot, underscore, or hyphen).')
    }
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      return toolError('invalid_arguments', '"projectRoot" must be an absolute path to an open project folder.')
    }
    const normalized = resolve(projectRoot)
    if (!openRoots().includes(normalized)) {
      return toolError('unknown_project', 'That project is not open in this app; open it, then address the review by its project.')
    }
    return { reviewDir: reviewChangeSetDir(normalized, reviewId), projectRoot: normalized, reviewId }
  }

  const reviewListPending: McpToolRegistration = {
    name: 'review_list_pending',
    description:
      'List the reviews across the projects open in this app. Each entry is addressed by {reviewId, projectRoot} and '
      + 'reports its change source and whether a walkthrough (brief) already exists — an incremental re-run target.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const reviews = await enumerateReviews(openRoots())
      return toolSuccess({
        reviews: reviews.map((review) => ({
          reviewId: review.reviewId,
          projectRoot: review.workspaceRoot,
          source: review.sourceKind,
          hasBrief: review.hasWalkthrough,
        })),
      })
    },
  }

  const reviewGetChangeset: McpToolRegistration = {
    name: 'review_get_changeset',
    description:
      'Read the normalised change set for a review: files, per-file hunks, base/head refs and SHAs, and the source '
      + 'kind. Returned in full (no silent truncation); the source\'s absolute repository path is stripped so no '
      + 'machine path leaks.',
    inputSchema: REVIEW_TARGET_SCHEMA as unknown as Record<string, unknown>,
    handler: async (args) => {
      const target = resolveReviewDir(args)
      if ('content' in target) return target
      const read = await changeSets.read(target.reviewDir)
      if (!read.ok) return toolError('changeset_unreadable', 'The stored change set could not be read or is not valid.')
      if (!read.changeset) return toolError('no_changeset', 'No change set has been ingested for this review yet.')
      const changeset = redactChangeSetForExport(read.changeset)
      // Backstop the redaction: guard the source only (diff line content is the
      // reviewed code and may legitimately mention paths).
      if (homePathLeak(changeset.source, backends.homeDir())) {
        return toolError('path_leak_blocked', 'The change set source carried an absolute machine path and was withheld.')
      }
      return toolSuccess({ changeset, truncated: false })
    },
  }

  const reviewGetBrief: McpToolRegistration = {
    name: 'review_get_brief',
    description:
      'Read the current walkthrough (brief) for a review, or null when none exists yet or the stored one is unusable. '
      + 'Use it to carry unchanged steps across an incremental re-run.',
    inputSchema: REVIEW_TARGET_SCHEMA as unknown as Record<string, unknown>,
    handler: async (args) => {
      const target = resolveReviewDir(args)
      if ('content' in target) return target
      const brief = await readBriefFromDir(target.reviewDir)
      if (brief && homePathLeak(brief, backends.homeDir())) {
        return toolError('path_leak_blocked', 'The stored brief carried an absolute machine path and was withheld.')
      }
      return toolSuccess({ brief })
    },
  }

  const reviewSubmitBrief: McpToolRegistration = {
    name: 'review_submit_brief',
    description:
      'Persist a walkthrough (brief) for a review. Pass the brief as an object (never a JSON string). It is validated '
      + 'server-side in order — schema (the annotation-kind enum is the no-verdicts firewall), then a cross-check '
      + 'against the change set loaded here, then a machine-path leak guard. An invalid brief returns every validator '
      + 'message and writes nothing; a valid brief is written atomically and an open Reviews door reloads it.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: REVIEW_TARGET_SCHEMA.properties.reviewId,
        projectRoot: REVIEW_TARGET_SCHEMA.properties.projectRoot,
        brief: { type: 'object', description: 'The brief object; see the review-guide skill for its shape.' },
      },
      required: ['reviewId', 'projectRoot', 'brief'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const target = resolveReviewDir(args)
      if ('content' in target) return target
      const { brief } = args
      if (typeof brief !== 'object' || brief === null || Array.isArray(brief)) {
        return toolError('invalid_arguments', '"brief" must be the brief object, not a JSON string.')
      }
      const shape = validateReviewBrief(brief)
      if (!shape.ok) return reviewInvalid('brief_invalid', 'The brief failed schema validation.', shape.errors)
      const read = await changeSets.read(target.reviewDir)
      if (!read.ok) return toolError('changeset_unreadable', 'The stored change set could not be read or is not valid.')
      if (!read.changeset) return toolError('no_changeset', 'No change set has been ingested for this review yet.')
      const match = checkBriefMatchesChangeSet(shape.value, read.changeset)
      if (!match.ok) return reviewInvalid('brief_mismatch', 'The brief does not match the change set.', match.errors)
      const leak = homePathLeak(shape.value, backends.homeDir())
      if (leak) return reviewInvalid('brief_path_leak', 'The brief contains an absolute machine path.', [leak])
      await writeBriefAtomic(target.reviewDir, shape.value)
      backends.emitBriefRunEvent({ workspaceId: target.reviewId, phase: 'done' })
      return toolSuccess({ ok: true, reviewId: target.reviewId, stepCount: shape.value.steps.length })
    },
  }

  // The user's module switch reaches the MCP surface too (MC-1805). Registration
  // stays static — the tools are still listed, so an agent learns the capability
  // exists and why it is refusing rather than that the tool vanished — but a
  // disabled module means every handler answers with the same plain sentence
  // before it reads or writes anything. Applied by wrapping the whole set, so a
  // tool added here later cannot forget the check.
  return [reviewListPending, reviewGetChangeset, reviewGetBrief, reviewSubmitBrief].map(
    (registration) => ({
      ...registration,
      handler: async (args: Record<string, unknown>, context?: McpConnectionContext) =>
        backends.isReviewModuleEnabled()
          ? registration.handler(args, context)
          : toolError('review_module_disabled', REVIEW_MODULE_DISABLED),
    })
  )
}

// Strip the one absolute machine path a change set carries — a branch source's
// repoRoot — before handing it to an agent. Every other field (file paths, refs,
// SHAs, a PR url) is already project-relative or public, and diff line content is
// the reviewed code itself, passed through untouched.
function redactChangeSetForExport(changeset: ReviewChangeSet): Record<string, unknown> {
  const source =
    changeset.source.kind === 'branch'
      ? { kind: 'branch', baseRef: changeset.source.baseRef, headRef: changeset.source.headRef }
      : changeset.source
  return { ...changeset, source }
}

function toolSuccess(structured: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

// A validation failure the retry loop consumes: a summary plus EVERY validator
// message, so the caller fixes all problems in one pass rather than one per round.
function reviewInvalid(code: string, message: string, errors: string[]): McpToolResult {
  const structured = { ok: false, error: { code, message }, errors }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

async function callRunTool(
  hub: Pick<SprintEngineMcpHubService, 'callRunTool'>,
  toolName: string,
  args: Record<string, unknown>,
  context: McpConnectionContext
): Promise<McpToolResult> {
  const runId = context.metadata.sprintRunId
  if (!runId) {
    return toolError(
      'no_active_sprint',
      'This MCP connection has no active Sprint Engine run. Launch or enter a sprint in SprintEngine Studio, then use that sprint agent connection.'
    )
  }
  try {
    const result = await hub.callRunTool({ runId, toolName, arguments: args })
    if (isMcpToolResult(result)) return result
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: isRecord(result) ? result : { result },
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const code = /module is disabled|module is unavailable/i.test(text)
      ? 'sprintengine_module_disabled'
      : /not registered|not ready/i.test(text)
        ? 'no_active_sprint'
        : 'sprintengine_proxy_error'
    return toolError(code, text)
  }
}

function toolError(code: string, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true,
  }
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return isRecord(value) && Array.isArray(value.content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
