// Deterministic review fixtures — a stored changeset + brief + workspace-state
// triple that renders the whole walkthrough surface with zero IPC. This is the
// schema regression net (T7 acceptance): the fixture harness route mounts the
// pure surface against these objects, and the pure-model tests assert against
// them. Content mirrors mockup §2 (the teammate-invitations change) so the
// rendered surface can be eyeballed against the accepted direction.

import type {
  ChangeMap,
  ReviewBrief,
  ReviewChangeSet,
  ReviewWorkspaceState,
} from '../../../../../shared/review'

const CHANGE_SET_ID = 'fixture-invitations-482'

export const fixtureChangeSet: ReviewChangeSet = {
  schemaVersion: 1,
  id: CHANGE_SET_ID,
  source: {
    kind: 'pull-request',
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'web-app',
    number: 482,
    url: 'https://github.com/acme/web-app/pull/482',
  },
  title: 'Add teammate invitations with roles',
  description: 'Org admins invite teammates by email with a role; single-use links expire in 7 days.',
  baseRef: 'main',
  baseSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  headRef: 'agent/teammate-invites',
  headSha: '4f2c19a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2',
  files: [
    {
      path: 'prisma/schema.prisma',
      status: 'modified',
      binary: false,
      additions: 10,
      deletions: 0,
      hunks: [
        {
          oldStart: 30,
          oldLines: 3,
          newStart: 30,
          newLines: 13,
          lines: [
            { kind: 'context', text: '  slug      String   @unique' },
            { kind: 'context', text: '  createdAt DateTime @default(now())' },
            { kind: 'context', text: '}' },
            { kind: 'add', text: '' },
            { kind: 'add', text: 'model Invitation {' },
            { kind: 'add', text: '  id        String   @id @default(cuid())' },
            { kind: 'add', text: '  email     String' },
            { kind: 'add', text: '  role      MemberRole @default(MEMBER)' },
            { kind: 'add', text: '  token     String   @unique' },
            { kind: 'add', text: '  status    InvitationStatus @default(PENDING)' },
            { kind: 'add', text: '  orgId     String' },
            { kind: 'add', text: '  expiresAt DateTime' },
            { kind: 'add', text: '  @@index([orgId, status])' },
          ],
        },
      ],
    },
    {
      path: 'prisma/migrations/20260716_add_invitations/migration.sql',
      status: 'added',
      binary: false,
      additions: 3,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: 'add', text: 'CREATE TABLE "Invitation" (' },
            { kind: 'add', text: '  "id" TEXT NOT NULL PRIMARY KEY,' },
            { kind: 'add', text: '  "token" TEXT NOT NULL' },
          ],
        },
      ],
    },
    {
      path: 'src/server/api/invitations.ts',
      status: 'modified',
      binary: false,
      additions: 4,
      deletions: 1,
      hunks: [
        {
          oldStart: 62,
          oldLines: 2,
          newStart: 62,
          newLines: 5,
          lines: [
            { kind: 'context', text: 'export async function acceptInvitation(token) {' },
            { kind: 'del', text: '  const invite = await db.invitation.findFirst({ where: { token } })' },
            { kind: 'add', text: '  const invite = await db.invitation.findUnique({ where: { token } })' },
            { kind: 'add', text: '  if (!invite || invite.expiresAt < new Date()) {' },
            { kind: 'add', text: "    throw new ApiError(400, 'invitation not valid')" },
            { kind: 'add', text: '  }' },
          ],
        },
      ],
    },
    {
      path: 'src/server/api/invitations.test.ts',
      status: 'added',
      binary: false,
      additions: 2,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'add', text: "describe('acceptInvitation', () => {" },
            { kind: 'add', text: "  it('rejects an expired token', async () => {})" },
          ],
        },
      ],
    },
  ],
  stats: { files: 4, additions: 19, deletions: 1 },
  fetchedAt: '2026-07-17T12:00:00.000Z',
}

