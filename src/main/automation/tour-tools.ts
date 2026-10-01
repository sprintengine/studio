import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { parseTourCreate, parseTourUpdate } from '../../shared/tours/tour-input'
import type { Tour } from '../../shared/tours/tour-types'
import type { TourCaller, TourService } from '../tours/tour-service'

// The `tour.*` gateway tools: an agent walking the owner through its own
// changes, inside the Diff viewer (src/main/tours/tour-service.ts).
//
// The agent writes the whole tour in one call and the server resolves every
// anchor before accepting it. A refusal lists EVERY problem, so an agent fixes
// all of them and resubmits once — the alternative, one error per round trip,
// is a twelve-step tour costing twelve calls.

export const TOUR_MUTATION_TOOL_NAMES: readonly string[] = ['tour.create', 'tour.update', 'tour.goto', 'tour.close']

export type TourToolsDeps = {
  service: TourService
  hasWorkspace: (workspaceId: string) => boolean
}

function success(structured: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

function failure(code: string, message: string, errors?: string[]): McpToolResult {
  const structured = { error: { code, message, ...(errors ? { errors } : {}) } }
  const text = errors && errors.length > 0 ? `${message}\n${errors.map((line) => `- ${line}`).join('\n')}` : message
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: true }
}

const WORKSPACE_ID = {
  type: 'string',
  description: 'Only for a connection not bound to a workspace. A bound connection must leave it out.',
} as const

const STEP_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'body', 'path'],
  properties: {
    id: { type: 'string', description: 'A short unique slug, e.g. "retry-loop".' },
    title: { type: 'string', description: 'A few words: what this step is about.' },
    body: { type: 'string', description: 'Markdown. Why the code is shaped this way — not a line-by-line paraphrase.' },
    hoverTip: { type: 'string', description: 'Optional one-liner for the step list tooltip.' },
    kind: {
      type: 'string',
      enum: ['explain', 'context', 'caveat'],
      description: '"caveat" marks an honest weak spot or open question. Default "explain".',
    },
    path: { type: 'string', description: 'Repository-relative path of the file (its new path if renamed).' },
    oldPath: { type: 'string', description: 'A renamed file’s previous path.' },
    side: {
      type: 'string',
      enum: ['new', 'old'],
      description:
        '"new" (default) is the file after the change; "old" is before it — use it for removed code and deleted files.',
    },
    match: {
      type: 'string',
      description: 'Preferred anchor: text that appears exactly once on that side of the file (one or more lines).',
    },
    lineCount: {
      type: 'integer',
      minimum: 1,
      description: 'With match: how many lines the step covers from the match.',
    },
    hunk: { type: 'integer', minimum: 1, description: 'Anchor to the file’s n-th change (1-based, in file order).' },
    lines: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 2,
      maxItems: 2,
      description: '[start, end], 1-based, on the chosen side. Prefer match or hunk.',
    },
    fileOnly: {
      type: 'boolean',
      description: 'true: the step is about the whole file (binary, huge, or a file-level point).',
    },
  },
  additionalProperties: false,
} as const

function tourView(tour: Tour): Record<string, unknown> {
  return {
    tourId: tour.id,
    state: tour.closed ? 'closed' : tour.playback.started ? 'playing' : 'ready',
    steps: tour.steps.map((step) => ({
      id: step.id,
      side: step.anchor.side,
      path: step.anchor.path,
      lines: step.anchor.startLine === null ? null : [step.anchor.startLine, step.anchor.endLine],
    })),
  }
}

