// The Review guide's prompt contract for the companion transport.
//
// The guide's WORDING — who it is, the explain-never-judge rule, how to shape a
// walkthrough, what each depth renders, how it answers questions, and the brief
// schema — lives in exactly one place: the `review-guide` builtin skill at
// `resources/skills/review-guide/SKILL.md`. The terminal transport gets that
// text by having the skill attached at spawn; this module gets the same text by
// reading the skill's `<!-- shared:NAME -->` blocks. Neither copy can drift
// because there is only one copy.
//
// What stays here is only what the skill must NOT say: companion-transport
// assembly. The companion is handed the change set inline and replies with a
// JSON object on stdout, where a skill-driven terminal agent calls
// `review_get_changeset` and delivers through `review_submit_brief`. Those few
// transport sentences plus the per-run variables (the change set, the depth, the
// previous brief, the affected step ids, the review directory) are this module's
// whole remaining job. It disappears with the companion path.
//
// Exports:
//   - guideSystemPrompt() — the durable preamble delivered once as the
//     companion session's system prompt: role contract, the companion's job,
//     walkthrough craft, then the brief schema verbatim.
//   - buildGuideRunPrompt / buildGuideRerunPrompt — the per-run turn.
//   - buildGuideChatSystemPrompt — the "Ask the guide" chat preamble.
//   - reviewBriefSchemaDoc() — docs/review-brief-schema.md, verbatim. A drift
//     test (brief-run-service.test.ts) reads the doc off disk and asserts it
//     equals this, so the skill's embedded copy can never silently fall out of
//     sync with the canonical schema.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import type { ReviewBrief, ReviewChangeSet } from '../../shared/review'

// Depth controls how much of the brief the guide fills in. Defined here (the
// leaf module) and imported by brief-run-service.ts.
export type BriefRunDepth = 'brief' | 'standard' | 'thorough'

const SKILL_ID = 'review-guide'

// Where the skill ships. Packaged builds land `resources/skills` at
// `<resourcesPath>/skills` (electron-builder extraResources); dev runs read the
// repo copy. Resolved by existence rather than an `app.isPackaged` import so
// this module stays free of Electron and testable under plain node.
function resolveSkillPath(): string {
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'skills', SKILL_ID, 'SKILL.md')] : []),
    join(process.cwd(), 'resources', 'skills', SKILL_ID, 'SKILL.md'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`The ${SKILL_ID} skill is missing; looked in: ${candidates.join(', ')}`)
  }
  return found
}

let skillBody: string | null = null
const sharedBlocks = new Map<string, string>()

// Read one `<!-- shared:NAME -->` block from the skill, verbatim. A missing
// block is a hard error: a silently empty section would ship a guide prompt with
// its role contract or schema quietly cut out.
function sharedBlock(name: string): string {
  const cached = sharedBlocks.get(name)
  if (cached !== undefined) return cached

  skillBody ??= readFileSync(resolveSkillPath(), 'utf-8')
  const open = `<!-- shared:${name} -->\n`
  const close = `\n<!-- /shared:${name} -->`
  const start = skillBody.indexOf(open)
  const end = start < 0 ? -1 : skillBody.indexOf(close, start + open.length)
  if (start < 0 || end < 0) {
    throw new Error(`The ${SKILL_ID} skill is missing its "${name}" block.`)
  }

  const body = skillBody.slice(start + open.length, end)
  sharedBlocks.set(name, body)
  return body
}

// The companion's job, in place of the skill's tool workflow: it is handed the
// change set inline and answers with the brief itself rather than calling
// review_submit_brief.
const COMPANION_JOB = [
  'Your job: read the ReviewChangeSet in the next message plus the workspace',
  'knowledge graph, then reply with EXACTLY ONE JSON object that is a valid',
  'ReviewBrief per the schema at the end of this message. Reply with only the',
  'JSON object — no prose before or after, no markdown fence required.',
].join('\n')

// Hands off to the schema, which the companion receives inline at the end of the
// preamble rather than as a section of an attached skill.
const COMPANION_SCHEMA_LEAD = [
  'The schema, with every field and validation rule, follows verbatim. Honor it',
  'exactly — an invalid brief is rejected and you are asked to correct it.',
].join('\n')

// docs/review-brief-schema.md, verbatim, by way of the skill that embeds it.
export function reviewBriefSchemaDoc(): string {
  return sharedBlock('schema-doc')
}