export const fixtureBrief: ReviewBrief = {
  schemaVersion: 1,
  changeSetId: CHANGE_SET_ID,
  headSha: '4f2c19a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2',
  generatedAt: '2026-07-17T12:02:00.000Z',
  overview: {
    intent:
      'Org admins can invite teammates by email with a role; invites are single-use links that expire in 7 days.',
    blastRadius:
      'New table and two enums; three new API routes; the members settings page is rewritten. The migration must deploy before the UI.',
    readingGuide:
      'Four steps, foundation upward: data model, then API, then UI, then tests. One deviation to look at in the API step — email sending is inline in the request rather than the outbox worker.',
    complexity: 'high',
  },
  steps: [
    {
      id: 'step-model',
      order: 0,
      title: 'The invitation data model',
      narrative:
        'The agent introduced an Invitation record, a MemberRole enum, and the migration that creates the table. Everything else builds on these types — the API step queries them, the UI step renders them.',
      files: [
        { path: 'prisma/schema.prisma', why: 'new Invitation + role types — the foundation of the feature' },
        {
          path: 'prisma/migrations/20260716_add_invitations/migration.sql',
          why: 'creates the table the schema above declares',
          readingNote: 'mechanical-skim',
        },
      ],
      annotations: [
        {
          id: 'anno-model-invitation',
          path: 'prisma/schema.prisma',
          anchor: { side: 'new', startLine: 34, endLine: 42 },
          kind: 'explain',
          title: 'New Invitation model',
          summary: 'Email, role, single-use token, status and expiry, linked to the inviting org.',
          detail:
            'The token column is unique and random (cuid) so an invite link cannot be guessed; the compound index matches the API step’s “pending invites per org” query. Expiry is stored, not computed.',
          hoverTip:
            'Random cuid, unique at the DB level — the invite link cannot be guessed or reused.',
          knowledgeRefs: ['auth-tokens'],
        },
      ],
    },
    {
      id: 'step-api',
      order: 1,
      title: 'Invitation API + email delivery',
      narrative:
        'Three endpoints — create, accept, revoke — plus the invite email. Read the accept path closely; it holds the trust decisions.',
      files: [
        {
          path: 'src/server/api/invitations.ts',
          why: 'the new endpoints — token lookup, expiry gate, seat re-check, email send',
        },
      ],
      annotations: [
        {
          id: 'anno-api-accept',
          path: 'src/server/api/invitations.ts',
          anchor: { side: 'new', startLine: 63, endLine: 66 },
          kind: 'explain',
          title: 'Token lookup and expiry gate',
          summary: 'Single indexed query, then a hard expiry check.',
          detail:
            'Everything below this gate can trust the invite exists and is current. Note the error code deviates from this router’s own 404 convention.',
          hoverTip:
            'findUnique replaces findFirst — the token column gained @unique in step 1, so this is now an index lookup.',
        },
      ],
    },
    {
      id: 'step-tests',
      order: 2,
      title: 'Tests & fixtures',
      narrative: 'API tests for the accept endpoint; no UI tests — the coverage note says so honestly.',
      files: [
        { path: 'src/server/api/invitations.test.ts', why: 'covers the expired-token rejection path' },
      ],
      annotations: [],
    },
  ],
  changeMap: {
    nodes: [
      { id: 'model', label: 'Invitation model', sublabel: 'prisma/schema.prisma', stepId: 'step-model', kind: 'data' },
      { id: 'migration', label: 'Migration', sublabel: 'CREATE TABLE Invitation', stepId: 'step-model', kind: 'data' },
      { id: 'api', label: 'Invitations API', sublabel: 'create · accept · revoke', stepId: 'step-api', kind: 'api' },
      { id: 'email', label: 'Invite email', sublabel: 'inline send — see step 2', stepId: 'step-api', kind: 'job' },
      { id: 'tests', label: 'API tests', sublabel: 'expired-token path', stepId: 'step-tests', kind: 'test' },
    ],
    edges: [
      { from: 'migration', to: 'model', label: 'creates' },
      { from: 'model', to: 'api', label: 'queried by' },
      { from: 'api', to: 'email', label: 'sends' },
      { from: 'tests', to: 'api', label: 'covers' },
    ],
    deployNote: 'the migration must deploy before the API can query the new table.',
  },
  knowledgeRefs: [
    { note: 'auth-tokens', reason: 'the single-use-token shape follows the session-token convention' },
    { note: 'billing-seats', reason: 'the seat-limit re-check inside the transaction' },
  ],
  coverage: {
    assignedPaths: [
      'prisma/schema.prisma',
      'prisma/migrations/20260716_add_invitations/migration.sql',
      'src/server/api/invitations.ts',
      'src/server/api/invitations.test.ts',
    ],
    unassignedPaths: [],
  },
}

export const fixtureState: ReviewWorkspaceState = {
  schemaVersion: 1,
  changeSetId: CHANGE_SET_ID,
  readFiles: ['prisma/schema.prisma'],
  activeStepId: 'step-model',
  diffView: 'side-by-side',
  comments: [],
}

export interface ReviewFixture {
  changeset: ReviewChangeSet
  brief: ReviewBrief
  state: ReviewWorkspaceState
}

export const reviewFixture: ReviewFixture = {
  changeset: fixtureChangeSet,
  brief: fixtureBrief,
  state: fixtureState,
}

// The mockup's §2 change map, verbatim: six entities across four steps, five
// labeled relationships, a deploy caption. Used by the layout and ChangeMapView
// tests to prove the map renders visually equivalent to the accepted direction.
// Standalone (its stepIds are the mockup's, not the fixture brief's), so it
// exercises the layout/view directly without a whole brief.
export const mockupChangeMapStepIds = ['s-model', 's-api', 's-ui', 's-tests']

export const mockupChangeMap: ChangeMap = {
  nodes: [
    { id: 'model', label: 'Invitation model', sublabel: 'prisma/schema.prisma', stepId: 's-model', kind: 'data' },
    { id: 'migration', label: 'Migration', sublabel: 'CREATE TABLE Invitation', stepId: 's-model', kind: 'data' },
    { id: 'api', label: 'Invitations API', sublabel: 'create · accept · revoke', stepId: 's-api', kind: 'api' },
    { id: 'email', label: 'Invite email', sublabel: 'inline send — see step 2', stepId: 's-api', kind: 'job' },
    { id: 'ui', label: 'Members UI', sublabel: 'settings/members page', stepId: 's-ui', kind: 'ui' },
    { id: 'tests', label: 'API tests', sublabel: 'all three endpoints', stepId: 's-tests', kind: 'test' },
  ],
  edges: [
    { from: 'migration', to: 'model', label: 'creates' },
    { from: 'model', to: 'api', label: 'queried by' },
    { from: 'api', to: 'email', label: 'sends' },
    { from: 'api', to: 'ui', label: 'feeds' },
    { from: 'tests', to: 'api', label: 'covers' },
  ],
  deployNote: 'migration before UI — the members page needs the role column.',
}
