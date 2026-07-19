import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ConversationEvent } from '../../../../../shared/conversation-runtime'
import type { ReviewComment } from '../../../../../shared/review'
import { ReviewTray } from './ReviewTray'
import { CommentThread } from './CommentThread'
import { GuideChatThread } from './GuideChatThread'
import { fixtureChangeSet } from './fixtures'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const pending: ReviewComment = {
  id: 'c-pending',
  path: 'prisma/schema.prisma',
  anchor: { side: 'new', startLine: 37, endLine: 37 },
  body: 'Should accept cap at MEMBER and require an in-app grant for admin?',
  createdAt: '2026-07-18T00:00:00.000Z',
  sync: { state: 'pending' },
}
const posted: ReviewComment = {
  id: 'c-posted',
  path: 'src/server/api/invitations.ts',
  anchor: { side: 'new', startLine: 63, endLine: 66 },
  body: 'findUnique is right now that token is unique.',
  createdAt: '2026-07-18T00:01:00.000Z',
  sync: { state: 'posted', url: 'https://x/pull/482#note', postedAt: '2026-07-18T00:02:00.000Z' },
}
const failed: ReviewComment = {
  id: 'c-failed',
  path: 'src/server/api/invitations.ts',
  anchor: { side: 'new', startLine: 65, endLine: 65 },
  body: 'Is 400 right versus 404 here?',
  createdAt: '2026-07-18T00:03:00.000Z',
  sync: { state: 'failed', error: 'network error' },
}

run('the tray renders a row per comment with the right chip and PR post copy', () => {
  const html = renderToStaticMarkup(<ReviewTray comments={[pending, posted, failed]} changeset={fixtureChangeSet} />)
  assert.ok(html.includes('prisma/schema.prisma · L37'))
  assert.ok(html.includes('src/server/api/invitations.ts · L63–66'))
  assert.ok(html.includes('Should accept cap at MEMBER'))
  // Each sync state shows its one word.
  assert.ok(html.includes('Pending'))
  assert.ok(html.includes('Posted'))
  assert.ok(html.includes('Failed'))
  // PR source: post is present and counts only the two postable comments.
  assert.ok(html.includes('Post 2 comments to pull request'))
  // The retired "arrives later" line is gone now that posting is wired.
  assert.ok(!html.includes('Posting arrives with pull-request sync'))
  // design-tokens-allow: "#482" is a pull-request number in an expected string, not a color literal
  assert.ok(html.includes('acme/web-app #482'))
  assert.ok(html.includes('Copy as markdown'))
})

// The `disabled=""` attribute (not the `disabled:` class variant every button
// carries) is what marks an actually-disabled control in the static markup.
run('without a wired onPost the post button is disabled (read-only harness)', () => {
  const html = renderToStaticMarkup(<ReviewTray comments={[pending, failed]} changeset={fixtureChangeSet} />)
  assert.ok(html.includes('Post 2 comments to pull request'))
  assert.ok(html.includes('disabled=""'), 'no post handler → disabled button')
})

run('a wired onPost with pending comments enables the post button', () => {
  const html = renderToStaticMarkup(
    <ReviewTray comments={[pending, failed]} changeset={fixtureChangeSet} onPost={() => {}} postState={{ phase: 'idle' }} />,
  )
  assert.ok(html.includes('Post 2 comments to pull request'))
  assert.ok(!html.includes('disabled=""'), 'PR + pending + handler → enabled')
})

run('the posting state shows Posting… and disables the button', () => {
  const html = renderToStaticMarkup(
    <ReviewTray comments={[pending, failed]} changeset={fixtureChangeSet} onPost={() => {}} postState={{ phase: 'posting' }} />,
  )
  assert.ok(html.includes('Posting…'))
  assert.ok(html.includes('disabled=""'))
})

run('once every comment has posted the button settles to Posted', () => {
  const html = renderToStaticMarkup(
    <ReviewTray comments={[posted]} changeset={fixtureChangeSet} onPost={() => {}} postState={{ phase: 'idle' }} />,
  )
  assert.ok(!html.includes('to pull request'), 'the count button is replaced by the settled state')
  assert.ok(html.includes('disabled=""'), 'the settled Posted button is inert')
})