// The durable preamble: role rules, the companion's job, walkthrough craft, then
// the schema doc verbatim.
export function guideSystemPrompt(): string {
  return [
    sharedBlock('role-contract'),
    COMPANION_JOB,
    sharedBlock('brief-craft'),
    COMPANION_SCHEMA_LEAD,
    reviewBriefSchemaDoc(),
  ].join('\n\n')
}

// The "Ask the guide" chat preamble. Same narrator persona and grounding rules
// as the skill's chat mode; what differs is where the change under review lives.
// A cold companion (a fresh thread started after the brief-run session is gone)
// has no review tools, so it is seeded with the on-disk paths instead.
export function buildGuideChatSystemPrompt(reviewDirRelative: string): string {
  const onDiskArtifacts = [
    'The change under review and your own walkthrough of it live on disk in this',
    `workspace at ${reviewDirRelative}/changeset.json (the normalized diff) and`,
    `${reviewDirRelative}/brief.json (your walkthrough — steps, per-file why,`,
    'annotations). Read them when you need to ground an answer, plus the',
    'workspace knowledge graph under knowledge/.',
  ].join('\n')

  return [
    sharedBlock('chat-persona'),
    onDiskArtifacts,
    sharedBlock('chat-grounding'),
  ].join('\n\n')
}

// What each depth asks the guide to render. Higher depths are supersets.
function depthGuidance(depth: BriefRunDepth): string {
  return sharedBlock(`depth-${depth}`)
}

// The per-run turn: the concrete changeset plus the depth ask. The system prompt
// (role rules + schema) rides the first turn as the companion preamble.
export function buildGuideRunPrompt(changeset: ReviewChangeSet, depth: BriefRunDepth): string {
  return [
    depthGuidance(depth),
    '',
    'The ReviewChangeSet to walk through (emit a ReviewBrief whose changeSetId',
    'equals this changeset id, covering every non-binary file):',
    '',
    JSON.stringify(sanitizeChangeSet(changeset), null, 2),
    '',
    'Reply with ONLY the ReviewBrief JSON object.',
  ].join('\n')
}

// The re-run turn (MC-1682): the head moved, so the change set was re-ingested and
// most of the previous walkthrough still holds. Give the guide the new change set
// PLUS its previous brief and the ids of the steps whose files actually changed,
// and instruct it to preserve the unaffected steps verbatim (same ids) and only
// regenerate the affected ones. This keeps step ids stable across a re-run so the
// reviewer's place, read progress, and pending comments survive.
export function buildGuideRerunPrompt(
  changeset: ReviewChangeSet,
  depth: BriefRunDepth,
  previousBrief: ReviewBrief,
  affectedStepIds: string[],
): string {
  const affected = affectedStepIds.length > 0 ? affectedStepIds.join(', ') : '(none)'
  return [
    depthGuidance(depth),
    '',
    'This is a REFRESH of an existing walkthrough — the reviewed head moved and the',
    'change set was re-ingested. You are given your previous ReviewBrief and the ids',
    'of the steps whose files actually changed. Rules for the refresh:',
    `  - Steps whose files did NOT change (every step except: ${affected}) must be`,
    '    carried over VERBATIM — keep their id, order, title, narrative, files, and',
    '    annotations exactly. Do not renumber or rename them.',
    '  - Regenerate ONLY the affected steps against the new change set: refresh their',
    "    files' why lines and annotations, but keep each affected step's id stable so",
    "    the reviewer's place and comments survive.",
    '  - Re-derive coverage against the new change set, and update brief.changeSetId',
    '    and brief.headSha to the new change set. Every non-binary changed file must',
    '    still land in exactly one step or coverage.unassignedPaths.',
    '',
    'Your previous ReviewBrief:',
    '',
    JSON.stringify(previousBrief, null, 2),
    '',
    'The new ReviewChangeSet to walk through:',
    '',
    JSON.stringify(sanitizeChangeSet(changeset), null, 2),
    '',
    'Reply with ONLY the updated ReviewBrief JSON object.',
  ].join('\n')
}

// A branch source carries an absolute repoRoot; the guide never needs it and
// echoing it invites a machine-specific path into the brief (which the run
// service rejects). Redact it so the prompt only ever shows project-relative
// file paths.
function sanitizeChangeSet(changeset: ReviewChangeSet): ReviewChangeSet {
  if (changeset.source.kind !== 'branch') return changeset
  return { ...changeset, source: { ...changeset.source, repoRoot: '[workspace root]' } }
}