export function createTourTools(deps: TourToolsDeps): McpToolRegistration[] {
  function caller(args: Record<string, unknown>, context?: McpConnectionContext): TourCaller | McpToolResult {
    const bound = context?.metadata.workspaceId
    const explicit = typeof args.workspaceId === 'string' && args.workspaceId.trim() ? args.workspaceId.trim() : null
    if (bound && explicit && explicit !== bound) {
      return failure('forbidden', 'This connection is bound to its own workspace; drop `workspaceId`.')
    }
    const workspaceId = bound ?? explicit
    if (!workspaceId) return failure('no_workspace', 'This connection is not bound to a workspace; pass `workspaceId`.')
    if (!deps.hasWorkspace(workspaceId)) {
      return failure('unknown_workspace', `Workspace "${workspaceId}" is not known to the running app.`)
    }
    const metadata = context?.metadata
    return {
      workspaceId,
      ...(metadata?.agentId ? { agentId: metadata.agentId } : {}),
      ...(metadata?.agentName ? { agentName: metadata.agentName } : {}),
      ...(metadata?.cliId ? { cliId: metadata.cliId } : {}),
    }
  }

  function withoutWorkspace(args: Record<string, unknown>): Record<string, unknown> {
    const { workspaceId: _ignored, ...rest } = args
    return rest
  }

  return [
    {
      name: 'tour.create',
      description:
        'Walk the owner through your changes: write a guided tour, played step by step inside the Diff viewer with your notes beside the code. Write the WHOLE tour in one call. Every anchor is resolved before the tour is accepted; if anything is wrong the call fails with the complete list of problems — fix them all and call again. Nothing plays until the owner presses Start, and the Diff tab is docked without taking focus: `revealed: false` only means no window is showing the workspace; the tour is saved either way. Order steps foundations → behaviour → surface → tests. Anchor with `match` or `hunk` rather than counted lines.',
      inputSchema: {
        type: 'object',
        required: ['title', 'changes', 'steps'],
        properties: {
          title: { type: 'string', description: 'What the tour covers, in a few words.' },
          overview: { type: 'string', description: 'Optional markdown shown on the Start card.' },
          changes: {
            type: 'object',
            description:
              'Which changes: {kind:"changelist"} your own uncommitted files; {kind:"worktree"} everything uncommitted; {kind:"range", base, head} commits (pinned to SHAs).',
            properties: {
              kind: { type: 'string', enum: ['changelist', 'worktree', 'range'] },
              base: { type: 'string' },
              head: { type: 'string' },
            },
            required: ['kind'],
          },
          steps: { type: 'array', items: STEP_SCHEMA, minItems: 1 },
          workspaceId: WORKSPACE_ID,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const who = caller(args, context)
        if ('content' in who) return who
        const parsed = parseTourCreate(withoutWorkspace(args))
        if (!parsed.ok && !parsed.partial) {
          return failure('invalid_tour', 'The tour was not created. Fix every problem below:', parsed.errors)
        }
        const created = parsed.ok
          ? await deps.service.create(parsed.value, who)
          : await deps.service.create(parsed.partial!, who, parsed.errors)
        if (!created.ok)
          return failure(created.code, 'The tour was not created. Fix every problem below:', created.errors)
        return success({
          ...tourView(created.tour),
          revealed: created.revealed,
          ...(created.revealed
            ? {}
            : {
                note: 'No window is showing this workspace right now; the tour is saved and appears in the Diff viewer’s tour list.',
              }),
        })
      },
    },
    {
      name: 'tour.update',
      description:
        'Change a tour you wrote: `insertAfter` {after?: stepId|null, steps} adds steps (omit `after` to append — stream a long tour in batches — or put a detour answering a question right after the step it is about); `replace` swaps steps by id; `remove` drops ids. Applied remove → replace → insert. New steps are resolved like tour.create, and every problem is listed at once.',
      inputSchema: {
        type: 'object',
        required: ['tourId'],
        properties: {
          tourId: { type: 'string' },
          insertAfter: {
            type: 'object',
            properties: {
              after: {
                type: ['string', 'null'],
                description: 'Step id to insert after; null inserts at the start; omit to append.',
              },
              steps: { type: 'array', items: STEP_SCHEMA, minItems: 1 },
            },
            required: ['steps'],
          },
          replace: { type: 'array', items: STEP_SCHEMA },
          remove: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          overview: { type: 'string' },
          workspaceId: WORKSPACE_ID,
        },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const who = caller(args, context)
        if ('content' in who) return who
        const parsed = parseTourUpdate(withoutWorkspace(args))
        if (!parsed.ok)
          return failure('invalid_update', 'The tour was not changed. Fix every problem below:', parsed.errors)
        const updated = await deps.service.update(parsed.value, who)
        if (!updated.ok)
          return failure(updated.code, 'The tour was not changed. Fix every problem below:', updated.errors)
        return success(tourView(updated.tour))
      },
    },
    {
      name: 'tour.goto',
      description:
        'Point the owner at a step — e.g. after answering a question about it. The view moves only if the owner turned on "Follow agent" and the tour is on screen; otherwise they see a chip saying you point there. `moved: false` is not an error; `reason` says why (follow_off, not_showing, not_started, no_viewer).',
      inputSchema: {
        type: 'object',
        required: ['tourId', 'stepId'],
        properties: { tourId: { type: 'string' }, stepId: { type: 'string' }, workspaceId: WORKSPACE_ID },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const who = caller(args, context)
        if ('content' in who) return who
        const tourId = typeof args.tourId === 'string' ? args.tourId : ''
        const stepId = typeof args.stepId === 'string' ? args.stepId : ''
        const result = await deps.service.goto(who.workspaceId, tourId, stepId, who.agentId)
        if (!result.ok) return failure(result.code, result.message)
        return success({ moved: result.moved, reason: result.reason })
      },
    },
    {
      name: 'tour.status',
      description:
        'Where the owner is in a tour: the current step, visited steps, steps whose code moved since you wrote them (`moved`) or left the diff (`gone`), whether they follow you, and their recent questions. Read-only.',
      inputSchema: {
        type: 'object',
        required: ['tourId'],
        properties: { tourId: { type: 'string' }, workspaceId: WORKSPACE_ID },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const who = caller(args, context)
        if ('content' in who) return who
        const result = await deps.service.status(who.workspaceId, typeof args.tourId === 'string' ? args.tourId : '')
        if (!result.ok) return failure(result.code, result.message)
        return success(result.status as unknown as Record<string, unknown>)
      },
    },
    {
      name: 'tour.close',
      description:
        'End a tour: the viewer leaves tour mode and queued questions are dropped. The tour stays in the recent list.',
      inputSchema: {
        type: 'object',
        required: ['tourId'],
        properties: { tourId: { type: 'string' }, workspaceId: WORKSPACE_ID },
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const who = caller(args, context)
        if ('content' in who) return who
        const result = await deps.service.close(
          who.workspaceId,
          typeof args.tourId === 'string' ? args.tourId : '',
          who.agentId,
        )
        if (!result.ok) return failure(result.message.startsWith('Only') ? 'forbidden' : 'not_found', result.message)
        return success({ tourId: result.value.id, state: 'closed' })
      },
    },
  ]
}
