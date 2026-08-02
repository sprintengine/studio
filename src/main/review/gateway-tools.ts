// Review's four MCP tools on the Studio gateway. They live in the review tree,
// not in core's gateway file: review registers them itself through
// `MainHost.registerMcpTools` (MC-1855, src/main/modules/review-module.ts), so
// the gateway carries no per-module knowledge and removing the module removes
// the tools. The gateway's contribution point gates every module-owned tool on
// its owner's live enablement, which is why no disabled-module check appears
// here (MC-1805 is honoured one level up).

import { resolve } from 'path'

import {
  checkBriefMatchesChangeSet,
  validateReviewBrief,
  type ReviewChangeSet,
} from '../../shared/review'
import { homePathLeak } from '../../shared/review/pathSafety'
import {
  toolError,
  toolSuccess,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'
import { createReviewChangeSetService, reviewChangeSetDir } from './changeset-service'
import { enumerateReviews } from './review-index'
import {
  readBriefFromDir,
  writeBriefAtomic,
  type BriefRunEvent,
} from './brief-run-service'


// Environment the review tools cannot derive from their arguments: which projects
// are open (the trust boundary for a caller-named projectRoot), the home dir (the
// outgoing-payload leak guard), and the sink for the brief-landed event. Injected
// so the tool code stays free of the workspace store, os, and BrowserWindow, and
// so contract tests drive each one directly.
export interface ReviewGatewayBackends {
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

  // The MC-1805 disabled-module refusal is no longer wrapped here: these tools
  // register through `MainHost.registerMcpTools` (review-module.ts), and the
  // gateway's contribution point gates every module-owned tool on its owner's
  // live enablement (`gateOnModuleEnablement` above).
  return [reviewListPending, reviewGetChangeset, reviewGetBrief, reviewSubmitBrief]
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