run('a batch failure surfaces the error copy in the tray', () => {
  const html = renderToStaticMarkup(
    <ReviewTray
      comments={[pending, failed]}
      changeset={fixtureChangeSet}
      onPost={() => {}}
      postState={{ phase: 'error', error: 'GitHub denied the request (403).' }}
    />,
  )
  assert.ok(html.includes('GitHub denied the request (403).'))
})

run('a branch source tray drops the post action and offers copy only', () => {
  const branch = {
    ...fixtureChangeSet,
    source: { kind: 'branch', repoRoot: '/r', baseRef: 'main', headRef: 'agent/x' } as const,
  }
  const html = renderToStaticMarkup(<ReviewTray comments={[pending]} changeset={branch} onPost={() => {}} />)
  assert.ok(!html.includes('Post 1 comment to pull request'))
  assert.ok(html.includes('No pull request to post to'))
  assert.ok(html.includes('Copy as markdown'))
})

run('a pending thread offers edit/delete; a posted thread is read-only', () => {
  const noop = () => {}
  const pendingHtml = renderToStaticMarkup(<CommentThread comment={pending} onEdit={noop} onDelete={noop} />)
  assert.ok(pendingHtml.includes('>You<'))
  assert.ok(pendingHtml.includes('will post to PR'))
  assert.ok(pendingHtml.includes('>Edit<'))
  assert.ok(pendingHtml.includes('>Delete<'))

  const postedHtml = renderToStaticMarkup(<CommentThread comment={posted} onEdit={noop} onDelete={noop} />)
  assert.ok(postedHtml.includes('Posted'))
  assert.ok(!postedHtml.includes('>Edit<'), 'posted comment has no edit control')
  assert.ok(!postedHtml.includes('>Delete<'), 'posted comment has no delete control')
})

// A stubbed guide reply: user turn → streamed assistant answer with citations.
const base = { sessionId: 's1', workspaceId: 'w1', agentId: 'review-guide', providerId: 'claude-agent', modelId: 'sonnet' }
const chatEvents: ConversationEvent[] = [
  { ...base, id: 'e1', type: 'user_message', createdAt: 1, payload: { turnId: 't1', text: 'Why 400 not 404 at invitations.ts:L65?' } },
  { ...base, id: 'e2', type: 'turn_started', createdAt: 2, payload: { turnId: 't1' } },
  {
    ...base,
    id: 'e3',
    type: 'content_delta',
    createdAt: 3,
    payload: {
      turnId: 't1',
      text: 'The other routers here return 404 — see `invitations.ts:L65`. This follows [[auth-tokens]].',
    },
  },
  { ...base, id: 'e4', type: 'turn_completed', createdAt: 4, payload: { turnId: 't1' } },
]

run('the guide chat projects the companion stream into user + guide messages with citations', () => {
  const changedPaths = fixtureChangeSet.files.map((f) => f.path)
  const html = renderToStaticMarkup(
    <GuideChatThread events={chatEvents} localUserTurns={[]} changedPaths={changedPaths} onJumpToLine={() => {}} />,
  )
  // The reused projection yields the user question and the guide's byline + prose.
  assert.ok(html.includes('Why 400 not 404'))
  assert.ok(html.includes('>Guide<'))
  assert.ok(html.includes('The other routers here return 404'))
  // The path:line citation resolves to the real changed file and renders as a jump link.
  assert.ok(html.includes('src/server/api/invitations.ts:L65'))
  assert.ok(html.includes('[[auth-tokens]]'))
})

run('the empty guide chat invites a grounded question, not a dead pane', () => {
  const html = renderToStaticMarkup(
    <GuideChatThread events={[]} localUserTurns={[]} changedPaths={[]} onJumpToLine={() => {}} />,
  )
  assert.ok(html.includes('Ask the guide about any line'))
})

console.log('all review comment surface tests passed')
